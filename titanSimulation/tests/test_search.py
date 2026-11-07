import copy
import os
from pathlib import Path
import time
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from titan_research.catalog import Catalog, read_json
from titan_research.candidate import check_candidate
from titan_research.generate import Candidates
from titan_research.player import prepare_player, check_access, capacity, guard_external_combat
from titan_research.search_cli import configure
from titan_research.search import optimize, stable

ROOT = Path(__file__).resolve().parents[1]
SOURCE = os.environ.get('TITAN_RESEARCH_SOURCE')


def battle(request, good=True):
    return dict(status='NATIVE_SMOKE_ONLY', observation_complete=good, deaths=0 if good else 1,
                seconds=request.get('minimum_seconds', 20), colossal_kills=request.get('minimum_cycles', 1),
                distance_min=request['distance'], distance_max=request['distance'],
                cycle_shield_fractions=[.9] * request.get('minimum_cycles', 1),
                minimum_shield_fraction=.9, boss_killed=good and request['mode'] == 'boss_once', parts=[])


class StabilityTests(unittest.TestCase):
    def test_stability_rejects_partial_dead_retreating_and_short_runs(self):
        good = battle(dict(mode='farm_distance', distance=100, minimum_seconds=120, minimum_cycles=10))
        self.assertTrue(stable(good, 100, 120, 10))
        for field, value in [('deaths', 1), ('seconds', 119), ('colossal_kills', 9),
                             ('distance_min', 99), ('distance_max', 101), ('observation_complete', False),
                             ('status', 'TIMING_STALLED')]:
            with self.subTest(field=field):
                self.assertFalse(stable(dict(good, **{field: value}), 100, 120, 10))
        self.assertFalse(stable(dict(good, cycle_shield_fractions=[1] * 7 + [.95, .94, .93]), 100, 120, 10))


@unittest.skipUnless(SOURCE, 'Set TITAN_RESEARCH_SOURCE for recovered-source tests')
class SearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = Catalog(SOURCE)
        cls.player = read_json(ROOT / 'examples/player.synthetic.json')
        if cls.catalog.enemy_alignment:
            cls.player['statistics']['game_version'] = cls.catalog.version
            cls.player['progress']['galaxy12_unlocked'] = False
        cls.profile = prepare_player(cls.catalog, cls.player)

    def test_generator_and_mutations_across_layers_and_minimal_caps(self):
        for layer in ('surface', 'antumbra', 'penumbra', 'umbra'):
            for caps in (self.profile['core_level_caps'], dict(TitanLaser=0, TitanShield=0, TitanArray=0)):
                profile = dict(self.profile, core_level_caps=caps)
                region = self.catalog.region(164, layer)
                factory = Candidates(self.catalog, profile, region, 456)
                candidate = factory.create()
                for _ in range(100):
                    candidate = factory.mutate(candidate)
                    check = check_candidate(self.catalog, region, candidate)
                    self.assertEqual(check['element_inventory'], dict(factory.inventory(candidate)))
                    self.assertLessEqual(check['array_capacity_used'], capacity(self.catalog, profile, layer))

    def test_access_and_player_are_not_changed_by_region(self):
        before = copy.deepcopy(self.player)
        for layer in ('surface', 'antumbra', 'penumbra'):
            check_access(self.player, self.catalog.region(164, layer), 'boss_once')
        with self.assertRaisesRegex(ValueError, 'reached'):
            check_access(self.player, self.catalog.region(164, 'umbra'), 'boss_once')
        p = copy.deepcopy(self.player)
        p['progress']['highest_sectors']['umbra'] = 170
        with self.assertRaisesRegex(ValueError, 'Effective layer'):
            check_access(p, self.catalog.region(164, 'umbra'), 'boss_once')
        p['progress']['umbra_sector_number'] = 165
        check_access(p, self.catalog.region(164, 'umbra'), 'farm_distance')
        with self.assertRaisesRegex(ValueError, 'Effective layer'):
            check_access(p, self.catalog.region(164, 'surface'), 'farm_distance')
        p = copy.deepcopy(self.player)
        p['progress']['highest_sectors']['surface'] = 164
        with self.assertRaisesRegex(ValueError, 'next sector'):
            check_access(p, self.catalog.region(164, 'antumbra'), 'boss_once')
        self.assertEqual(self.player, before)

    def test_array_reference_is_required(self):
        p = copy.deepcopy(self.player)
        del p['statistics']['reference_array_base_damage']
        with self.assertRaisesRegex(ValueError, 'Base Damage'):
            prepare_player(self.catalog, p)

    def test_future_external_combat_modifiers_are_not_silently_ignored(self):
        for target in ('titan_fire_rate', 'TitanRapidFire_power'):
            with patch.dict(self.catalog.tables['upgrades'], {'FutureUpgrade': {'effect': [
                    {'target': target, 'modifier_type': 'Multiplicative'}]}}):
                with self.assertRaisesRegex(ValueError, 'input'):
                    guard_external_combat(self.catalog)

    def test_configure_creates_independent_profile_and_does_not_overwrite(self):
        base = ROOT / 'work' / 'test-temp'
        base.mkdir(parents=True, exist_ok=True)
        values = ['surface', '4e22', '3e23', '23', '10000', '100000', '40', '5.72e25',
                  '60', '60', '20', '50', '40', '170', '170', '170', '160', '160', 'y']
        if self.catalog.enemy_alignment:
            values.append('n')
        with TemporaryDirectory(dir=base) as directory:
            output = Path(directory) / 'player.json'
            argv = ['--source', str(self.catalog.source), '--output', str(output)]
            with patch('builtins.input', side_effect=values), patch('builtins.print'):
                self.assertEqual(configure(argv), 0)
            self.assertEqual(read_json(output), self.player)
            before = output.read_bytes()
            with self.assertRaisesRegex(ValueError, 'exists'):
                configure(argv)
            self.assertEqual(output.read_bytes(), before)

    def run_search(self, mode, evaluator):
        class Worker:
            def evaluate(self, request):
                return evaluator(request)
        published, records = [], []
        result = optimize(self.catalog, self.player, self.profile, self.catalog.region(164, 'antumbra'),
                          mode, Worker(), time.perf_counter() + 10, 12345,
                          lambda r: published.append(copy.deepcopy(r)), records.append)
        return result, records, published

    def test_boss_stops_at_first_actual_kill(self):
        result, records, _ = self.run_search('boss_once', battle)
        self.assertEqual(result['status'], 'KILL_FOUND')
        self.assertEqual(len(records), 1)

    def test_farm_requires_three_independent_long_runs(self):
        result, records, _ = self.run_search('farm_distance', battle)
        self.assertEqual(result['status'], 'BEST_VALIDATED_DISTANCE_FOUND')
        self.assertEqual(len(records), 4)
        checks = result['best']['validation']
        self.assertEqual(len({c['seed'] for c in checks}), 3)
        self.assertNotIn(records[0]['seed'], [c['seed'] for c in checks])
        self.assertTrue(all(stable(c['battle'], c['distance'], 120, 10) for c in checks))
        self.assertEqual(result['best']['distance'], 129999)

    def test_timeout_or_cancel_during_validation_never_publishes_short_result(self):
        for interruption in (TimeoutError, KeyboardInterrupt):
            calls = []
            def evaluate(request):
                calls.append(request)
                if len(calls) == 3:
                    raise interruption()
                return battle(request)
            result, records, published = self.run_search('farm_distance', evaluate)
            self.assertIsNone(result['best'])
            self.assertEqual(len(records), 2)
            self.assertTrue(all(r['best'] is None for r in published))

    def test_failed_holdout_is_not_a_stable_recommendation(self):
        calls = []
        def evaluate(request):
            calls.append(request)
            if len(calls) > 2:
                raise TimeoutError()
            return battle(request, good=len(calls) == 1)
        result, _, _ = self.run_search('farm_distance', evaluate)
        self.assertIsNone(result['best'])


if __name__ == '__main__':
    unittest.main()
