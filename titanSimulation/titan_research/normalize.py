"""Normalize global Statistics summary values, not equipped-core panel values.

This is a source-guarded input conversion, NOT a combat simulator. See research.md.
"""

import math
import re
from .catalog import LAYERS, integer, require
from .candidate import fields


def positive(value, name, allow_zero=False):
    require(type(value) in (int, float) and math.isfinite(value)
            and (value >= 0 if allow_zero else value > 0), f"{name} must be finite and {'non-negative' if allow_zero else 'positive'}")
    return value


def normalize(catalog, snapshot):
    required = ("reference_layer", "temporary_combat_effects_active", "summary_stats",
                "alignment", "reference_array_level", "core_level_caps")
    fields(snapshot, (*required, "reference_array_base_damage", "game_version"), "snapshot", required=required)
    recorded_version = snapshot.get('game_version')
    require(recorded_version == catalog.version or (recorded_version is None and not catalog.enemy_alignment),
            f'Statistics must be recaptured for game {catalog.version}; run configure. Do not relabel old readings.')
    layer = snapshot["reference_layer"]
    require(layer in LAYERS, "Unknown reference layer")
    require(snapshot["temporary_combat_effects_active"] is False,
            "Capture Statistics with temporary combat abilities inactive")
    stats = snapshot["summary_stats"]
    fields(stats, ("titan_damage", "titan_max_shields", "array_capacity"), "summary_stats")
    for key, value in stats.items():
        positive(value, key)
    alignment = snapshot["alignment"]
    fields(alignment, ("antumbra", "penumbra"), "alignment")
    for key, value in alignment.items():
        positive(value, f"alignment.{key}", allow_zero=True)
    reference_level = integer(snapshot["reference_array_level"], "reference_array_level")
    caps = snapshot["core_level_caps"]
    # A missing ordinary weapon means unavailable; mandatory cores remain required.
    allowed = ("TitanLaser", "TitanCannon", "TitanShockwaveCannon", "TitanShield", "TitanArray")
    fields(caps, allowed, "core_level_caps", required=("TitanShield", "TitanArray"))
    require(any(key in caps for key in allowed[:3]), "At least one ordinary weapon must be unlocked")
    for key, value in caps.items():
        integer(value, f"core_level_caps.{key}")
    require(caps["TitanArray"] >= reference_level, "Array level cap is below the reference level")

    upgrades = {**catalog.tables["upgrades"], **catalog.tables["upgrades2"]}
    core_upgrades = {tier["upgrade"] for row in catalog.cores.values() for tier in row["tiers"]}
    hook_only_sources = []

    def walk(value, table, owner):
        if isinstance(value, dict):
            target = value.get("target")
            kind = value.get("modifier_type")
            if target in ("titan_damage", "titan_max_shields") and value.get("global_hook") not in (None, "", "global") and table != "core_milestones":
                hook_only_sources.append({"table": table, "id": owner, "target": target,
                                          "hook": value["global_hook"]})
            if target in ("titan_damage", "titan_max_shields") and kind in ("Flat", "Additive"):
                is_core = table in ("upgrades", "upgrades2") and owner in core_upgrades
                is_local_milestone = table == "core_milestones" and value.get("global_hook") != "global"
                require(is_core or is_local_milestone,
                        f"Summary division needs review: nonmultiplicative source {table}/{owner}/{target}")
            if target == "array_charge_rate" and kind is not None:
                require(table == "upgrades2" and owner in ("VSArrayChargeRateAntumbra", "VSArrayChargeRateConverged"),
                        f"External charge-rate source needs an extra input: {table}/{owner}")
            for child in value.values():
                walk(child, table, owner)
        elif isinstance(value, list):
            for child in value:
                walk(child, table, owner)

    for table, rows in catalog.tables.items():
        for owner, row in rows.items():
            walk(row, table, owner)

    # Only these known data expressions are supported. Never eval game expressions in Python.
    combat_expression = "max(pow(1.8,log([x])/log(10))-1,0)"
    if catalog.enemy_alignment:
        require('VSCombatAlignmentAntumbra' not in upgrades and 'VSCombatAlignmentPenumbra' not in upgrades,
                'Changed alignment model: player bonuses unexpectedly coexist with enemy reduction')
        veil = re.sub(r'\s+', '', catalog.text('VeilController.gd'))
        require('reduce=max(pow(1.8,log(reduce)/log(10)),1)' in veil,
                'Changed alignment reduction formula')
        section = catalog.text('interface/veil_shift/VeilSection.gd')
        require('auc_array.apply_umbra = true' in section, 'Changed Umbra array layer effects')
        converged = catalog.text('interface/veil_shift/ConvergedVeilSection.gd')
        require('VSArrayCapacityConverged' not in converged and 'VSArrayChargeRateConverged' not in converged,
                'Changed Umbra array effects: possible duplicate modifiers')
    for name in (() if catalog.enemy_alignment else ("VSCombatAlignmentAntumbra", "VSCombatAlignmentPenumbra")):
        effects = upgrades[name]["effect"]
        require({e["target"] for e in effects} == {"titan_damage", "titan_max_shields"},
                f"Changed combat alignment effects: {name}")
        require(all(e["modifier_type"] == "Multiplicative" and e["expression"] == combat_expression
                    and e["base_effect"] == 0 and not e["self_multiplicative"] for e in effects),
                f"Changed alignment formula: {name}")

    def layer_multiplier(upgrade_id, target, expression):
        effects = upgrades[upgrade_id]["effect"]
        require(len(effects) == 1 and effects[0]["target"] == target
                and effects[0]["modifier_type"] == "Multiplicative"
                and effects[0]["expression"] == expression and effects[0]["base_effect"] == 0
                and not effects[0]["self_multiplicative"], f"Changed layer effect: {upgrade_id}")
        return 1 + float(expression)

    cap_mult = {"surface": 1.0, "antumbra": 1.0,
                "penumbra": layer_multiplier("VSArrayCapacityPenumbra", "array_capacity", "0.2"),
                "umbra": layer_multiplier("VSArrayCapacityPenumbra" if catalog.enemy_alignment else "VSArrayCapacityConverged", "array_capacity", "0.2")}
    rate_mult = {"surface": 1.0, "penumbra": 1.0,
                 "antumbra": layer_multiplier("VSArrayChargeRateAntumbra", "array_charge_rate", "0.1"),
                 "umbra": layer_multiplier("VSArrayChargeRateAntumbra" if catalog.enemy_alignment else "VSArrayChargeRateConverged", "array_charge_rate", "0.1")}
    combat_mult = {"surface": 1.0, "umbra": 1.0}
    for name, value in alignment.items():
        combat_mult[name] = 1.0 if catalog.enemy_alignment else max(1.0, value ** (math.log(1.8) / math.log(10)))

    local_capacity = 0
    for rows in catalog.milestones("TitanArray", reference_level).values():
        require(len(rows) == 1, "Array has optional milestones; reference selection now required")
        for effect in rows[0]["effect"]:
            if effect["target"] == "array_capacity":
                require(effect["modifier_type"] == "Flat" and not effect.get("expression")
                        and effect["global_hook"] == "global", "Changed array capacity milestone")
                local_capacity += effect["base_effect"]

    external = {}
    for stat in ("titan_damage", "titan_max_shields"):
        base = positive(catalog.tables["stats"][stat]["base"], f"{stat}.base")
        external[stat] = stats[stat] / base / combat_mult[layer]
    capacity_without_core = stats["array_capacity"] / cap_mult[layer] - local_capacity
    positive(capacity_without_core, "normalized capacity", allow_zero=True)
    rate_base = positive(catalog.tables["stats"]["array_charge_rate"]["base"], "array_charge_rate.base")
    array_calibration = None
    if "reference_array_base_damage" in snapshot:
        observed = positive(snapshot["reference_array_base_damage"], "reference_array_base_damage")
        array = catalog.cores["TitanArray"]
        damage = catalog.tables["weapons"][array["weapon"]]["damage"]
        tier = array["tiers"][0]
        for effect in upgrades[tier["upgrade"]]["effect"]:
            require(effect["target"] == "titan_damage" and effect["modifier_type"] == "Flat"
                    and not effect.get("expression") and not effect.get("direct_connection")
                    and not effect.get("self_multiplicative") and not effect.get("global_hook"),
                    "Array level formula changed; calibration needs review")
            damage += effect["base_effect"] * reference_level
        for rows in catalog.milestones("TitanArray", reference_level).values():
            for effect in rows[0]["effect"]:
                if effect["target"] == "titan_damage":
                    require(effect["modifier_type"] == "Multiplicative" and not effect.get("expression")
                            and not effect.get("direct_connection") and not effect.get("self_multiplicative")
                            and not effect.get("global_hook"), "Array damage milestone changed")
                    damage *= 1 + effect["base_effect"]
        expected_without_hook = damage * external["titan_damage"] * combat_mult[layer]
        positive(expected_without_hook, "reference array expected damage")
        array_calibration = {
            "array_only_multiplier": observed / expected_without_hook,
            "unscaled_reference_damage": damage,
            "reference_damage_without_array_hook": expected_without_hook,
            "observed_base_damage": observed,
            "note": "Use the core Base Damage, not the sequence total. UI rounding is retained.",
        }
    return {
        "status": "RESEARCH_ONLY", "combat_verified": False,
        "input_kind": "global_statistics_summary_not_equipped_core_stats",
        "game_version": catalog.version,
        "alignment_model": 'enemy_reduction' if catalog.enemy_alignment else 'player_multiplier',
        "alignment": dict(alignment),
        "external_combat_multipliers": external,
        "capacity_before_array_core_milestones_and_layer": capacity_without_core,
        "array_charge_rate_before_layer": rate_base,
        "array_calibration": array_calibration,
        "layer_multipliers": {name: {"combat": combat_mult[name], "capacity": cap_mult[name],
                                     "charge_rate": rate_mult[name]} for name in LAYERS},
        "core_level_caps": dict(caps), "reference_snapshot": snapshot,
        "hook_only_sources_not_in_summary": hook_only_sources,
        "ready_for_combat": False,
        "source_sha256": catalog.hashes,
        "limitations": ["Rounded UI inputs retain their original uncertainty.",
                        "Depth/global progression is already included; do not multiply it again.",
                        "No native combat validation, resource affordability, or region access check.",
                        "Array-only bonus calibrated from core Base Damage." if array_calibration else
                        "Array-only bonus is unknown; reference_array_base_damage is required before combat.",
                        "Additional non-default combat stats/ability modifiers still require runtime audit."],
    }
