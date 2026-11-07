import argparse
import json
from pathlib import Path
import sys

from .catalog import Catalog, LAYERS, read_json, require
from .candidate import check_candidate
from .normalize import normalize
from .source import default_source


def main():
    if len(sys.argv) > 1 and sys.argv[1] in ('search', 'configure'):
        from .search_cli import main as search_main, configure
        try:
            return (search_main if sys.argv[1] == 'search' else configure)(sys.argv[2:])
        except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
            print(f"ERROR: {error}", file=sys.stderr)
            return 2
    if len(sys.argv) > 1 and sys.argv[1] == "native-smoke":
        from .native import main as native_main
        try:
            return native_main(sys.argv[2:])
        except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
            print(f"ERROR: {error}", file=sys.stderr)
            return 2
    parser = argparse.ArgumentParser(description="Titan native search and source research")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("native-smoke", help="Isolated native initialization or synthetic encounter (use native-smoke --help)")
    sub.add_parser('search', help='Joint native search (use search --help)')
    sub.add_parser('configure', help='Enter reusable player parameters (use configure --help)')
    for command in ("inspect", "check-candidate"):
        p = sub.add_parser(command)
        p.add_argument("--source", type=Path, default=default_source(), help="Recovered source; defaults to local/current_source.json")
        p.add_argument("--sector", required=True)
        p.add_argument("--layer", choices=LAYERS, required=True)
        p.add_argument("--output", type=Path, help="Create a new JSON file; never overwrite")
        if command == "check-candidate":
            p.add_argument("--candidate", type=Path, required=True)
    p = sub.add_parser("normalize", help="Normalize global Statistics summary readings (research only)")
    p.add_argument("--source", type=Path, default=default_source())
    p.add_argument("--snapshot", type=Path, required=True)
    p.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        require(args.source is not None, 'Provide --source or configure local/current_source.json')
        catalog = Catalog(args.source)
        if args.command == "inspect":
            result = catalog.report(args.sector, args.layer)
        elif args.command == "check-candidate":
            result = check_candidate(catalog, catalog.region(args.sector, args.layer), read_json(args.candidate))
        else:
            result = normalize(catalog, read_json(args.snapshot))
        serialized = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.output:
            require(not args.output.resolve().is_relative_to(catalog.source),
                    "Output must be outside the read-only source project")
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("x", encoding="utf-8") as stream:
                stream.write(serialized)
            print(f"RESEARCH_ONLY: {args.output.resolve()}")
        else:
            print(serialized, end="")
        return 0
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
