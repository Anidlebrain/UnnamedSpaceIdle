"""Isolated native experiments. Never modifies the recovered source project."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
from copy import deepcopy

from .catalog import Catalog, read_json, require
from .candidate import check_candidate
from .normalize import normalize

ROOT = Path(__file__).resolve().parents[1]


def patch_random_sources(project):
    patches = []
    pattern = re.compile(r'(?m)^([ \t]*)(\w+)\.randomize\(\)[ \t]*$')
    for folder in ('battle', 'enemies', 'player', 'projectiles'):
        for path in sorted((project / folder).rglob('*.gd')):
            original = path.read_text(encoding='utf-8')
            relative = path.relative_to(project).as_posix()
            sites = []
            def replace(match):
                site = f'{relative}:{len(sites)}'
                sites.append(site)
                return f'{match[1]}TitanGuard.seed_rng({match[2]}, {json.dumps(site)})'
            modified = pattern.sub(replace, original)
            if relative == 'battle/Turret.gd':
                require(original.count('Engine.get_process_frames()') == 1, 'Turret frame throttle changed')
                modified = modified.replace('Engine.get_process_frames()', 'TitanGuard.process_frame()')
            if modified != original:
                path.write_text(modified, encoding='utf-8')
                patches.append({'file': relative, 'rng_sites': sites,
                                'reason': 'optional per-case RNG and frame origin',
                                'before_sha256': hashlib.sha256(original.encode()).hexdigest(),
                                'after_sha256': hashlib.sha256(modified.encode()).hexdigest()})
    return patches


def synthetic_batch(catalog, seed=12345):
    require(type(seed) is int and 0 <= seed <= 2147483647, 'Seed must be an integer in [0, 2147483647]')
    a = synthetic_input(catalog, 'boss_once', 'strong')
    b = synthetic_input(catalog, 'farm_distance')
    b['candidate']['weapons'] = b['candidate']['weapons'][2:] + b['candidate']['weapons'][:2]
    b['candidate']['sequence'] = [
        {'id': 'laser_shot', 'targets': ['1:1']},
        {'id': 'basic_shield_bolster', 'targets': []},
        {'id': 'basic_rapid_fire', 'targets': []}]
    b['simulation_seconds'] = 20
    check_candidate(catalog, catalog.region(164, 'antumbra'), b['candidate'])
    cases = [a, b, deepcopy(a)]
    for case in cases:
        case['seed'] = seed
    return {'cases': cases, 'audit': 'A_B_A', 'synthetic': True}


def synthetic_input(catalog, mode, strength="standard"):
    """Deliberately synthetic regression encounter; never inferred player data."""
    require(mode in ("boss_once", "farm_distance"), "Unknown smoke mode")
    require(strength in ("standard", "strong"), "Unknown synthetic strength")
    damage_factor = 100 if strength == "strong" else 1
    snapshot = read_json(ROOT / "examples/stats_snapshot.json")
    if catalog.enemy_alignment:
        snapshot['game_version'] = catalog.version
    snapshot["summary_stats"]["titan_damage"] *= 1e17 * damage_factor
    snapshot["summary_stats"]["titan_max_shields"] *= 1e19
    snapshot["summary_stats"]["array_capacity"] = 23
    snapshot["reference_array_base_damage"] *= 1e17 * damage_factor
    candidate = read_json(ROOT / "examples/candidate.json")
    region = catalog.region(164, "antumbra")
    check_candidate(catalog, region, candidate)
    profile = normalize(catalog, snapshot)
    return {"synthetic": True, "synthetic_strength": strength, "candidate": candidate, "profile": profile,
            "expected_array_damage": snapshot["reference_array_base_damage"] * profile["layer_multipliers"]["antumbra"]["combat"],
            "layer": "antumbra", "layer_id": 1, "sector": 164,
            "sector_id": region["sector_id"],
            "distance": 130000 if mode == "boss_once" else 128001,
            "reintegration": True, "umbra_sector_number": 160,
            "galaxy12_unlocked": False,
            "prior_reinforcements": ["R1Basic", "R2Basic", "R3Basic"],
            "mode": mode, "simulation_seconds": 45}


def setting(config, key, value):
    pattern = r"(?m)^" + re.escape(key) + r"=.*$"
    require(len(re.findall(pattern, config)) == 1, f"Expected one project setting: {key}")
    return re.sub(pattern, lambda _: key + "=" + value, config)


def application_setting(config, key, value):
    """Recovered exports omit default settings; insert isolation settings if absent."""
    if re.search(r'(?m)^' + re.escape(key) + '=', config):
        return setting(config, key, value)
    require(config.count('[application]') == 1, 'Missing application settings section')
    return config.replace('[application]', '[application]\n' + key + '=' + value, 1)


def unexpected_errors(stderr):
    # Known renderer/shutdown diagnostics are retained in stderr.log, not hidden.
    known = ('ERROR: Condition "!actions.custom_samplers.has(function->arguments[j].tex_builtin)" is true. Continuing.',)
    return [line for line in stderr.splitlines() if line.startswith("ERROR:")
            and line not in known and not re.fullmatch(r"ERROR: \d+ resources still in use at exit .*", line)]


def successful_result(exit_code, timed_out, script_errors, errors, probe):
    return (exit_code == 0 and not timed_out and not script_errors and not errors
            and isinstance(probe, dict) and probe.get("native_game_loaded") is True
            and ("battle" not in probe or probe["battle"].get("status") == "NATIVE_SMOKE_ONLY")
            and ("battles" not in probe or (len(probe['battles']) == probe.get('expected_cases', -1) > 0 and
                 all(b.get('status') == 'NATIVE_SMOKE_ONLY' for b in probe['battles']))))


def compare_cases(first, last):
    ignored = {'setup_ms', 'battle_wall_seconds'}
    keys = (set(first) | set(last)) - ignored
    different = sorted(k for k in keys if first.get(k) != last.get(k))
    return {'equal': not different, 'different_fields': different,
            'scope': 'exact recorded combat fields, excluding setup and wall time'}


def stage(source, label, deadline=None):
    require(re.fullmatch(r"[A-Za-z0-9_-]+", label), "Use a simple unique label")
    catalog = Catalog(source)
    run = ROOT / "work" / label
    require(not run.exists(), f"Run already exists: {run}")
    run.mkdir(parents=True)
    project = run / "project"
    user_dir = (run / "appdata" / "TitanResearch").resolve()
    user_dir.mkdir(parents=True)
    if catalog.enemy_alignment:
        # 0.90's first-run config migration reads this legacy UI key before
        # creating its default. Supply only the isolated desktop default.
        for filename in ('config.cfg', 'betaconfig.cfg'):
            (user_dir / filename).write_text('[Crew]\nconfirm_rank_allocation=false\n', encoding='utf-8')
    # Separate file copies, never hard links/junctions into the source.
    class CopyBudgetExpired(Exception):
        pass

    def copy_file(src, dst):
        if deadline is not None and time.perf_counter() >= deadline:
            # copytree aggregates OSError subclasses (including TimeoutError) and
            # keeps copying. Use a private exception to abort immediately.
            raise CopyBudgetExpired()
        return shutil.copy2(src, dst)
    try:
        shutil.copytree(catalog.source, project, copy_function=copy_file, ignore=shutil.ignore_patterns(
            ".autoconverted", ".git", "*.log", "*.save", "*.save.*", "*.json", "editor"))
    except CopyBudgetExpired:
        raise TimeoutError('Budget exhausted during isolated project preparation') from None
    config = (project / "project.godot").read_text(encoding="utf-8")
    config = setting(config, "config/name", '"Titan Research"')
    config = setting(config, "run/main_scene", '"res://titan_probe.tscn"')
    config = application_setting(config, "config/custom_user_dir_name", '"TitanResearch"')
    config = application_setting(config, "config/use_custom_user_dir", 'true')
    config = setting(config, "platform/force_disable_steam", "true")
    config = setting(config, "platform/prevent_startup_window_config", "true")
    config = setting(config, "features/initial_load_dev_save", '""')
    # Headless rendering otherwise sleeps 100 ms even with the FPS cap at 60.
    config = setting(config, "run/low_processor_mode_sleep_usec", "1000")
    config = re.sub(r'(?m)^FleetTestRunner=.*\n', '', config)
    config = config.replace("[autoload]\n", '[autoload]\n\nTitanGuard="*res://titan_guard.gd"\n', 1)
    config += '\n[titan_research]\n\nuser_dir=' + json.dumps(user_dir.as_posix()) + '\n'
    (project / "project.godot").write_text(config, encoding="utf-8")
    patches = patch_random_sources(project)
    # Prevent all save loading, including any startup UI path. Empty synthetic game only.
    save_path = project / "SaveLoad.gd"
    text = save_path.read_text(encoding="utf-8")
    for signature, body in (("func read_file_and_prep_load(path = file_to_load) -> bool:", "\treturn false\n"),
                            ("func load_game():", "\tloading = false\n\treturn false\n")):
        start = text.find(signature)
        require(start >= 0, "Save isolation signature changed: " + signature)
        end = text.find("\nfunc ", start + len(signature))
        require(end >= 0, "Save isolation function boundary missing")
        text = text[:start] + signature + "\n" + body + text[end:]
        patches.append({"file": "SaveLoad.gd", "function": signature, "reason": "disable save loading"})
    save_path.write_text(text, encoding="utf-8")
    for path in (ROOT / "native").iterdir():
        if path.suffix in (".gd", ".tscn"):
            shutil.copy2(path, project / path.name)
    manifest = {"source": str(catalog.source), "source_sha256": catalog.hashes,
                "native_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                  for p in (ROOT / 'native').iterdir() if p.suffix in ('.gd', '.tscn')},
                "project_settings_sha256": hashlib.sha256((project / 'project.godot').read_bytes()).hexdigest(),
                "project": str(project), "user_dir": str(user_dir), "patches": patches}
    (run / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return run, project, user_dir


def execute(godot, run, project, timeout, clock="realtime"):
    require(clock in ('realtime', 'fixed'), 'Unknown native clock')
    command = [str(Path(godot).resolve()), "--headless", "--path", str(project)]
    if clock == 'fixed':
        command += ['--fixed-fps', '60']
    started = time.perf_counter()
    timed_out = False
    script_error_abort = False
    with (run / "stdout.log").open("w", encoding="utf-8") as out, (run / "stderr.log").open("w", encoding="utf-8") as err:
        env = dict(os.environ, APPDATA=str(run / "appdata"))
        process = subprocess.Popen(command, stdout=out, stderr=err, env=env,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            while process.poll() is None:
                diagnostics = (run / "stderr.log").read_text(encoding="utf-8", errors="replace")
                if "SCRIPT ERROR:" in diagnostics:
                    script_error_abort = True
                    break
                if time.perf_counter() - started > timeout:
                    timed_out = True
                    break
                time.sleep(0.1)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
    stderr = (run / "stderr.log").read_text(encoding="utf-8", errors="replace")
    stdout = (run / "stdout.log").read_text(encoding="utf-8", errors="replace")
    completed = "TITAN_PROBE_COMPLETE:" in stdout
    probe_path = run / "appdata" / "TitanResearch" / "probe.json"
    probe = read_json(probe_path) if completed and probe_path.is_file() else None
    result = {"exit_code": process.returncode, "timed_out": timed_out,
              "clock": clock,
              "script_error_abort": script_error_abort, "protocol_completed": completed,
              "wall_seconds": time.perf_counter() - started,
              "script_errors": stderr.count("SCRIPT ERROR:"), "command": command,
              "godot_sha256": hashlib.sha256(Path(godot).read_bytes()).hexdigest(),
              "project_settings_sha256": hashlib.sha256((project / 'project.godot').read_bytes()).hexdigest(),
              "unexpected_engine_errors": unexpected_errors(stderr),
              "native_sha256": {p.name: hashlib.sha256((project / p.name).read_bytes()).hexdigest()
                                for p in (ROOT / "native").iterdir() if p.suffix in (".gd", ".tscn")}}
    fixture_path = project / "native_input.json"
    if fixture_path.is_file():
        result["fixture_sha256"] = hashlib.sha256(fixture_path.read_bytes()).hexdigest()
    result["success"] = successful_result(process.returncode, timed_out, result["script_errors"],
                                           result["unexpected_engine_errors"], probe)
    if probe and len(probe.get('battles', [])) >= 2:
        result['repeat_comparison'] = compare_cases(probe['battles'][0], probe['battles'][-1])
        if clock == 'fixed' and fixture_path.is_file() and read_json(fixture_path).get('audit') == 'A_B_A':
            result['success'] = result['success'] and result['repeat_comparison']['equal']
    (run / "process.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description="Isolated native initialization or synthetic battle experiment")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--godot", required=True, type=Path)
    parser.add_argument("--label", required=True)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--synthetic-battle", choices=("boss_once", "farm_distance"),
                        help="Run a synthetic sector 164 encounter; not a player search")
    parser.add_argument("--synthetic-strength", choices=("standard", "strong"), default="standard",
                        help="Strong multiplies synthetic damage by 100 for the positive kill smoke")
    parser.add_argument('--batch-audit', action='store_true', help='Synthetic A/B/A reset experiment')
    parser.add_argument('--seed', type=int)
    parser.add_argument('--clock', choices=('realtime', 'fixed'), default='realtime', help='Fixed clock is experimental, not accuracy validated')
    args = parser.parse_args(argv)
    require(args.godot.is_file(), "Godot executable not found")
    require(0 < args.timeout <= 600, "Timeout must be in (0, 600]")
    require(not (args.batch_audit and args.synthetic_battle), 'Choose single battle or batch audit')
    if args.seed is not None:
        require(0 <= args.seed <= 2147483647, 'Seed must be in [0, 2147483647]')
    run, project, _ = stage(args.source, args.label)
    if args.synthetic_battle or args.batch_audit:
        catalog = Catalog(args.source)
        fixture = synthetic_batch(catalog, args.seed if args.seed is not None else 12345) if args.batch_audit else synthetic_input(catalog, args.synthetic_battle, args.synthetic_strength)
        if args.seed is not None and not args.batch_audit:
            fixture['seed'] = args.seed
        (project / "native_input.json").write_text(json.dumps(fixture), encoding="utf-8")
    print("ISOLATED_NATIVE_RUN: " + str(run), flush=True)
    result = execute(args.godot, run, project, args.timeout, args.clock)
    print(json.dumps(result), flush=True)
    return 0 if result["success"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
