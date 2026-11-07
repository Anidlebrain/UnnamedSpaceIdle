extends Node
## 0.90 native data, scoped unlocks and combat replay; synthetic player only.
const Mods = preload("res://fleet_galaxy_mods.gd")
var checks: Array = []


func check(label: String, passed: bool, evidence = null) -> void:
	checks.append({"label": label, "passed": passed, "evidence": evidence})
	print("RUNTIME_REGRESSION %s %s" % [label, "PASS" if passed else "FAIL"])


func friendly(galaxy: int, node: String, ship: String = "Frigate") -> Dictionary:
	return {"galaxy": galaxy, "node": node, "formation_columns": 3 if node == ("B21" if galaxy == 12 else "B18") else 2,
		"boss": {"alive": false}, "hazards": [], "supports": [],
		"player_state": {"fleet_resources": 10000, "damage_scale": 10, "health_scale": 10,
			"ships": {"Fighter": 5, "Corvette": 5, "Frigate": 5, "Cruiser": 5, "HeavyCruiser": 5}},
		"baseline": {"enabled": true, "formation": {"A3": ship}, "loadouts": {ship: {"primary": null, "secondary": null}}}}


func run(probe: Node) -> Dictionary:
	var resolver := preload("res://friendly_config_resolver.gd").new()
	add_child(resolver)
	var optimizer := preload("res://fleet_optimizer_search.gd").new()
	add_child(optimizer)
	check("native game version", PlayerInfo.version == "0.90.0.1", PlayerInfo.version)
	for galaxy in [12, 13]:
		var names: Array = ["BB1"]
		for index in range(1, 22 if galaxy == 12 else 19):
			if galaxy == 13 and index == 3:
				names.append_array(["B3A", "B3B"])
			else:
				names.append("B%d" % index)
		for node in names:
			var resolved: Dictionary = resolver.resolve(friendly(galaxy, node))
			check("G%d %s resolves native battle" % [galaxy, node], resolved.ok, resolved.get("error"))
		var boss := friendly(galaxy, "BB1")
		boss.boss = {"alive": true, "remaining_hp": 1, "priority": "affordable_kill_cost"}
		boss.player_state.damage_scale = 1000
		boss.player_state.health_scale = 1000
		var resolved: Dictionary = resolver.resolve(boss)
		check("G%d live boss HP and objective" % galaxy, resolved.ok and resolved.config.boss_health == 1 and resolved.config.optimizer.objective == "boss")
		if resolved.ok:
			resolved.config.formation = [{"ship": "Frigate", "grid_position": [0, 2], "primary_mod": null, "secondary_mod": null}]
			var battle: Dictionary = await probe.run_battle(resolved.config)
			check("G%d native boss battle" % galaxy, battle.get("error", "") == "" and battle.boss_damage == 1, battle.get("outcome"))
			await probe.cleanup_battle()
		var last := friendly(galaxy, "B21" if galaxy == 12 else "B18")
		last.formation_columns = 2
		check("G%d three-column mismatch rejected" % galaxy, not resolver.resolve(last).ok)
	for galaxy in [12, 13]:
		var ship := "Frigate" if galaxy == 12 else "Fighter"
		var tertiary := "FrigateHealthBoost" if galaxy == 12 else "FighterBarrier"
		var primary := "FrigateRapidMissileMod" if galaxy == 12 else "FighterJumpGatling"
		var input := friendly(galaxy, "B1", ship)
		var common := {"galaxy_mods": [tertiary, primary], "permanent": {"damage_scale": 10, "health_scale": 10}, "temporary": {"damage_scale": 0, "health_scale": 0}}
		input.baseline.loadouts[ship].primary = primary
		check("G%d locked TM rejected" % galaxy, not resolver.resolve(input).ok)
		var on: Dictionary = resolver.resolve(input, common)
		check("G%d unlocks resolve" % galaxy, on.ok, on.get("error"))
		var wrong := input.duplicate(true)
		wrong.galaxy = 11
		check("G%d cross-galaxy unlock rejected" % galaxy, not resolver.resolve(wrong, common).ok)
		wrong = input.duplicate(true)
		wrong.baseline.loadouts[ship] = {"primary": null, "secondary": primary}
		check("G%d wrong TM slot rejected" % galaxy, not resolver.resolve(wrong, common).ok)
		wrong.baseline.loadouts[ship] = {"primary": null, "secondary": null, "tertiary_mods": [primary]}
		check("G%d TM in tertiary rejected" % galaxy, not resolver.resolve(wrong, common).ok)
		wrong.baseline.loadouts[ship].tertiary_mods = [tertiary]
		check("G%d explicit locked tertiary rejected" % galaxy, not resolver.resolve(wrong).ok)
		input.baseline.loadouts[ship].primary = null
		var off: Dictionary = resolver.resolve(input)
		if not on.ok or not off.ok:
			continue
		var public_slots := {ship: {"primary": [null, primary], "secondary": [null]}}
		var original_slots := public_slots.duplicate(true)
		var battles: Array = []
		for enabled in [false, true, false]:
			var config: Dictionary = (on.config if enabled else off.config).duplicate(true)
			optimizer._base_config = config
			optimizer._settings = {"ship_types": [ship]}
			optimizer._settings.allowed_loadouts = optimizer._expand_slot_loadouts(public_slots)
			optimizer._apply_galaxy_primary_unlocks()
			check("G%d TM candidates enabled=%s" % [galaxy, enabled], optimizer._settings.allowed_loadouts[ship].any(func(choice): return choice.primary_mod == primary) == enabled)
			config.formation = [{"ship": ship, "grid_position": [0, 2], "primary_mod": primary if enabled else null, "secondary_mod": null}]
			await probe.quote_player_deployment(config, true)
			var native_mods: Array = Fleet.get_ship_mods(ship)
			check("G%d native slots enabled=%s" % [galaxy, enabled], (tertiary in native_mods) == enabled and (primary in native_mods) == enabled, native_mods)
			if enabled and galaxy == 12:
				check("G12 native Dampening Field ability", Fleet.get_fleet_ship_with_mods(ship).ability == "G12DampeningField")
			var battle: Dictionary = await probe.run_battle(config)
			check("G%d actual Mod battle enabled=%s" % [galaxy, enabled], battle.get("error", "") == "" and not battle.player_ships.is_empty() and battle.player_ships.all(func(s): return (tertiary in s.mods) == enabled))
			battles.append({"outcome": battle.outcome, "used_fr": battle.fleet_resources_used, "ships": battle.player_ships, "time": battle.simulation_time})
			await probe.cleanup_battle()
		check("G%d switch off restores exact combat" % galaxy, battles[0] == battles[2])
		check("G%d numeric selector array unchanged" % galaxy, public_slots == original_slots)
		check("G%d cache key separates unlocks" % galaxy, optimizer._battle_environment_key(on.config) != optimizer._battle_environment_key(off.config))
	# Cover every new effect type, including 0.90 force_team on a hostile source.
	for fixture in [[12, "B2", [], ["PF1"]], [12, "B3", [], ["PF1"]], [12, "B4", [], ["PF1"]],
		[12, "B6", ["B6"], []], [12, "B18", ["B18"], []], [12, "B21", [], []], [13, "B10", ["B10"], []], [13, "B18", [], ["PF1"]]]:
		var input := friendly(fixture[0], fixture[1])
		input.hazards = fixture[2]
		input.supports = fixture[3]
		var resolved: Dictionary = resolver.resolve(input)
		check("G%d %s effect resolution" % [fixture[0], fixture[1]], resolved.ok)
		if not resolved.ok:
			continue
		var config: Dictionary = resolved.config
		config.formation = [{"ship": "Frigate", "grid_position": [int(config.grid_size[0]) - 1, 2], "primary_mod": null, "secondary_mod": null}]
		var battle: Dictionary = await probe.run_battle(config)
		check("G%d %s native effect/grid battle" % [fixture[0], fixture[1]], battle.get("error", "") == "", battle.get("outcome"))
		if fixture[0] == 13 and fixture[1] == "B10":
			check("G13 force_team applies buff to player", battle.runtime_effect_events.any(func(e): return e.type == "grid_buff" and e.team == Fleet.Team.LEFT))
		await probe.cleanup_battle()
	optimizer.queue_free()
	resolver.queue_free()
	return {"passed": checks.all(func(c): return c.passed), "checks": checks, "game_version": PlayerInfo.version}
