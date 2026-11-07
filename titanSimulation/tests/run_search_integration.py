"""Explicit, opt-in native integration. Never run by unittest discovery.

python tests/run_search_integration.py --source <copy> --godot <exe> --label <unique>
Synthetic fixtures only; one process, four layers, continuous waves and A/B/A reset.
"""
import argparse
from copy import deepcopy
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from titan_research.catalog import Catalog, read_json
from titan_research.generate import Candidates
from titan_research.native import ROOT, compare_cases
from titan_research.player import prepare_player, check_access, native_input
from titan_research.search import stable
from titan_research.worker import NativeWorker, write_json


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--godot', type=Path, required=True)
    p.add_argument('--label', required=True)
    args = p.parse_args()
    deadline = time.perf_counter() + 360
    c = Catalog(args.source)
    player = read_json(ROOT / 'examples/player.synthetic.json')
    if c.enemy_alignment:
        player['statistics']['game_version'] = c.version
        player['progress']['galaxy12_unlocked'] = False
    records = []
    with NativeWorker(args.source, args.godot, args.label, deadline) as worker:
        first_request = first_battle = None
        for layer in ('surface', 'antumbra', 'penumbra', 'umbra'):
            data = deepcopy(player)
            if layer == 'umbra':
                data['progress']['umbra_sector_number'] = 165
                data['progress']['highest_sectors']['umbra'] = 165
            profile = prepare_player(c, data)
            region = c.region(164, layer)
            check_access(data, region, 'boss_once')
            factory = Candidates(c, profile, region, 456)
            candidate = next(factory.seeds())
            request = native_input(data, profile, region, candidate, 'boss_once', region['distance_end'], 76543, 90)
            battle = worker.evaluate(request)
            assert battle['boss_killed'], (layer, battle)
            records.append(dict(layer=layer, mode='boss_once', battle=battle))
            print(layer, 'boss', battle['seconds'], flush=True)
            if first_request is None:
                first_request, first_battle = deepcopy(request), battle
            distance = region['distance_end'] - 1
            request = native_input(data, profile, region, candidate, 'farm_distance', distance, 76543, 600, 120, 10)
            battle = worker.evaluate(request)
            assert stable(battle, distance, 120, 10), (layer, battle)
            records.append(dict(layer=layer, mode='farm_distance', battle=battle))
            write_json(worker.run / 'integration.json', records)
            print(layer, 'farm', battle['seconds'], battle['colossal_kills'], flush=True)
        weak = deepcopy(first_request)
        weak['profile']['external_combat_multipliers']['titan_max_shields'] *= 1e-25
        weak['profile']['external_combat_multipliers']['titan_damage'] *= 1e-25
        death = worker.evaluate(weak)
        assert death['deaths'] == 1
        worker.cache.clear()  # This must be a real repeated trial, not a cache hit.
        repeated = worker.evaluate(first_request)
        comparison = compare_cases(first_battle, repeated)
        assert comparison['equal'], comparison
        records.append(dict(reset_after_death=comparison, death=death))
        write_json(worker.run / 'integration.json', records)
        print('four layers + continuous farm + death reset: PASS', flush=True)


if __name__ == '__main__':
    main()
