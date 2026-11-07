"""Behavioral contracts introduced in 0.90; legacy source tests remain separate."""
from copy import deepcopy
import os
from pathlib import Path
import unittest

from titan_research.catalog import Catalog, read_json
from titan_research.candidate import check_candidate
from titan_research.generate import Candidates
from titan_research.native import application_setting
from titan_research.normalize import normalize
from titan_research.player import prepare_player, native_input

ROOT = Path(__file__).resolve().parents[1]


class IsolatedSettingsTests(unittest.TestCase):
    def test_export_without_custom_user_settings_gets_isolated_defaults(self):
        original = '[application]\nconfig/name="Game"\n\n[autoload]\nTest="*res://test.gd"\n'
        updated = application_setting(original, 'config/use_custom_user_dir', 'true')
        updated = application_setting(updated, 'config/custom_user_dir_name', '"TitanResearch"')
        self.assertIn('[application]\nconfig/custom_user_dir_name="TitanResearch"', updated)
        self.assertIn('config/use_custom_user_dir=true', updated)
        self.assertEqual(application_setting(updated, 'config/use_custom_user_dir', 'true'), updated)


@unittest.skipUnless(os.environ.get('TITAN_RESEARCH_SOURCE'), 'Requires recovered source')
class Version090Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = Catalog(os.environ['TITAN_RESEARCH_SOURCE'])
        if not cls.c.enemy_alignment:
            raise unittest.SkipTest('0.90 source only')
        cls.player = read_json(ROOT / 'examples/player.synthetic.0.90.json')

    def test_alignment_no_longer_changes_player_damage_or_array_calibration(self):
        low = deepcopy(self.player['statistics'])
        low['reference_layer'] = 'antumbra'
        low['alignment'] = dict(antumbra=0, penumbra=0)
        high = deepcopy(low)
        high['alignment'] = dict(antumbra=1e30, penumbra=1e50)
        a, b = normalize(self.c, low), normalize(self.c, high)
        self.assertEqual(a['external_combat_multipliers'], b['external_combat_multipliers'])
        self.assertEqual(a['array_calibration'], b['array_calibration'])
        self.assertTrue(all(v['combat'] == 1 for v in b['layer_multipliers'].values()))
        self.assertEqual(b['alignment_model'], 'enemy_reduction')

    def test_old_or_unversioned_readings_are_rejected(self):
        for version in (None, '0.85.1.0'):
            snapshot = deepcopy(self.player['statistics'])
            if version is None:
                snapshot.pop('game_version')
            else:
                snapshot['game_version'] = version
            with self.assertRaisesRegex(ValueError, 'recaptured'):
                normalize(self.c, snapshot)

    def test_new_enemy_registry_and_disruption_targets(self):
        self.assertIn('ColossalSwarm', self.c.tables['ships'])
        region = self.c.region(170, 'umbra')
        self.assertIn('5:1', [p['id'] for p in region['array_targets']])
        self.assertEqual(self.c.region(175, 'surface')['boss_id'], 'ColossalLayered')

    def test_new_elements_generated_from_new_milestones_and_fit_native_cost(self):
        player = deepcopy(self.player)
        player['statistics']['core_level_caps'].update(TitanLaser=80, TitanCannon=80,
                                                      TitanShockwaveCannon=40, TitanShield=70, TitanArray=50)
        profile = prepare_player(self.c, player)
        region = self.c.region(170, 'umbra')
        generator = Candidates(self.c, profile, region, 12345)
        candidate = next(generator.seeds())
        candidate['weapons'][0]['milestones']['80'] = 'TitanLaserMile72'
        candidate['weapons'][2]['milestones']['30'] = 'TitanShockwaveMile32'
        candidate['sequence'] = [dict(id=k, targets=['5:1'] if k in ('weak_shot', 'kinetic_honing_shot') else [])
                                 for k in ('segmented_honing', 'vampiric_charge', 'weak_shot', 'kinetic_honing_shot')]
        checked = check_candidate(self.c, region, candidate)
        self.assertEqual(checked['array_capacity_used'], 13)
        for key in ('weak_shot', 'vampiric_charge', 'segmented_honing'):
            self.assertGreaterEqual(checked['element_inventory'][key], 1)
        for _ in range(100):
            candidate = generator.mutate(candidate)
            check_candidate(self.c, region, candidate)

    def test_galaxy12_is_explicit_and_reaches_native_request(self):
        p = deepcopy(self.player)
        del p['progress']['galaxy12_unlocked']
        with self.assertRaisesRegex(ValueError, 'Missing fields'):
            prepare_player(self.c, p)
        for unlocked in (False, True):
            p['progress']['galaxy12_unlocked'] = unlocked
            profile = prepare_player(self.c, p)
            r = self.c.region(165, 'antumbra')
            candidate = next(Candidates(self.c, profile, r, 1).seeds())
            request = native_input(p, profile, r, candidate, 'boss_once', r['distance_end'], 1, 90)
            self.assertEqual(request['galaxy12_unlocked'], unlocked)


if __name__ == '__main__':
    unittest.main()
