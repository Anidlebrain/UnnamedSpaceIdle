"""Local selection of an already recovered source, never the installed game."""
from pathlib import Path
from .catalog import read_json, require

ROOT = Path(__file__).resolve().parents[1]


def default_source():
    config = ROOT / 'local' / 'current_source.json'
    if not config.exists():
        return None
    value = read_json(config)
    require(isinstance(value.get('source'), str), f'Invalid source selection: {config}')
    path = Path(value['source'])
    return path if path.is_absolute() else (ROOT / path).resolve()
