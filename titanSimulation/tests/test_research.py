from copy import deepcopy
from pathlib import Path
import os
import unittest
from unittest.mock import patch

from titan_research.catalog import Catalog, read_json
from titan_research.candidate import check_candidate
from titan_research.normalize import normalize


def fixture():
    """Small synthetic catalog; no recovered game assets needed for unit tests."""
    c = Catalog.__new__(Catalog)
    c.hashes = {"fixture": "synthetic"}
    c.ship = {"core_slots": [{"type": "Weapon"}] * 3 + [{"type": "Shield"}]}
    c.cores = {}
    for name, kind, element in (("Laser", "Weapon", "shot"), ("Splash", "Weapon", "splash"),
                                ("TitanArray", "Weapon", "boost"), ("Shield", "Shield", None)):
        c.cores[name] = {"id": name, "type": kind, "slot_type": "Titan", "weapon": name}
        if element:
            c.cores[name]["titan_element"] = element
    c.elements = {
        "shot": {"cost": 5, "weapon_id": "shot"},
        "splash": {"cost": 7, "weapon_id": "splash"},
        "boost": {"cost": 2},
        "ability": {"cost": 3, "ability_id": "ability"},
        "unavailable": {"cost": 1, "weapon_id": "other"},
    }
    c.targeting = {"type": ["None", "Armored"], "priority": ["Closest"],
                   "swapping": ["Change Target"], "overlap": ["Allow", "Avoid"],
                   "aoe_priority": ["Biggest Cluster"]}
    c.systems = ["GLOBAL", "DEFENSIVE_PLATING", "TURRET_POWER"]
    c.tables = {
        "weapons": {name: {"aoe_size": 10 if name == "Splash" else 0} for name in c.cores},
        "core_milestones": {
            "damage": {"id": "damage", "parent_core": "Laser", "core_levels_required": 10, "effect": []},
            "ability": {"id": "ability", "parent_core": "Laser", "core_levels_required": 10,
                        "effect": [{"modifier_type": "TitanElement", "target": "ability"}]},
            "shield": {"id": "shield", "parent_core": "Shield", "core_levels_required": 10, "effect": []},
        },
        "sectors": {"test": {"id": "test", "order": 164, "route": "", "distance_starts": 100,
                             "distance_ends": 200, "titan_scaling": "[x]*2", "boss": "boss",
                             "enemies": [{"enemy": "a", "veil": 0}, {"enemy": "b", "veil": 1},
                                         {"enemy": "c", "veil": 2}]}},
        "ships": {"boss": {"colossal_parts": [{"system": 1, "veil": 1}, {"system": 1, "veil": 0},
                                               {"system": 2, "veil": 2}]}},
    }
    target = {"type": "None", "priority": "Closest", "swapping": "Change Target", "overlap": "Allow"}
    p = {
        "weapons": [{"id": "Laser", "level": 10, "milestones": {"10": "ability"},
                     "targeting": deepcopy(target)} for _ in range(3)],
        "shield": {"id": "Shield", "level": 10, "milestones": {}},
        "array_core": {"id": "TitanArray", "level": 0, "milestones": {}},
        "array_capacity": 23,
        "sequence": [{"id": "boost", "targets": []}, {"id": "shot", "targets": ["1:2", "1:1"]}],
    }
    return c, p


class ResearchTests(unittest.TestCase):
    def setUp(self):
        self.catalog, self.candidate = fixture()
        self.region = self.catalog.region(164, "antumbra")

    def check(self):
        return check_candidate(self.catalog, self.region, self.candidate)

    def test_inventory_auto_milestone_and_input_unchanged(self):
        before = deepcopy(self.candidate)
        result = self.check()
        self.assertEqual(result["element_inventory"], {"shot": 3, "ability": 1, "boost": 1})
        self.assertEqual(result["array_capacity_used"], 7)
        self.assertIn("shield", result["selected_milestones"])
        self.assertFalse(result["combat_verified"])
        self.assertEqual(self.candidate, before)

    def test_layer_filter_and_numbering_after_filter(self):
        surface = self.catalog.region(164, "surface")
        penumbra = self.catalog.region(164, "penumbra")
        umbra = self.catalog.region(164, "umbra")
        self.assertEqual([x["id"] for x in surface["array_targets"]], ["1:1"])
        self.assertEqual([x["id"] for x in penumbra["array_targets"]], ["1:1", "2:1"])
        self.assertEqual([x["id"] for x in umbra["array_targets"]], ["1:1", "1:2", "2:1"])
        self.assertEqual([x["enemy"] for x in umbra["enemies"]], ["a", "b", "c"])

    def test_no_cross_layer_target(self):
        self.region = self.catalog.region(164, "surface")
        with self.assertRaisesRegex(ValueError, "Target does not exist"):
            self.check()

    def test_default_targets_are_valid(self):
        self.candidate["sequence"][1]["targets"] = []
        self.check()

    def test_duplicate_targets_rejected(self):
        self.candidate["sequence"][1]["targets"] = ["1:1", "1:1"]
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.check()

    def test_buff_has_no_targets(self):
        self.candidate["sequence"][0]["targets"] = ["1:1"]
        with self.assertRaisesRegex(ValueError, "Only attack"):
            self.check()

    def test_capacity_boundary(self):
        self.candidate["array_capacity"] = 7
        self.check()
        self.candidate["array_capacity"] = 6.99
        with self.assertRaisesRegex(ValueError, "capacity exceeded"):
            self.check()

    def test_non_finite_capacity(self):
        for value in (float("nan"), float("inf"), True, -1):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.candidate["array_capacity"] = value
                self.check()

    def test_no_unearned_database_element(self):
        self.candidate["sequence"].append({"id": "unavailable", "targets": []})
        with self.assertRaisesRegex(ValueError, "unavailable/exhausted"):
            self.check()

    def test_ability_inventory_capped_at_one(self):
        self.candidate["sequence"] += [{"id": "ability", "targets": []}] * 2
        with self.assertRaisesRegex(ValueError, "unavailable/exhausted"):
            self.check()

    def test_changed_milestone_changes_inventory(self):
        for weapon in self.candidate["weapons"]:
            weapon["milestones"] = {"10": "damage"}
        self.candidate["sequence"].append({"id": "ability", "targets": []})
        with self.assertRaisesRegex(ValueError, "unavailable/exhausted"):
            self.check()

    def test_locked_or_wrong_milestone(self):
        self.candidate["weapons"][0]["level"] = 9
        with self.assertRaisesRegex(ValueError, "Locked"):
            self.check()
        self.candidate["weapons"][0]["level"] = 10
        self.candidate["weapons"][0]["milestones"] = {"10": "shield"}
        with self.assertRaisesRegex(ValueError, "Wrong milestone"):
            self.check()

    def test_choice_required(self):
        self.candidate["weapons"][0]["milestones"] = {}
        with self.assertRaisesRegex(ValueError, "Choose one"):
            self.check()

    def test_array_does_not_replace_weapon_slot(self):
        self.candidate["weapons"][0].update(id="TitanArray", level=0, milestones={})
        with self.assertRaisesRegex(ValueError, "separate automatic core"):
            self.check()

    def test_three_ordered_slots(self):
        self.candidate["weapons"].pop()
        with self.assertRaisesRegex(ValueError, "3 ordered"):
            self.check()

    def test_aoe_target_only_for_aoe_core(self):
        self.candidate["weapons"][0]["targeting"]["priority"] = "Biggest Cluster"
        with self.assertRaisesRegex(ValueError, "Unsupported Laser"):
            self.check()
        self.candidate["weapons"][0].update(id="Splash", level=0, milestones={})
        self.check()

    def test_bad_levels(self):
        for level in (True, 1.5, -1):
            with self.subTest(level=level), self.assertRaises(ValueError):
                self.candidate["weapons"][0]["level"] = level
                self.check()

    def test_unknown_field(self):
        self.candidate["sequence"][1]["target"] = "1:1"
        with self.assertRaisesRegex(ValueError, "Unknown fields"):
            self.check()

    def test_missing_or_ambiguous_region(self):
        with self.assertRaisesRegex(ValueError, "uniquely"):
            self.catalog.region(165, "surface")
        self.catalog.tables["sectors"]["other"] = deepcopy(self.catalog.tables["sectors"]["test"])
        with self.assertRaisesRegex(ValueError, "uniquely"):
            self.catalog.region(164, "surface")

    def test_json_duplicate_and_nonfinite(self):
        for text in ('{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}'):
            with patch.object(Path, "read_text", return_value=text), self.assertRaises(ValueError):
                read_json("synthetic-input.json")


@unittest.skipUnless(os.environ.get("TITAN_RESEARCH_SOURCE"), "Set TITAN_RESEARCH_SOURCE for local source checks")
class LocalSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = Catalog(os.environ["TITAN_RESEARCH_SOURCE"])

    def test_current_164_parts_and_example(self):
        expected = {"surface": ["1:1", "2:1"], "antumbra": ["1:1", "1:2", "2:1"],
                    "penumbra": ["1:1", "2:1", "4:1"], "umbra": ["1:1", "1:2", "2:1", "4:1"]}
        for layer, ids in expected.items():
            with self.subTest(layer=layer):
                region = self.catalog.region(164, layer)
                self.assertEqual(region["boss_id"], "ColossalSwarm")
                self.assertEqual([part["id"] for part in region["array_targets"]], ids)
        candidate = read_json(Path(__file__).resolve().parents[1] / "examples/candidate.json")
        result = check_candidate(self.catalog, self.catalog.region(164, "antumbra"), candidate)
        self.assertEqual(result["array_capacity_used"], 21 if self.catalog.enemy_alignment else 23)
        self.assertNotIn("overload_shot", result["element_inventory"])

    def test_current_milestones_and_targets(self):
        self.assertEqual(len(self.catalog.milestones("TitanShockwaveCannon")), 4 if self.catalog.enemy_alignment else 2)
        self.assertTrue(all(len(rows) == 1 for rows in self.catalog.milestones("TitanShield").values()))
        self.assertEqual(len(self.catalog.targeting["type"]), 11)
        self.assertEqual(len(self.catalog.targeting["priority"]), 7)

    def snapshot(self):
        value = read_json(Path(__file__).resolve().parents[1] / "examples/stats_snapshot.json")
        if self.catalog.enemy_alignment:
            value['game_version'] = self.catalog.version
        return value

    def test_normalize_statistics_bases_and_core_capacity(self):
        result = normalize(self.catalog, self.snapshot())
        self.assertEqual(result["external_combat_multipliers"], {"titan_damage": 1000, "titan_max_shields": 1000})
        self.assertEqual(result["capacity_before_array_core_milestones_and_layer"], 7)
        self.assertEqual(result["array_charge_rate_before_layer"], 1)
        self.assertFalse(result["ready_for_combat"])
        self.assertTrue(any(s["hook"] == "array" for s in result["hook_only_sources_not_in_summary"]))

    def test_normalize_across_all_reference_layers(self):
        expected = normalize(self.catalog, self.snapshot())
        for layer in ("surface", "antumbra", "penumbra", "umbra"):
            with self.subTest(layer=layer):
                snapshot = self.snapshot()
                snapshot["reference_layer"] = layer
                factors = expected["layer_multipliers"][layer]
                snapshot["summary_stats"]["titan_damage"] *= factors["combat"]
                snapshot["summary_stats"]["titan_max_shields"] *= factors["combat"]
                snapshot["summary_stats"]["array_capacity"] *= factors["capacity"]
                snapshot["reference_array_base_damage"] *= factors["combat"]
                result = normalize(self.catalog, snapshot)
                self.assertAlmostEqual(result["external_combat_multipliers"]["titan_damage"], 1000)
                self.assertAlmostEqual(result["external_combat_multipliers"]["titan_max_shields"], 1000)
                self.assertAlmostEqual(result["capacity_before_array_core_milestones_and_layer"], 7)
                self.assertAlmostEqual(result["array_calibration"]["array_only_multiplier"], 1.04)

    def test_array_calibration_uses_core_damage_and_local_milestone(self):
        result = normalize(self.catalog, self.snapshot())
        self.assertEqual(result["array_calibration"]["unscaled_reference_damage"], 5500)
        self.assertAlmostEqual(result["array_calibration"]["array_only_multiplier"], 1.04)

    def test_missing_array_reference_remains_explicitly_unknown(self):
        snapshot = self.snapshot()
        del snapshot["reference_array_base_damage"]
        self.assertIsNone(normalize(self.catalog, snapshot)["array_calibration"])

    def test_array_calibration_below_milestone(self):
        snapshot = self.snapshot()
        snapshot["reference_array_level"] = 20
        snapshot["summary_stats"]["array_capacity"] = 10
        snapshot["reference_array_base_damage"] = 2400000
        result = normalize(self.catalog, snapshot)
        self.assertAlmostEqual(result["array_calibration"]["array_only_multiplier"], 1)

    def test_normalize_zero_alignment_and_active_ability(self):
        snapshot = self.snapshot()
        snapshot["alignment"] = {"antumbra": 0, "penumbra": 0}
        self.assertEqual(normalize(self.catalog, snapshot)["layer_multipliers"]["antumbra"]["combat"], 1)
        snapshot["temporary_combat_effects_active"] = True
        with self.assertRaisesRegex(ValueError, "inactive"):
            normalize(self.catalog, snapshot)

    def test_normalize_rejects_new_external_flat_source(self):
        catalog = deepcopy(self.catalog)
        catalog.tables["upgrades2"]["new_flat_source"] = {"effect": [{"target": "titan_damage", "modifier_type": "Flat"}]}
        with self.assertRaisesRegex(ValueError, "nonmultiplicative"):
            normalize(catalog, self.snapshot())

    def test_normalize_rejects_changed_formula(self):
        catalog = deepcopy(self.catalog)
        if catalog.enemy_alignment:
            original = catalog.text
            with patch.object(catalog, 'text', side_effect=lambda name: original(name).replace('pow(1.8,', 'pow(1.9,')):
                with self.assertRaisesRegex(ValueError, 'Changed alignment'):
                    normalize(catalog, self.snapshot())
        else:
            catalog.tables["upgrades2"]["VSCombatAlignmentAntumbra"]["effect"][0]["expression"] = "new formula"
            with self.assertRaisesRegex(ValueError, "Changed alignment"):
                normalize(catalog, self.snapshot())

    def test_normalize_rejects_new_charge_source(self):
        catalog = deepcopy(self.catalog)
        catalog.tables["upgrades2"]["new_charge_source"] = {"effect": [{"target": "array_charge_rate", "modifier_type": "Multiplicative"}]}
        with self.assertRaisesRegex(ValueError, "extra input"):
            normalize(catalog, self.snapshot())


if __name__ == "__main__":
    unittest.main()
