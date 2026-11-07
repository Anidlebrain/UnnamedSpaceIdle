"""Explicit 0.90 native regression: new array effects, disruption and scaling state."""
import argparse
from copy import deepcopy
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from titan_research.catalog import Catalog, read_json
from titan_research.candidate import check_candidate
from titan_research.generate import Candidates
from titan_research.native import ROOT, compare_cases
from titan_research.player import prepare_player, native_input
from titan_research.search import optimize, stable
from titan_research.worker import NativeWorker, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--godot', type=Path, required=True)
    parser.add_argument('--label', required=True)
    args = parser.parse_args()
    c = Catalog(args.source)
    assert c.enemy_alignment
    deadline = time.perf_counter() + 480
    player = read_json(ROOT / 'examples/player.synthetic.0.90.json')
    player['statistics']['core_level_caps'].update(TitanLaser=80, TitanCannon=80,
        TitanShockwaveCannon=40, TitanShield=70, TitanArray=50)
    # Deliberately stronger fixture so this tests plumbing, not player progression.
    for key in ('titan_damage', 'titan_max_shields'):
        player['statistics']['summary_stats'][key] *= 1e18
    player['statistics']['reference_array_base_damage'] *= 1e18
    records = []
    with NativeWorker(args.source, args.godot, args.label, deadline) as worker:
        def request(data, sector, layer, mode='boss_once'):
            profile = prepare_player(c, data)
            region = c.region(sector, layer)
            factory = Candidates(c, profile, region, 789)
            candidate = next(factory.seeds())
            candidate['weapons'][0]['milestones']['80'] = 'TitanLaserMile72'
            candidate['weapons'][2]['milestones']['30'] = 'TitanShockwaveMile32'
            target = ['5:1'] if any(t['id'] == '5:1' for t in region['array_targets']) else ['1:1']
            candidate['sequence'] = [dict(id=k, targets=target if k in ('weak_shot', 'kinetic_honing_shot') else [])
                for k in ('segmented_honing', 'vampiric_charge', 'weak_shot', 'kinetic_honing_shot')]
            check_candidate(c, region, candidate)
            farm = mode == 'farm_distance'
            return native_input(data, profile, region, candidate, mode, region['distance_end'] - int(farm),
                                789, 600 if farm else 90, 120 if farm else None, 10 if farm else None)

        def run(name, data):
            result = worker.evaluate(data)
            records.append(dict(name=name, request=data, battle=result))
            write_json(worker.run / 'update_integration.json', records)
            print(name, result['boss_killed'], result['seconds'], result['enemy_scaling'], flush=True)
            return result

        first = request(player, 168, 'antumbra')
        a = run('new_array_and_disruption', first)
        assert a['boss_killed'] and a['enemy_scaling']['initial_disruption_multiplier'] < 1
        weak = next(e for e in a['array_elements'] if e['id'] == 'weak_shot')
        assert any(e['target'] == 'charge' and e['amount'] == 15 for e in weak['on_hit']['destroy_part'])
        assert any(e['target'] == 'honing' for e in weak['on_hit']['destroy_segment'])

        farm_request = request(player, 168, 'antumbra', 'farm_distance')
        farm = run('new_array_continuous_farm', farm_request)
        assert stable(farm, farm_request['distance'], 120, 10)
        for unlocked in (False, True):
            data = deepcopy(player)
            data['progress']['galaxy12_unlocked'] = unlocked
            result = run('galaxy12_' + str(unlocked), request(data, 165, 'surface'))
            if not unlocked:
                harder = result['enemy_scaling']['effective']
            else:
                assert result['enemy_scaling']['effective'] < harder

        for amount in (0, 1e50):
            data = deepcopy(player)
            data['statistics']['alignment']['antumbra'] = amount
            result = run('alignment_' + str(amount), request(data, 168, 'antumbra'))
            if amount == 0:
                unaligned = result
            else:
                assert result['cores'] == unaligned['cores']
                assert result['enemy_scaling']['before_alignment'] == unaligned['enemy_scaling']['before_alignment']
                assert result['enemy_scaling']['effective'] < unaligned['enemy_scaling']['effective']
        worker.cache.clear()
        repeated = run('repeat_after_scaling_changes', first)
        assert compare_cases(a, repeated)['equal'], compare_cases(a, repeated)
        # Search scheduler consumes the same persistent native protocol, including holdout validation.
        normal = read_json(ROOT / 'examples/player.synthetic.0.90.json')
        profile = prepare_player(c, normal)
        region = c.region(164, 'antumbra')
        for mode in ('boss_once', 'farm_distance'):
            result = optimize(c, normal, profile, region, mode, worker, deadline, 12345,
                              lambda r: write_json(worker.run / (mode + '.json'), r),
                              lambda item: None)
            assert result['best'] is not None, result
            print(mode, result['status'], result['trials'], flush=True)
        print('0.90 new effects + scaling + repeat + both searches: PASS', flush=True)


if __name__ == '__main__':
    main()
