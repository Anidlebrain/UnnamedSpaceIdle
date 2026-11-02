extends Node
## Uses only the isolated original FleetBattle runtime, never a player save.

var checks: Array = []


func _check(label: String, passed: bool, evidence = null) -> void:
	checks.append({"label": label, "passed": passed, "evidence": evidence})
	print("GALAXY_MOD_REGRESSION %s %s" % [label, "PASS" if passed else "FAIL"])


func run(probe: Node) -> Dictionary:
	var resolver := preload("res://friendly_config_resolver.gd").new()
	add_child(resolver)
	var friendly := {"galaxy": 11, "node": "B1", "boss": {"alive": false},
		"hazards": [], "player_state": {"fleet_resources": 200, "ships": {"Corvette": 1}},
		"baseline": {"enabled": true, "formation": {"A3": "Corvette"},
			"loadouts": {"Corvette": {"primary": "CorvetteChargeLaserMod", "secondary": "ShieldMod"}}}}
	var common := {"permanent": {"damage_scale": 10.0, "health_scale": 10.0},
		"temporary": {"damage_scale": 0.0, "health_scale": 0.0}}
	var off: Dictionary = resolver.resolve(friendly, common)
	_check("legacy common defaults to no unlock", off.ok and off.config.galaxy_mods.is_empty())
	common["galaxy_mods"] = ["CorvetteRapidFire", "CorvetteRapidFire"]
	var on: Dictionary = resolver.resolve(friendly, common)
	_check("G11 common resolves and deduplicates CRF", on.ok and on.config.galaxy_mods == ["CorvetteRapidFire"])
	for invalid in ["CorvetteRapidFire", ["unknown"], [1]]:
		var bad := common.duplicate(true)
		bad.galaxy_mods = invalid
		_check("invalid unlock rejected: %s" % str(invalid), not resolver.resolve(friendly, bad).ok)
	var other := friendly.duplicate(true)
	other.galaxy = 6
	_check("CRF outside G11 rejected", not resolver.resolve(other, common).ok)
	if not off.ok or not on.ok:
		return {"passed": false, "checks": checks}
	var formation := [{"ship": "Corvette", "grid_position": [0, 2],
		"primary_mod": "CorvetteChargeLaserMod", "secondary_mod": "ShieldMod", "tertiary_mods": []}]
	var battles := []
	for enabled in [false, true, false]:
		var config: Dictionary = (on.config if enabled else off.config).duplicate(true)
		config.formation = formation.duplicate(true)
		var quote: Dictionary = await probe.quote_player_deployment(config, true)
		var mods: Array = Fleet.get_ship_mods("Corvette")
		var stats: Dictionary = Fleet.get_fleet_ship_with_mods("Corvette")
		_check("native Mod state enabled=%s" % str(enabled), mods.has("CorvetteRapidFire") == enabled, mods)
		_check("native ability enabled=%s" % str(enabled), (stats.get("ability", "") == "G11RapidFire") == enabled, stats.get("ability"))
		_check("Primary and Secondary retained", mods.has("CorvetteChargeLaserMod") and mods.has("ShieldMod"))
		var battle: Dictionary = await probe.run_battle(config)
		var players: Array = battle.get("player_ships", [])
		var snapshots_match := not players.is_empty()
		for ship in players:
			snapshots_match = snapshots_match and (ship.mods.has("CorvetteRapidFire") == enabled)
		_check("actual battle snapshots enabled=%s" % str(enabled), snapshots_match and str(battle.get("error", "")) == "")
		battles.append({"enabled": enabled, "quote": quote, "outcome": battle.get("outcome"),
			"used_fr": battle.get("fleet_resources_used"), "simulation_time": battle.get("simulation_time")})
		await probe.cleanup_battle()
	_check("turning off restores native battle result", battles[0].used_fr == battles[2].used_fr and battles[0].simulation_time == battles[2].simulation_time, battles)
	var optimizer := preload("res://fleet_optimizer_search.gd").new()
	add_child(optimizer)
	_check("cache environment distinguishes unlock", optimizer._battle_environment_key(on.config) != optimizer._battle_environment_key(off.config))
	await _run_tm(probe, resolver, optimizer, friendly, common)
	optimizer.queue_free()
	resolver.queue_free()
	return {"passed": checks.all(func(check): return check.passed), "checks": checks, "battles": battles}


func _run_tm(probe: Node, resolver: Node, optimizer: Node, friendly: Dictionary, common: Dictionary) -> void:
	var tm_common := common.duplicate(true)
	tm_common.galaxy_mods = ["CorvetteRapidFire", "CorvetteChargeLaserBurst"]
	var tm_input := friendly.duplicate(true)
	tm_input.baseline.loadouts.Corvette.primary = "CorvetteChargeLaserBurst"
	var resolved: Dictionary = resolver.resolve(tm_input, tm_common)
	_check("TM and CRF resolve independently", resolved.ok and resolved.config.galaxy_mods.size() == 2)
	_check("locked TM baseline is rejected", not resolver.resolve(tm_input, common).ok)
	var other := tm_input.duplicate(true)
	other.galaxy = 6
	_check("TM cannot be equipped in another Galaxy", not resolver.resolve(other, {}).ok)
	var wrong := tm_input.duplicate(true)
	wrong.baseline.loadouts.Corvette = {"primary": null, "secondary": "CorvetteChargeLaserBurst"}
	_check("TM secondary slot is rejected", not resolver.resolve(wrong, tm_common).ok)
	var public_slots := {"Corvette": {"primary": [null, "CorvetteChargeLaserMod"], "secondary": [null, "ShieldMod"]}}
	var saved_slots := public_slots.duplicate(true)
	if not resolved.ok:
		return
	optimizer._settings = {"ship_types": ["Corvette"]}
	for enabled in [false, true]:
		optimizer._base_config = resolved.config.duplicate(true)
		optimizer._base_config.galaxy_mods = tm_common.galaxy_mods if enabled else []
		optimizer._settings.allowed_loadouts = optimizer._expand_slot_loadouts(public_slots)
		optimizer._apply_galaxy_primary_unlocks()
		var choices: Array = optimizer._settings.allowed_loadouts.Corvette
		_check("TM candidate expansion enabled=%s" % str(enabled), choices.size() == (6 if enabled else 4), choices)
		_check("TM candidate gating enabled=%s" % str(enabled), choices.any(func(choice): return choice.primary_mod == "CorvetteChargeLaserBurst") == enabled)
	_check("TM never changes public numeric mapping", public_slots == saved_slots)
	var legacy_slots := public_slots.duplicate(true)
	legacy_slots.Corvette.primary = [null, "CorvetteChargeLaserBurst", "CorvetteChargeLaserMod"]
	var numeric := tm_input.duplicate(true)
	numeric.baseline.loadouts.Corvette.primary = 2
	var numeric_result: Dictionary = resolver.resolve(numeric, common, legacy_slots)
	_check("existing public numeric index preserved", numeric_result.ok and numeric_result.config.optimizer.baseline.loadouts.Corvette.primary == "CorvetteChargeLaserMod")
	numeric.baseline.loadouts.Corvette.primary = 1
	_check("numeric TM cannot bypass trip lock", not resolver.resolve(numeric, common, legacy_slots).ok)
	optimizer._base_config.galaxy_mods = []
	optimizer._settings.allowed_loadouts = optimizer._expand_slot_loadouts(legacy_slots)
	optimizer._apply_galaxy_primary_unlocks()
	_check("legacy global TM option filtered while locked", not optimizer._settings.allowed_loadouts.Corvette.any(func(choice): return choice.primary_mod == "CorvetteChargeLaserBurst"))
	optimizer._base_config.galaxy_id = "galaxy6"
	optimizer._base_config.galaxy_mods = ["CorvetteChargeLaserBurst"]
	optimizer._settings.allowed_loadouts = optimizer._expand_slot_loadouts(public_slots)
	optimizer._apply_galaxy_primary_unlocks()
	_check("other Galaxy never gains TM candidates", optimizer._settings.allowed_loadouts.Corvette.size() == 4)
	var config: Dictionary = resolved.config.duplicate(true)
	config.formation = [{"ship": "Corvette", "grid_position": [0, 2], "primary_mod": "CorvetteChargeLaserMod", "secondary_mod": "ShieldMod", "tertiary_mods": []}]
	await probe.quote_player_deployment(config, true)
	var normal: Dictionary = Fleet.get_fleet_ship_with_mods("Corvette")
	_check("TM unlock does not auto-equip TM", not Fleet.get_ship_mods("Corvette").has("CorvetteChargeLaserBurst"))
	await probe.cleanup_battle()
	config.formation[0].primary_mod = "CorvetteChargeLaserBurst"
	await probe.quote_player_deployment(config, true)
	var burst: Dictionary = Fleet.get_fleet_ship_with_mods("Corvette")
	var mods: Array = Fleet.get_ship_mods("Corvette")
	_check("TM replaces normal primary and retains shield plus CRF", mods == ["CorvetteChargeLaserBurst", "ShieldMod", "CorvetteRapidFire"], mods)
	var normal_weapon: Dictionary = normal.ship.weapons[0].weapon
	var burst_weapon: Dictionary = burst.ship.weapons[0].weapon
	_check("TM uses original burst and damage modifiers", is_equal_approx(float(burst_weapon.damage), float(normal_weapon.damage) * 0.75) and float(burst_weapon.burst_fire) == float(normal_weapon.burst_fire) + 1.0,
		{"normal": normal_weapon, "burst": burst_weapon})
	var battle: Dictionary = await probe.run_battle(config)
	_check("TM actual battle carries TM plus CRF", str(battle.get("error", "")) == "" and not battle.player_ships.is_empty() and battle.player_ships.all(func(ship): return "CorvetteChargeLaserBurst" in ship.mods and "CorvetteRapidFire" in ship.mods))
	await probe.cleanup_battle()
	config.galaxy_mods = []
	config.formation[0].primary_mod = "CorvetteChargeLaserMod"
	await probe.quote_player_deployment(config)
	_check("TM scope resets on next battle", not Fleet.get_fleet_ship_dict("Corvette").mods.has("CorvetteChargeLaserBurst"))
	await probe.cleanup_battle()
