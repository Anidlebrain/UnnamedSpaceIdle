"""Run the existing isolated benchmark and restore all staged project inputs."""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / 'work/full_recovered'


def main():
    args = sys.argv[1:]
    source = Path(args[args.index('--source') + 1]) if '--source' in args else ROOT / 'poc'
    names = {f.name for f in source.iterdir() if f.suffix in ('.gd', '.tscn', '.json')}
    names.update(['config.json', 'common.json'])
    originals = {name: (PROJECT / name).read_bytes() if (PROJECT / name).exists() else None for name in names}
    # Persist recovery material even if the calling terminal is interrupted.
    label = args[args.index('--label') + 1]
    backup = ROOT / 'results/optimizer_v3' / (label + '_inputs_backup')
    backup.mkdir(parents=True, exist_ok=False)
    for name, content in originals.items():
        if content is not None:
            (backup / name).write_bytes(content)
    (backup / 'manifest.json').write_text(json.dumps({name: content is not None for name, content in originals.items()}))
    try:
        return subprocess.call([sys.executable, str(ROOT / 'tools/benchmark_optimizer.py'), *args])
    finally:
        for name, content in originals.items():
            path = PROJECT / name
            if content is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(content)


if __name__ == '__main__':
    raise SystemExit(main())
