"""Structural constraints only: passing does not imply affordability or victory."""

from collections import Counter
import math
from .catalog import integer, require


def fields(value, allowed, name, required=None):
    require(isinstance(value, dict), f"{name} must be an object")
    require(set(value) <= set(allowed), f"Unknown fields in {name}: {set(value) - set(allowed)}")
    require(set(required if required is not None else allowed) <= set(value),
            f"Missing fields in {name}")


def check_candidate(catalog, region, candidate):
    fields(candidate, ("weapons", "shield", "array_core", "array_capacity", "sequence"), "candidate")
    slots = [slot for slot in catalog.ship["core_slots"] if slot["type"] == "Weapon"]
    require(isinstance(candidate["weapons"], list) and len(candidate["weapons"]) == len(slots),
            f"Expected {len(slots)} ordered weapon slots")
    inventory = Counter()
    selected_ids = []

    def core(entry, expected, name):
        keys = ("id", "level", "milestones", "targeting") if expected == "Weapon" else ("id", "level", "milestones")
        fields(entry, keys, name)
        require(entry["id"] in catalog.cores, f"Unknown core: {entry['id']}")
        row = catalog.cores[entry["id"]]
        require(row["slot_type"] == "Titan" and row["type"] == expected,
                f"Wrong core slot: {name}")
        level = integer(entry["level"], f"{name}.level")
        groups = catalog.milestones(entry["id"], level)
        choices = entry["milestones"]
        require(isinstance(choices, dict), f"{name}.milestones must be an object")
        require(set(choices) <= set(groups), f"Locked or unknown milestone in {name}")
        for threshold, rows in groups.items():
            if len(rows) == 1:
                chosen = choices.get(threshold, rows[0]["id"])
            else:
                require(threshold in choices, f"Choose one milestone at {name} level {threshold}")
                chosen = choices[threshold]
            require(chosen in [item["id"] for item in rows], f"Wrong milestone {chosen} for {name}")
            selected_ids.append(chosen)
            selected = next(item for item in rows if item["id"] == chosen)
            for effect in selected["effect"]:
                if effect["modifier_type"] == "TitanElement":
                    # Native _update_titan_element_counts adds one per active contributor.
                    inventory[effect["target"]] += 1
        if row.get("titan_element"):
            inventory[row["titan_element"]] += 1
        return row

    for index, weapon in enumerate(candidate["weapons"]):
        row = core(weapon, "Weapon", f"weapons[{index}]")
        require(row["id"] != "TitanArray", "TitanArray is a separate automatic core, not a weapon slot")
        targeting = weapon["targeting"]
        fields(targeting, ("type", "priority", "swapping", "overlap"), "targeting")
        for key, value in targeting.items():
            options = list(catalog.targeting[key])
            if key == "priority" and catalog.tables["weapons"][row["weapon"]]["aoe_size"] > 0:
                options += catalog.targeting["aoe_priority"]
            require(value in options, f"Unsupported {row['id']} targeting {key}: {value}")
    core(candidate["shield"], "Shield", "shield")
    array = candidate["array_core"]
    fields(array, ("id", "level", "milestones"), "array_core")
    require(array["id"] == "TitanArray", "Expected the automatic TitanArray core")
    # Array core has no normal turret targeting controls.
    core({**array, "targeting": {}}, "Weapon", "array_core")
    for element_id in inventory:
        require(element_id in catalog.elements, f"Unknown unlocked element: {element_id}")
        if catalog.elements[element_id].get("ability_id"):
            inventory[element_id] = min(1, inventory[element_id])
    capacity = candidate["array_capacity"]
    require(type(capacity) in (int, float) and math.isfinite(capacity) and capacity >= 0,
            "array_capacity must be a finite non-negative number")
    require(isinstance(candidate["sequence"], list) and candidate["sequence"], "sequence must be non-empty")
    allowed_targets = {target["id"] for target in region["array_targets"]}
    used = Counter()
    cost = 0
    shots = 0
    for element in candidate["sequence"]:
        fields(element, ("id", "targets"), "sequence element")
        element_id = element["id"]
        require(element_id in catalog.elements, f"Unknown element: {element_id}")
        row = catalog.elements[element_id]
        used[element_id] += 1
        require(used[element_id] <= inventory[element_id], f"Element unavailable/exhausted: {element_id}")
        cost += row["cost"]
        targets = element["targets"]
        require(isinstance(targets, list) and all(isinstance(t, str) for t in targets), "targets must be strings")
        require(len(targets) == len(set(targets)), "Duplicate priority target")
        require(set(targets) <= allowed_targets, "Target does not exist in the requested layer")
        if row.get("weapon_id"):
            shots += 1
        else:
            require(not targets, "Only attack elements have target settings")
    require(shots > 0, "At least one attack element is required for this research candidate")
    require(cost <= capacity, f"Array capacity exceeded: {cost} > {capacity}")
    return {
        "status": "RESEARCH_ONLY", "structurally_valid": True, "combat_verified": False,
        "player_unlocks_checked": False, "affordability_checked": False,
        "capacity_source": "caller_supplied_not_recalculated",
        "array_capacity_used": cost, "array_capacity": capacity,
        "element_inventory": dict(inventory), "selected_milestones": selected_ids,
        "region": region, "candidate": candidate, "source_sha256": catalog.hashes,
    }
