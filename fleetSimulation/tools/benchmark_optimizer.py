"""Reproducible native Godot runs, using only the isolated recovered project.

No game installation/save access. Process CPU includes child workers on Windows.
"""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / 'work/full_recovered'
GODOT = Path('E:/tools/Godot_v4.7.2-stable_win64/Godot_v4.7.2-stable_win64.exe')


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--label', required=True)
    p.add_argument('--config')
    p.add_argument('--case')
    p.add_argument('--settings')
    p.add_argument('--common')
    p.add_argument('--seconds', type=float, default=300)
    p.add_argument('--workers', type=int, default=1)
    p.add_argument('--simulations', type=int, default=1000000)
    p.add_argument('--profile', default='fast')
    p.add_argument('--launcher', action='store_true', help='Exercise the daily PowerShell launcher in the isolated benchmark')
    p.add_argument('--source', default=str(ROOT / 'poc'))
    p.add_argument('--extra', nargs=argparse.REMAINDER, default=[])
    args = p.parse_args()
    out = ROOT / 'results/optimizer_v3' / args.label
    out.mkdir(parents=True, exist_ok=False)
    source = Path(args.source)
    for f in source.iterdir():
        if f.suffix in ('.gd', '.tscn', '.json'):
            shutil.copy2(f, PROJECT / f.name)
    if args.settings:
        shutil.copy2(args.settings, PROJECT / 'optimizer_v2_daily.json')
    hashes = {f.name: hashlib.sha256(f.read_bytes()).hexdigest()
              for f in source.glob('*.gd')}
    cmd = [str(GODOT), '--headless', '--disable-render-loop']
    if '--realtime' not in args.extra:
        cmd += ['--fixed-fps', '60']
    clock = 'realtime' if '--realtime' in args.extra else 'offline_fixed_step'
    galaxy = 'galaxy5'
    if args.config or args.case:
        fixture = read(ROOT / 'poc/optimizer_benchmark_cases.json')[args.case] if args.case else None
        config = fixture['friendly'] if fixture else read(args.config)
        config['search'] = dict(config.get('search', {}), profile=args.profile, goal='best', simulation_clock=clock,
                                max_wall_seconds=args.seconds, max_simulations=args.simulations,
                                workers=args.workers)
        config.pop('diagnostic', None)
        galaxy = 'galaxy' + str(config['galaxy'])
        (PROJECT / 'config.json').write_text(json.dumps(config, indent=2), encoding='utf-8')
        (out / 'input.json').write_text(json.dumps(config, indent=2), encoding='utf-8')
        common = read(args.common) if args.common else (fixture['common'] if fixture else {})
        (PROJECT / 'common.json').write_text(json.dumps(common), encoding='utf-8')
        (out / 'common.json').write_text(json.dumps(common), encoding='utf-8')
    cmd += ['--path', str(PROJECT), 'res://fleet_optimizer_bootstrap.tscn', '--',
            '--optimizer-galaxy=' + galaxy, '--simulation-clock=' + clock,
            '--fixed-fps-active=' + ('0' if clock == 'realtime' else '60'),
            '--worker-id=bench_' + args.label]
    if args.config or args.case:
        cmd += ['--daily-optimizer', '--daily-output-dir=' + str(out),
                '--node-result=' + str(out / 'node.result.json')]
    cmd += [x for x in args.extra if x != '--realtime']
    if args.launcher:
        if not (args.config or args.case) or args.extra:
            p.error('--launcher requires --config/--case and cannot be combined with --extra')
        cmd = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
               str(ROOT / 'tools/run_godot_optimizer.ps1'), '-GodotExe', str(GODOT),
               '-ProjectPath', str(PROJECT), '-GalaxyId', galaxy, '-SimulationClock', clock,
               '-FixedFpsActive', '60' if clock == 'offline_fixed_step' else '0',
               '-OutputDir', str(out), '-NodeResult', str(out / 'node.result.json'),
               '-LogPath', str(out / 'native.godot.log'), '-MaxWallSeconds', str(args.seconds),
               '-WorkerId', 'bench_' + args.label]
    start = time.perf_counter()
    with (out / 'stdout.log').open('w', encoding='utf-8') as stdout, (out / 'stderr.log').open('w', encoding='utf-8') as stderr:
        proc = subprocess.Popen(cmd, stdout=stdout, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW)
        # Query CPU from the process handle even after it exits. Children are measured
        # separately by the optimizer when available, never inferred from wall time.
        sampled_updates = []
        seen_updates = 0
        userdir = Path(os.environ['APPDATA']) / ('Unnamed Space Idle Fleet Worker bench_' + args.label)
        child_handles = {}
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        while proc.poll() is None:
            for ready in userdir.glob('optimizer_workers_*/worker_*/ready.json'):
                try:
                    pid = read(ready)['pid']
                    if pid not in child_handles:
                        handle = kernel.OpenProcess(0x1000, False, pid)
                        if handle:
                            child_handles[pid] = handle
                except (ValueError, OSError, KeyError):
                    pass
            log = (out / 'stdout.log').read_text(encoding='utf-8', errors='replace')
            updates = log.count('Best updated:')
            if updates > seen_updates:
                sampled_updates.append({'process_seconds': time.perf_counter() - start, 'update': updates})
                seen_updates = updates
            if time.perf_counter() - start > args.seconds + 180:
                proc.terminate()
            if 'SCRIPT ERROR:' in (out / 'stderr.log').read_text(encoding='utf-8', errors='replace'):
                proc.terminate()
            time.sleep(0.25)
        child_cpu = 0.0
        for handle in child_handles.values():
            child_times = [ctypes.c_ulonglong() for _ in range(4)]
            if kernel.GetProcessTimes(ctypes.c_void_p(handle), *[ctypes.byref(t) for t in child_times]):
                child_cpu += (child_times[2].value + child_times[3].value) / 1e7
            kernel.CloseHandle(ctypes.c_void_p(handle))
        times = [ctypes.c_ulonglong() for _ in range(4)]
        ok = ctypes.windll.kernel32.GetProcessTimes(ctypes.c_void_p(int(proc._handle)),
                *[ctypes.byref(t) for t in times])
        cpu = (times[2].value + times[3].value) / 1e7 if ok else None
    wall = time.perf_counter() - start
    meta = dict(exit_code=proc.returncode, process_wall_seconds=wall,
                parent_cpu_seconds=cpu, child_cpu_seconds=child_cpu,
                total_cpu_percent_one_core=100 * (cpu + child_cpu) / wall if cpu is not None else None,
                sampled_search_updates=sampled_updates, logical_processors=os.cpu_count(),
                parent_cpu_percent_one_core=100 * cpu / wall if cpu is not None else None,
                source_sha256=hashes, command=cmd,
                native_sha256={str(f.relative_to(PROJECT)): hashlib.sha256(f.read_bytes()).hexdigest()
                    for folder in [PROJECT / "fleet", PROJECT / "projectiles"] for f in folder.rglob("*.gd")})
    userdir = Path(os.environ['APPDATA']) / ('Unnamed Space Idle Fleet Worker bench_' + args.label)
    for f in userdir.glob('*.json'):
        shutil.copy2(f, out / f.name)
    (out / 'process.json').write_text(json.dumps(meta, indent=2), encoding='utf-8')
    print(json.dumps(meta))
    raise SystemExit(proc.returncode)


if __name__ == '__main__':
    main()
