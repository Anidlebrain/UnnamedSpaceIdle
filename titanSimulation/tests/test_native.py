"""Failure classification and synthetic fixture checks; no game process started."""
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from titan_research.catalog import Catalog
from titan_research.native import (compare_cases, execute, patch_random_sources, setting,
                                   successful_result, synthetic_batch, synthetic_input, unexpected_errors)


class NativeProtocolTests(unittest.TestCase):
    def test_seed_rejects_values_that_cannot_use_the_supported_contract(self):
        for seed in (-1, 2147483648, True, 1.5):
            with self.subTest(seed=seed), self.assertRaisesRegex(ValueError, 'Seed'):
                synthetic_batch(None, seed)

    def test_rng_overlay_preserves_surrounding_lines(self):
        base = Path(__file__).resolve().parents[1] / 'work' / 'test-temp'
        base.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=base) as folder:
            root = Path(folder).resolve()
            self.assertTrue(root.is_relative_to(base.resolve()))
            (root / 'enemies').mkdir()
            source = 'func one():\n\tvar rng = RandomNumberGenerator.new()\n\trng.randomize()\n\n\tvar x = 3\n\nfunc two():\n\tpass\n'
            path = root / 'enemies/test.gd'
            path.write_text(source, encoding='utf-8')
            patches = patch_random_sources(root)
            modified = path.read_text(encoding='utf-8')
            self.assertIn(')\n\n\tvar x = 3\n\nfunc two():', modified)
            self.assertEqual(len(patches), 1)
            self.assertEqual(patches[0]['rng_sites'], ['enemies/test.gd:0'])
            self.assertNotEqual(patches[0]['before_sha256'], patches[0]['after_sha256'])

    def test_batch_cannot_succeed_with_missing_case(self):
        probe = {'native_game_loaded': True, 'expected_cases': 3,
                 'battles': [{'status': 'NATIVE_SMOKE_ONLY'}]}
        self.assertFalse(successful_result(0, False, 0, [], probe))

    def test_repeat_check_includes_combat_but_excludes_wall_time(self):
        a = {'parts': [10], 'trace': [1, 2], 'battle_wall_seconds': 2}
        self.assertTrue(compare_cases(a, dict(a, battle_wall_seconds=3))['equal'])
        self.assertEqual(compare_cases(a, dict(a, parts=[9]))['different_fields'], ['parts'])
    def test_interrupt_terminates_owned_native_process(self):
        process = Mock()
        process.poll.return_value = None
        workspace_tmp = Path(__file__).resolve().parents[1] / 'work' / 'test-temp'
        workspace_tmp.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=workspace_tmp) as folder, patch('titan_research.native.subprocess.Popen', return_value=process), \
                patch('titan_research.native.time.sleep', side_effect=KeyboardInterrupt):
            self.assertTrue(Path(folder).resolve().is_relative_to(workspace_tmp.resolve()))
            with self.assertRaises(KeyboardInterrupt):
                execute(Path('synthetic.exe'), Path(folder), Path(folder), 10)
        process.kill.assert_called_once()
        process.wait.assert_called_once()

    def test_rejects_partial_or_failed_native_runs(self):
        good = {"native_game_loaded": True, "battle": {"status": "NATIVE_SMOKE_ONLY"}}
        self.assertTrue(successful_result(0, False, 0, [], good))
        for code, timeout, scripts, errors, probe in (
            (1, False, 0, [], good), (0, True, 0, [], good),
            (0, False, 1, [], good), (0, False, 0, ["ERROR: unexpected"], good),
            (0, False, 0, [], None),
            (0, False, 0, [], {"native_game_loaded": True, "battle": {"status": "TIMING_STALLED"}}),
            (0, False, 0, [], {"native_game_loaded": True, "battle": {"status": "INVALID_SETUP"}}),
        ):
            self.assertFalse(successful_result(code, timeout, scripts, errors, probe))

    def test_new_engine_errors_are_not_ignored(self):
        self.assertEqual(unexpected_errors("ERROR: 5 resources still in use at exit (run with --verbose for details).\nERROR: new failure"), ["ERROR: new failure"])

    def test_project_setting_is_unique_and_literal(self):
        self.assertEqual(setting('config/name="old"\n', 'config/name', '"new"'), 'config/name="new"\n')
        for config in ('', 'config/name=1\nconfig/name=2\n'):
            with self.assertRaises(ValueError):
                setting(config, 'config/name', '"new"')


@unittest.skipUnless(os.environ.get("TITAN_RESEARCH_SOURCE"), "Set TITAN_RESEARCH_SOURCE")
class NativeFixtureTests(unittest.TestCase):
    def test_batch_audit_changes_configuration_and_repeats_original(self):
        batch = synthetic_batch(Catalog(os.environ['TITAN_RESEARCH_SOURCE']))
        a, b, again = batch['cases']
        self.assertEqual(a, again)
        self.assertNotEqual(a['candidate']['sequence'], b['candidate']['sequence'])
        self.assertIn('basic_rapid_fire', [e['id'] for e in b['candidate']['sequence']])
        again['candidate']['weapons'][0]['level'] = 1
        self.assertNotEqual(a, again)

    def test_synthetic_modes_and_calibration(self):
        catalog = Catalog(os.environ["TITAN_RESEARCH_SOURCE"])
        farm = synthetic_input(catalog, 'farm_distance')
        boss = synthetic_input(catalog, 'boss_once')
        self.assertTrue(farm['synthetic'])
        self.assertEqual(farm['profile'], boss['profile'])
        self.assertEqual(farm['distance'], 128001)
        self.assertEqual(boss['distance'], 130000)
        self.assertAlmostEqual(farm['expected_array_damage'] / (5.72e23 if catalog.enemy_alignment else 6.0046272e24), 1)
        self.assertEqual(farm['candidate']['array_capacity'], 23)
        strong = synthetic_input(catalog, 'boss_once', 'strong')
        self.assertAlmostEqual(strong['expected_array_damage'] / boss['expected_array_damage'], 100)
        self.assertEqual(strong['candidate'], boss['candidate'])
        self.assertEqual(strong['profile']['external_combat_multipliers']['titan_max_shields'],
                         boss['profile']['external_combat_multipliers']['titan_max_shields'])


if __name__ == '__main__':
    unittest.main()
