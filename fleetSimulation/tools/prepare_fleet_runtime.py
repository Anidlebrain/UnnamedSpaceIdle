"""Prepare a NEW isolated Fleet runtime from an existing recovered 0.90.0.1 project.

Never extracts packs, edits the source, or replaces an existing runtime.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]
GAME_VERSION = '0.90.0.1'


def replace_function(text, signature, body):
    start = text.index(signature)
    end = text.index('\nfunc ', start + len(signature))
    return text[:start] + signature + '\n' + body + text[end:]


def prepare(source, target):
    source, target = source.resolve(), target.resolve()
    if not target.is_relative_to(ROOT / 'work') or target == ROOT / 'work':
        raise ValueError('Target must be a new directory inside fleetSimulation/work')
    if target.exists() or target.is_relative_to(source) or source.is_relative_to(target):
        raise ValueError('Source and new target must be separate; target must not exist')
    player = (source / 'PlayerInfo.gd').read_text(encoding='utf-8')
    version = re.search(r'^var version = "([^"]+)"', player, re.M).group(1)
    if version != GAME_VERSION:
        raise ValueError(f'Expected game {GAME_VERSION}, found {version}')
    data = json.loads((source / 'game_data.cdb').read_text(encoding='utf-8'))
    galaxies = next(s['lines'] for s in data['sheets'] if s['name'] == 'fleet_galaxies')
    if not {'galaxy12', 'galaxy13'} <= {g['id'] for g in galaxies}:
        raise ValueError('Recovered data is missing the current galaxies')
    # Preserve imported resources and UID cache required by recovered scenes.
    shutil.copytree(source, target, ignore=shutil.ignore_patterns(
        '.git', '.autoconverted', 'editor', '*.log', '*.save', '*.save.*'))
    project = (target / 'project.godot').read_text(encoding='utf-8')
    settings = {
        'config/name': '"Unnamed Space Idle Fleet Test"',
        'run/main_scene': '"res://fleet_optimizer_bootstrap.tscn"',
        'platform/force_disable_steam': 'true',
        'platform/prevent_startup_window_config': 'true',
        'features/initial_load_dev_save': '""',
        'run/low_processor_mode_sleep_usec': '1000',
    }
    for key, value in settings.items():
        project, count = re.subn(r'^' + re.escape(key) + r'=.*$', key + '=' + value, project, flags=re.M)
        if count != 1:
            raise ValueError('Unexpected recovered project setting: ' + key)
    project = re.sub(r'^config/(?:use_custom_user_dir|custom_user_dir_name)=.*\n', '', project, flags=re.M)
    project = project.replace('[application]\n', '[application]\nconfig/use_custom_user_dir=true\n'
                              'config/custom_user_dir_name="Unnamed Space Idle Fleet Test"\n', 1)
    project = project.replace('[autoload]\n', '[autoload]\nFleetTestRunner="*res://fleet_test_runner.gd"\n', 1)
    (target / 'project.godot').write_text(project, encoding='utf-8')
    # Only initialization/isolation patches; no native Fleet combat edits.
    for name in ('Steam.gd', 'purchase/PurchaseHelper.gd'):
        path = target / name
        text = path.read_text(encoding='utf-8')
        text = replace_function(text, 'func _ready() -> void :', '\tset_process(false)\n\treturn\n')
        path.write_text(text, encoding='utf-8')
    path = target / 'SaveLoad.gd'
    text = path.read_text(encoding='utf-8')
    for signature, body in (
        ('func read_file_and_prep_load(path = file_to_load) -> bool:', '\treturn false\n'),
        ('func load_game():', '\tloading = false\n\treturn false\n'),
    ):
        text = replace_function(text, signature, body)
    path.write_text(text, encoding='utf-8')
    for path in (ROOT / 'poc').iterdir():
        if path.suffix in ('.gd', '.tscn', '.json'):
            shutil.copy2(path, target / path.name)
    hashes = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in [source / 'game_data.cdb', source / 'PlayerInfo.gd',
                        *sorted((source / 'fleet').rglob('*.gd'))]}
    manifest = dict(game_version=version, source=str(source), native_sha256=hashes,
                    isolation_patches=['project.godot', 'Steam.gd', 'purchase/PurchaseHelper.gd', 'SaveLoad.gd'])
    (target / 'fleet_runtime_manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--target', type=Path, default=ROOT / 'work/full_recovered')
    args = parser.parse_args()
    result = prepare(args.source, args.target)
    print(f"Prepared game {result['game_version']} at {args.target.resolve()}")
