extends RefCounted
## Original upgrades2 UnlockFleetShipMod targets and fleet_mods slots, 0.90.0.1.
const DEFINITIONS := {
	"CorvetteRapidFire": {"galaxy": 11, "ship": "Corvette", "slot": 2},
	"CorvetteChargeLaserBurst": {"galaxy": 11, "ship": "Corvette", "slot": 0},
	"FrigateHealthBoost": {"galaxy": 12, "ship": "Frigate", "slot": 2},
	"FrigateRapidMissileMod": {"galaxy": 12, "ship": "Frigate", "slot": 0},
	"FighterBarrier": {"galaxy": 13, "ship": "Fighter", "slot": 2},
	"FighterJumpGatling": {"galaxy": 13, "ship": "Fighter", "slot": 0},
}


static func is_primary(mod_id) -> bool:
	return mod_id is String and mod_id in DEFINITIONS and DEFINITIONS[mod_id].slot == 0


static func loadout_error(ship: String, mod_id, slot: int, unlocked: Array) -> String:
	if not mod_id is String or mod_id not in DEFINITIONS:
		return ""
	var definition: Dictionary = DEFINITIONS[mod_id]
	if ship != definition.ship or slot != definition.slot:
		return "%s requires %s slot %d" % [mod_id, definition.ship, definition.slot]
	if mod_id not in unlocked:
		return "%s is not unlocked; enable it in G%d common.json.galaxy_mods or change the loadout" % [mod_id, definition.galaxy]
	return ""
