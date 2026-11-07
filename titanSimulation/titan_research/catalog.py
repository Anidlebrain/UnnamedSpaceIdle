"""Read game definitions, never saves. No formulas or combat scoring here."""

from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re


LAYERS = {"surface": 0, "antumbra": 1, "penumbra": 2, "umbra": 3}
EVIDENCE_FILES = (
    "game_data.cdb", "DBImport.gd", "PlayerInfo.gd", "UpgradeHelper.gd",
    "VeilController.gd", "battle/BattleArea.gd", "battle/Turret.gd",
    "battle/VeilShader.gd", "battle/VeilShader.tscn",
    "battle/TitanArrayTurret.gd", "player/PlayerShip.gd",
    "player/AbilityButton.gd", "player/AbilityArea.gd",
    "enemies/WaveSpawner.gd", "enemies/ColossalEnemy.gd",
    "enemies/colossal/ColossalPart.gd", "enemies/TitanEnemy.gd",
    "upgrades/CoreUpgrade.tscn", "upgrades/CoreTargetMenu.gd",
    "upgrades/CoreMilestonesArea.gd", "upgrades/CoreMilestoneIcon.gd",
    "interface/titan_weapon/TitanArrayArea.gd",
    "interface/titan_weapon/ActiveTitanElementList.gd",
    "interface/titan_weapon/TitanElement.gd",
    "interface/prestige/ShipLoadout.gd",
    "interface/veil_shift/AlignmentUpgrade.gd",
    "interface/veil_shift/VeilCoreUpgrade.gd",
    "interface/veil_shift/VeilSection.gd", "interface/veil_shift/ConvergedVeilSection.gd",
    "interface/stats/SummaryStatPanelInfo.gd", "interface/stats/StatPanel.gd",
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def integer(value, name, minimum=0):
    require(type(value) is int and value >= minimum,
            f"{name} must be an integer >= {minimum}")
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path):
    def reject_constant(value):
        raise ValueError(f"Non-finite JSON value: {value}")
    return json.loads(Path(path).read_text(encoding="utf-8-sig"),
                      object_pairs_hook=unique_object,
                      parse_constant=reject_constant)


class Catalog:
    def __init__(self, source):
        self.source = Path(source).resolve()
        self.hashes = {}
        for relative in EVIDENCE_FILES:
            data = (self.source / relative).read_bytes()
            self.hashes[relative] = hashlib.sha256(data).hexdigest()
        db = read_json(self.source / "game_data.cdb")
        self.tables = {}
        for sheet in db["sheets"]:
            if "@" in sheet["name"]:
                continue
            rows = {row["id"]: row for row in sheet["lines"]}
            require(len(rows) == len(sheet["lines"]), f"Duplicate IDs in {sheet['name']}")
            self.tables[sheet["name"]] = rows
        version = re.search(r'var version = "([^"]+)"', self.text('PlayerInfo.gd'))
        require(version is not None, 'Cannot identify game version')
        self.version = version[1]
        require(self.version in ('0.85.1.0', '0.90.0.1'),
                f'Game version {self.version} needs compatibility verification')
        self.enemy_alignment = self.version == '0.90.0.1'
        # Match DBImport.set_data: the second sheet extends the same native registry.
        if 'ships2' in self.tables:
            require(not (self.tables['ships'].keys() & self.tables['ships2'].keys()), 'Duplicate ship IDs across sheets')
            self.tables['ships'].update(self.tables['ships2'])
        self.cores = self.tables["cores"]
        self.elements = self.tables["titan_elements"]
        self.ship = self.tables["main_ships"]["Titan"]
        self.targeting = self._read_targeting()
        # Fail on enum drift rather than silently assigning wrong layer numbers.
        veil = self.text("VeilController.gd")
        require(re.search(r"enum Layer\s*\{SURFACE,\s*ANTUMBRA,\s*PENUMBRA,\s*UMBRA\}", veil),
                "Unsupported Layer enum; review source mapping")
        part = self.text("enemies/colossal/ColossalPart.gd")
        match = re.search(r"enum System\s*\{([^}]+)\}", part)
        require(match is not None, "Missing ColossalPart.System")
        self.systems = [item.strip() for item in match[1].split(",")]
        require(all(re.fullmatch(r"[A-Z_]+", item) for item in self.systems),
                "Unsupported explicit System enum values")

    def text(self, name):
        return (self.source / name).read_text(encoding="utf-8-sig")

    def _read_targeting(self):
        scene = self.text("upgrades/CoreUpgrade.tscn")
        result = {}
        for field, node in (("type", "GridTargetTypePriority"),
                            ("priority", "GridTargetPriority"),
                            ("swapping", "GridTargetSwapping"),
                            ("overlap", "GridTargetOverlap")):
            match = re.search(r'\[node name="' + node + r'"[^\n]*\]\n(.*?)(?=\n\[|\Z)',
                              scene, re.S)
            require(match is not None, f"Missing target menu: {node}")
            values = re.search(r"button_texts = (\[[^\n]+\])", match[1])
            require(values is not None, f"Missing target values: {node}")
            result[field] = json.loads(values[1])
        script = self.text("upgrades/CoreTargetMenu.gd")
        optimize = script.split('if type == "Optimize":', 1)[1].split('elif type == "CapitalParts":', 1)[0]
        result["type"] += re.findall(r'_add_button\("([^"\n]+)"\)', optimize)
        aoe = script.split("func add_aoe_options()", 1)[1].split("\nfunc ", 1)[0]
        result["aoe_priority"] = re.findall(r'_add_button\("([^"\n]+)"\)', aoe)
        return result

    def milestones(self, core_id, level=None, tier=1):
        groups = defaultdict(list)
        for row in self.tables["core_milestones"].values():
            if row["parent_core"] != core_id:
                continue
            if row.get("tiers") and str(tier) not in row["tiers"]:
                continue
            threshold = row["core_levels_required"]
            if level is None or threshold <= level:
                groups[str(threshold)].append(deepcopy(row))
        return dict(groups)

    def region(self, sector, layer):
        require(layer in LAYERS, f"Unknown layer: {layer}")
        matches = [row for row in self.tables["sectors"].values()
                   if str(row["order"]) + row.get("route", "").upper() == str(sector).upper()
                   or row["id"] == str(sector)]
        require(len(matches) == 1, f"Sector must resolve uniquely: {sector}")
        region = matches[0]
        require(region["order"] >= 160, "Research scope is sector 160+")
        layer_id = LAYERS[layer]

        def visible(row):
            return layer_id == 3 or row["veil"] in (0, layer_id)

        boss = self.tables["ships"][region["boss"]]
        parts = [deepcopy(row) for row in boss["colossal_parts"] if visible(row)]
        counts = Counter()
        targets = []
        for part in parts:
            system = integer(part["system"], "part.system")
            require(system < len(self.systems), "Unknown part system")
            counts[system] += 1
            targets.append({"id": f"{system}:{counts[system]}",
                            "system": self.systems[system], "number": counts[system]})
        return {
            "sector": region["order"], "sector_id": region["id"], "layer": layer,
            "distance_start": region["distance_starts"],
            "distance_end": region["distance_ends"],
            "boss_id": region["boss"], "boss_parts": parts, "array_targets": targets,
            "enemies": [deepcopy(row) for row in region["enemies"] if visible(row)],
            "scaling_expression": region["titan_scaling"],
            "player_access_checked": False,
            "effective_layer_checked": False,
            "note": "Requested layer only; Umbra boundary and boss access require player progress. No final enemy stats calculated.",
        }

    def report(self, sector, layer):
        cores = {key: deepcopy(row) for key, row in self.cores.items()
                 if row["slot_type"] == "Titan"}
        return {
            "status": "RESEARCH_ONLY", "combat_verified": False,
            "game_version": self.version,
            "source_sha256": self.hashes,
            "ship": deepcopy(self.ship), "cores": cores,
            "milestones": {key: self.milestones(key) for key in cores},
            "weapons": {row["weapon"]: deepcopy(self.tables["weapons"][row["weapon"]])
                        for row in cores.values() if row.get("weapon")},
            "array_elements": deepcopy(self.elements),
            "targeting": deepcopy(self.targeting), "region": self.region(sector, layer),
        }
