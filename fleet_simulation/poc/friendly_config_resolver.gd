extends Node

const SHIP_NUMBER_TO_ID := {
	1: "Fighter",
	2: "Corvette",
	3: "Frigate",
	4: "Cruiser",
	5: "HeavyCruiser",
}


func resolve(friendly: Dictionary, common: Dictionary = {}, allowed_mod_slots: Dictionary = {}) -> Dictionary:
	for required in ["galaxy", "node", "boss", "hazards", "player_state"]:
		if not friendly.has(required):
			return _error("Missing Friendly Config field: %s" % required)
	if not friendly.hazards is Array:
		return _error("hazards must be an array of Fleet node names")
	var support_names = friendly.get("supports", [])
	if not support_names is Array:
		return _error("supports must be an array of Fleet node names")
	var galaxy_number := int(friendly.galaxy)
	var galaxy_id := "galaxy%d" % galaxy_number
	if galaxy_id not in Fleet.galaxy_nodes:
		return _error("Unknown galaxy in original Fleet data: %d" % galaxy_number)

	var node_name := str(friendly.node).strip_edges().to_upper()
	var fleet_event = _event_by_friendly_name(galaxy_id, node_name)
	if fleet_event == null:
		return _error("Unknown Fleet node in %s: %s" % [galaxy_id, node_name])
	var battle_id := str(fleet_event.stats.get("battle_requirement", ""))
	if battle_id == "" or battle_id not in Fleet.fleet_battles:
		return _error("Fleet node %s is not a battle node" % node_name)
	var battle: Dictionary = Fleet.fleet_battles[battle_id]

	var hazard_ids: Array = []
	var hazard_details: Array = []
	for hazard_name_value in friendly.hazards:
		var hazard_name := str(hazard_name_value).strip_edges().to_upper()
		var hazard_event = _event_by_friendly_name(galaxy_id, hazard_name)
		if hazard_event == null:
			return _error("Unknown Hazard node in %s: %s" % [galaxy_id, hazard_name])
		if hazard_event.type == Fleet.EventType.FRIENDLY_HAZARD:
			return _error("Fleet node %s is a Support; list it in supports" % hazard_name)
		var definitions: Array = hazard_event.check_node_effected_by_hazard(fleet_event, true)
		if definitions.is_empty():
			return _error("Hazard node %s does not affect %s in original data" % [hazard_name, node_name])
		var hazard_id := str(hazard_event.fleet_event)
		if hazard_id not in hazard_ids:
			hazard_ids.append(hazard_id)
			hazard_details.append({
				"node": hazard_name,
				"fleet_event_id": hazard_id,
				"type": definitions.map(func(definition): return str(definition.get("type", "unknown"))),
				"definition": definitions.duplicate(true),
			})

	var support_ids: Array = []
	var support_details: Array = []
	for support_name_value in support_names:
		var support_name := str(support_name_value).strip_edges().to_upper()
		var support_event = _event_by_friendly_name(galaxy_id, support_name)
		if support_event == null:
			return _error("Unknown Support node in %s: %s" % [galaxy_id, support_name])
		if support_event.type != Fleet.EventType.FRIENDLY_HAZARD:
			return _error("Fleet node %s is not an original Support" % support_name)
		var definitions: Array = support_event.check_node_effected_by_hazard(fleet_event, true)
		if definitions.is_empty():
			return _error("Support node %s does not affect %s in original data" % [support_name, node_name])
		var support_id := str(support_event.fleet_event)
		if support_id not in support_ids:
			support_ids.append(support_id)
			support_details.append({
				"node": support_name,
				"fleet_event_id": support_id,
				"type": definitions.map(func(definition): return str(definition.get("type", "unknown"))),
				"definition": definitions.duplicate(true),
			})

	var boss_input: Dictionary = friendly.boss
	var boss_alive := bool(boss_input.get("alive", false))
	var command_ship = _command_ship_entry(battle.fleet_setup)
	var command_ship_id := "" if command_ship == null else str(command_ship.ship)
	var command_ship_name := "" if command_ship_id == "" else str(db.fleet_ships[command_ship_id].name)
	var boss_max_hp = null
	var remaining_hp = null
	var priority = null
	var objective := "normal"
	var boss_health = null
	if boss_alive:
		if command_ship == null or not fleet_event.has_command_ship:
			return _error("Boss alive=true but %s / %s has no original Command Ship" % [galaxy_id, node_name])
		boss_max_hp = float(fleet_event.command_ship_original_health)
		remaining_hp = float(boss_input.get("remaining_hp", 0.0))
		if remaining_hp <= 0.0:
			return _error("Boss remaining_hp must be greater than 0 (max_hp %s, input %s)" % [boss_max_hp, remaining_hp])
		if remaining_hp > boss_max_hp:
			return _error("Boss remaining_hp %s exceeds max_hp %s" % [remaining_hp, boss_max_hp])
		priority = str(boss_input.get("priority", ""))
		if priority not in ["efficiency", "kill_cost"]:
			return _error("Boss priority must be efficiency or kill_cost: %s" % priority)
		objective = "boss"
		boss_health = remaining_hp
	elif command_ship != null:
		boss_max_hp = float(fleet_event.command_ship_original_health)
		boss_health = 0.0

	var player: Dictionary = friendly.player_state
	for required in ["fleet_resources", "ships"]:
		if not player.has(required):
			return _error("Missing player_state field: %s" % required)
	var scales_result := _resolve_scales(player, common)
	if not bool(scales_result.get("ok", false)):
		return scales_result
	var scales: Dictionary = scales_result.scales
	var ships := {}
	for ship_selector in player.ships:
		var ship_result := _resolve_ship_selector(ship_selector, false)
		if not bool(ship_result.ok):
			return _error("Invalid player_state.ships key: %s" % ship_result.error)
		var ship_id: String = ship_result.ship
		if ship_id not in db.fleet_ships:
			return _error("Unknown player ship in original DB: %s" % ship_id)
		if ship_id in ships:
			return _error("Duplicate player ship after numeric conversion: %s" % ship_id)
		var available := int(player.ships[ship_selector])
		if available < 0:
			return _error("ships.%s must be non-negative" % ship_id)
		ships[ship_id] = {"enabled": available > 0, "available": available}

	var search: Dictionary = friendly.get("search", {}) if friendly.get("search", {}) is Dictionary else {}
	var profile := str(search.get("profile", "fast"))
	if profile not in ["fast", "balanced", "exhaustive"]:
		return _error("search.profile must be fast, balanced, or exhaustive: %s" % profile)
	var goal := str(search.get("goal", "best"))
	if goal not in ["best", "beat_baseline"]:
		return _error("search.goal must be best or beat_baseline: %s" % goal)
	var simulation_clock := str(search.get("simulation_clock", "offline_fixed_step" if profile in ["fast", "balanced"] else "realtime"))
	if simulation_clock not in ["realtime", "offline_fixed_step"]:
		return _error("search.simulation_clock must be realtime or offline_fixed_step: %s" % simulation_clock)
	search = {
		"profile": profile,
		"goal": goal,
		"simulation_clock": simulation_clock,
		"max_wall_seconds": float(search.get("max_wall_seconds", 300.0)),
		"max_simulations": int(search.get("max_simulations", 1000000)),
		"workers": clampi(int(search.get("workers", 1)), 1, 4),
	}
	if search.max_wall_seconds <= 0.0 or search.max_simulations <= 0:
		return _error("search max_wall_seconds and max_simulations must be positive")

	var baseline: Dictionary = friendly.get("baseline", {}) if friendly.get("baseline", {}) is Dictionary else {}
	if goal == "beat_baseline" and not bool(baseline.get("enabled", false)):
		return _error("search.goal beat_baseline requires baseline.enabled=true")
	if bool(baseline.get("enabled", false)):
		var normalized_baseline := _normalize_candidate(baseline, "baseline", allowed_mod_slots)
		if not bool(normalized_baseline.ok):
			return _error(str(normalized_baseline.error))
		baseline = normalized_baseline.candidate
		var baseline_error := _validate_baseline(baseline, ships)
		if baseline_error != "":
			return _error(baseline_error)
	var diagnostic: Dictionary = friendly.get("diagnostic", {}) if friendly.get("diagnostic", {}) is Dictionary else {}
	for candidate_name in ["known_candidate", "micro_test"]:
		if diagnostic.has(candidate_name):
			var candidate = diagnostic[candidate_name]
			if not candidate is Dictionary:
				return _error("diagnostic.%s must be an object" % candidate_name)
			var candidate_label := "diagnostic.%s" % candidate_name
			var normalized_candidate := _normalize_candidate(candidate, candidate_label, allowed_mod_slots)
			if not bool(normalized_candidate.ok):
				return _error(str(normalized_candidate.error))
			diagnostic[candidate_name] = normalized_candidate.candidate
			var candidate_error := _validate_candidate(normalized_candidate.candidate, ships, candidate_label)
			if candidate_error != "":
				return _error(candidate_error)

	var grid: Vector2 = battle.get("grid_size", Vector2(2, 5))
	var resolved := {
		"galaxy_id": galaxy_id,
		"fleet_event_id": str(fleet_event.fleet_event),
		"battle_id": battle_id,
		"grid_size": [grid.x, grid.y],
		"player_damage_scale": float(scales.effective.damage_scale),
		"player_health_scale": float(scales.effective.health_scale),
		"scales": scales,
		"fleet_resources": float(player.fleet_resources),
		"fleet_resources_retention": float(player.get("fleet_resources_retention", 0.5)),
		"ships_available": ships,
		"formation": [],
		"enemy_fleet": _serialize_fleet(battle.fleet_setup),
		"hazards": hazard_ids,
		"supports": support_ids,
		"simulation_clock": simulation_clock,
		"temporary_events": [],
		"fight_enemy_command_ship": false,
		"boss_health": boss_health,
		"enemy_difficulty": float(battle.difficulty),
		"optimizer": {
			"objective": objective,
			"boss_priority": priority,
			"boss_remaining_hp": remaining_hp,
			"search": search,
			"baseline": baseline.duplicate(true),
			"diagnostic": diagnostic.duplicate(true),
		},
		"resolver": {
			"source": "original runtime DB / FleetEvent / Fleet.fleet_battles",
			"game_version": str(PlayerInfo.version),
			"friendly_input": friendly.duplicate(true),
			"node": node_name,
			"hazard_details": hazard_details,
			"support_details": support_details,
			"boss": {
				"alive": boss_alive,
				"max_hp": boss_max_hp,
				"remaining_hp": remaining_hp,
				"priority": priority,
				"command_ship_id": command_ship_id,
				"command_ship_name": command_ship_name,
			},
		},
	}
	_print_summary(galaxy_number, node_name, resolved)
	return {"ok": true, "config": resolved}


func _resolve_scales(player: Dictionary, common: Dictionary) -> Dictionary:
	if common.is_empty():
		for field in ["damage_scale", "health_scale"]:
			if not player.has(field):
				return _error("Missing common scale config and legacy player_state.%s" % field)
		var legacy := {
			"damage_scale": float(player.damage_scale),
			"health_scale": float(player.health_scale),
		}
		if legacy.damage_scale <= 0.0 or legacy.health_scale <= 0.0:
			return _error("Legacy player scales must be greater than 0")
		return {"ok": true, "scales": {
			"permanent": legacy.duplicate(true),
			"temporary": {"damage_scale": 0.0, "health_scale": 0.0},
			"effective": legacy.duplicate(true),
		}}

	for section in ["permanent", "temporary"]:
		if not common.has(section) or not common[section] is Dictionary:
			return _error("common.json.%s must be an object" % section)
		for field in ["damage_scale", "health_scale"]:
			if not common[section].has(field):
				return _error("Missing common.json.%s.%s" % [section, field])
			if typeof(common[section][field]) not in [TYPE_INT, TYPE_FLOAT]:
				return _error("common.json.%s.%s must be a number" % [section, field])
	var permanent := {
		"damage_scale": float(common.permanent.damage_scale),
		"health_scale": float(common.permanent.health_scale),
	}
	var temporary := {
		"damage_scale": float(common.temporary.damage_scale),
		"health_scale": float(common.temporary.health_scale),
	}
	var effective := {
		"damage_scale": permanent.damage_scale + temporary.damage_scale,
		"health_scale": permanent.health_scale + temporary.health_scale,
	}
	if effective.damage_scale <= 0.0 or effective.health_scale <= 0.0:
		return _error("Effective damage_scale and health_scale must be greater than 0")
	return {"ok": true, "scales": {
		"permanent": permanent,
		"temporary": temporary,
		"effective": effective,
	}}


func _validate_baseline(baseline: Dictionary, ships: Dictionary) -> String:
	return _validate_candidate(baseline, ships, "baseline")


func _normalize_candidate(candidate: Dictionary, label: String, allowed_mod_slots: Dictionary) -> Dictionary:
	if not candidate.get("formation", {}) is Dictionary:
		return _error("%s.formation must be an object keyed by A1..B5" % label)
	if not candidate.get("loadouts", {}) is Dictionary:
		return _error("%s.loadouts must be an object" % label)
	var normalized := candidate.duplicate(true)
	var formation := {}
	for position in candidate.formation:
		var ship_result := _resolve_ship_selector(candidate.formation[position], true)
		if not bool(ship_result.ok):
			return _error("%s.formation.%s: %s" % [label, position, ship_result.error])
		if str(ship_result.ship) != "":
			formation[position] = ship_result.ship
	normalized.formation = formation

	var loadouts := {}
	for ship_selector in candidate.loadouts:
		var ship_result := _resolve_ship_selector(ship_selector, false)
		if not bool(ship_result.ok):
			return _error("Invalid %s.loadouts key: %s" % [label, ship_result.error])
		var ship_type: String = ship_result.ship
		if ship_type in loadouts:
			return _error("Duplicate %s loadout after numeric conversion: %s" % [label, ship_type])
		var source_loadout = candidate.loadouts[ship_selector]
		if not source_loadout is Dictionary:
			return _error("%s.loadouts.%s must be an object" % [label, ship_type])
		var loadout: Dictionary = source_loadout.duplicate(true)
		for slot in ["primary", "secondary"]:
			var mod_result := _resolve_mod_selector(loadout.get(slot), ship_type, slot, allowed_mod_slots)
			if not bool(mod_result.ok):
				return _error("%s.loadouts.%s.%s: %s" % [label, ship_type, slot, mod_result.error])
			loadout[slot] = mod_result.mod
		loadouts[ship_type] = loadout
	normalized.loadouts = loadouts
	return {"ok": true, "candidate": normalized}


func _resolve_ship_selector(value, allow_empty: bool) -> Dictionary:
	if value == null:
		return {"ok": allow_empty, "ship": "", "error": "null is only valid for an empty formation position"}
	if typeof(value) in [TYPE_INT, TYPE_FLOAT]:
		if float(value) != float(int(value)):
			return {"ok": false, "ship": "", "error": "ship number must be an integer"}
		var ship_number := int(value)
		if ship_number == 0 and allow_empty:
			return {"ok": true, "ship": "", "error": ""}
		if ship_number not in SHIP_NUMBER_TO_ID:
			return {"ok": false, "ship": "", "error": "ship number must be 1..5%s" % (" or 0/null" if allow_empty else "")}
		return {"ok": true, "ship": SHIP_NUMBER_TO_ID[ship_number], "error": ""}
	var ship_text := str(value).strip_edges()
	if ship_text.is_valid_int():
		return _resolve_ship_selector(ship_text.to_int(), allow_empty)
	if ship_text == "Heavy Cruiser":
		return {"ok": true, "ship": "HeavyCruiser", "error": ""}
	if ship_text in SHIP_NUMBER_TO_ID.values():
		return {"ok": true, "ship": ship_text, "error": ""}
	return {"ok": false, "ship": "", "error": "unknown ship '%s' (use Fighter/Corvette/Frigate/Cruiser/Heavy Cruiser or 1/2/3/4/5)" % ship_text}


func _resolve_mod_selector(value, ship_type: String, slot: String, allowed_mod_slots: Dictionary) -> Dictionary:
	if value == null:
		return {"ok": true, "mod": null, "error": ""}
	var selector = null
	if typeof(value) in [TYPE_INT, TYPE_FLOAT]:
		if float(value) != float(int(value)):
			return {"ok": false, "mod": null, "error": "slot number must be an integer"}
		selector = int(value)
	elif value is String and str(value).strip_edges().is_valid_int():
		selector = str(value).strip_edges().to_int()
	else:
		return {"ok": true, "mod": value, "error": ""}
	if int(selector) == 0:
		return {"ok": true, "mod": null, "error": ""}
	var ship_slots = allowed_mod_slots.get(ship_type, {})
	var options = ship_slots.get(slot, []) if ship_slots is Dictionary else []
	if not options is Array or options.is_empty():
		return {"ok": false, "mod": null, "error": "numeric slot selection requires allowed_mod_slots for %s.%s" % [ship_type, slot]}
	if int(selector) < 0 or int(selector) >= options.size():
		return {"ok": false, "mod": null, "error": "slot number must be 0..%d" % (options.size() - 1)}
	return {"ok": true, "mod": options[int(selector)], "error": ""}


func _validate_candidate(candidate: Dictionary, ships: Dictionary, label: String) -> String:
	if not candidate.get("formation", {}) is Dictionary:
		return "%s.formation must be an object keyed by A1..B5" % label
	if not candidate.get("loadouts", {}) is Dictionary:
		return "%s.loadouts must be an object" % label
	var seen_ships := {}
	for position in candidate.formation:
		var position_name := str(position).to_upper()
		if position_name.length() != 2 or position_name.substr(0, 1) not in ["A", "B"] or int(position_name.substr(1, 1)) < 1 or int(position_name.substr(1, 1)) > 5:
			return "Invalid %s position: %s" % [label, position]
		var ship_type := str(candidate.formation[position])
		if ship_type not in ships or not bool(ships[ship_type].enabled):
			return "%s ship is not enabled: %s" % [label, ship_type]
		seen_ships[ship_type] = true
	for ship_type in seen_ships:
		if ship_type not in candidate.loadouts:
			return "Missing %s loadout for %s" % [label, ship_type]
		var loadout = candidate.loadouts[ship_type]
		if not loadout is Dictionary:
			return "%s.loadouts.%s must be an object" % [label, ship_type]
		for slot in ["primary", "secondary"]:
			var mod_id = loadout.get(slot)
			if mod_id != null and str(mod_id) not in db.fleet_mods:
				return "Unknown %s Mod in original DB: %s" % [label, mod_id]
	return ""


func run_numeric_input_unit_tests(allowed_mod_slots: Dictionary) -> Dictionary:
	var normalized := _normalize_candidate({
		"enabled": true,
		"formation": {
			"A1": 1, "A2": "2", "A3": 3, "A4": 4, "A5": 0,
			"B1": null, "B2": 2, "B3": 3, "B4": 0, "B5": 4,
		},
		"loadouts": {
			"1": {"primary": 1, "secondary": 0},
			"2": {"primary": 1, "secondary": 1},
			"3": {"primary": 0, "secondary": 1},
			"4": {"primary": 0, "secondary": 1},
		},
	}, "numeric_test", allowed_mod_slots)
	var invalid_slot := _normalize_candidate({
		"formation": {"A1": 1},
		"loadouts": {"1": {"primary": 2, "secondary": 0}},
	}, "numeric_invalid", allowed_mod_slots)
	var candidate: Dictionary = normalized.get("candidate", {})
	var passed: bool = (
		bool(normalized.get("ok", false))
		and candidate.get("formation", {}).get("A1") == "Fighter"
		and candidate.get("formation", {}).get("A2") == "Corvette"
		and candidate.get("formation", {}).get("A3") == "Frigate"
		and candidate.get("formation", {}).get("A4") == "Cruiser"
		and not candidate.get("formation", {}).has("A5")
		and not candidate.get("formation", {}).has("B1")
		and candidate.get("loadouts", {}).get("Fighter", {}).get("primary") == "FighterMiniRailgunMod"
		and candidate.get("loadouts", {}).get("Corvette", {}).get("secondary") == "ShieldMod"
		and candidate.get("loadouts", {}).get("Frigate", {}).get("secondary") == "ArmorMod"
		and candidate.get("loadouts", {}).get("Cruiser", {}).get("secondary") == "CruiserSingleArmorTank"
		and not bool(invalid_slot.get("ok", false))
	)
	return {
		"passed": passed,
		"normalized": normalized,
		"invalid_slot": invalid_slot,
	}


func run_regression(probe: Node) -> Dictionary:
	var common_player := {
		"fleet_resources": 2627.3,
		"damage_scale": 3.25,
		"health_scale": 3.25,
		"ships": {"Fighter": 1, "Corvette": 1, "Frigate": 1, "Cruiser": 1},
	}
	var b30 := resolve({
		"galaxy": 5, "node": "B30", "boss": {"alive": false, "remaining_hp": 0},
		"hazards": ["B30"], "supports": [], "player_state": common_player,
	})
	var bb3_eff := resolve({
		"galaxy": 5, "node": "BB3",
		"boss": {"alive": true, "remaining_hp": 3500, "priority": "efficiency"},
		"hazards": ["BB3"], "supports": [], "player_state": common_player,
	})
	var bb3_cost := resolve({
		"galaxy": 5, "node": "BB3",
		"boss": {"alive": true, "remaining_hp": 3500, "priority": "kill_cost"},
		"hazards": ["BB3"], "supports": [], "player_state": common_player,
	})
	var invalid_zero := resolve({
		"galaxy": 5, "node": "BB3",
		"boss": {"alive": true, "remaining_hp": 0, "priority": "efficiency"},
		"hazards": [], "supports": [], "player_state": common_player,
	})
	var invalid_high := resolve({
		"galaxy": 5, "node": "BB3",
		"boss": {"alive": true, "remaining_hp": 3501, "priority": "efficiency"},
		"hazards": [], "supports": [], "player_state": common_player,
	})
	var support := resolve({
		"galaxy": 6, "node": "B8", "boss": {"alive": false, "remaining_hp": 0},
		"hazards": ["B10"], "supports": ["F2"], "player_state": common_player,
	})

	var baseline := {}
	if bool(bb3_eff.get("ok", false)):
		var config: Dictionary = bb3_eff.config.duplicate(true)
		for column in range(5):
			config.formation.append({
				"ship": "Cruiser", "grid_position": [0, column], "primary_mod": null,
				"secondary_mod": "CruiserSingleArmorTank", "tertiary_mods": [],
			})
		baseline = await probe.run_battle(config)
		await probe.cleanup_battle()

	var support_battle := {}
	var no_support_battle := {}
	if bool(support.get("ok", false)):
		var config: Dictionary = support.config.duplicate(true)
		for column in range(5):
			config.formation.append({
				"ship": "Cruiser", "grid_position": [0, column], "primary_mod": null,
				"secondary_mod": "CruiserSingleArmorTank", "tertiary_mods": [],
			})
		config.simulation_detail = "full"
		support_battle = await probe.run_battle(config)
		await probe.cleanup_battle()
		config.supports = []
		no_support_battle = await probe.run_battle(config)
		await probe.cleanup_battle()

	var ranker := preload("res://fleet_optimizer.gd").new()
	add_child(ranker)
	var ranking_unit: Dictionary = ranker.run_boss_ranking_unit_test()
	ranker.queue_free()
	var b30_config: Dictionary = b30.get("config", {})
	var bb3_config: Dictionary = bb3_eff.get("config", {})
	var b30_hazard_type := ""
	if not b30_config.is_empty():
		b30_hazard_type = str(b30_config.resolver.hazard_details[0].definition[0].type)
	var b30_passed: bool = (
		bool(b30.get("ok", false))
		and b30_config.galaxy_id == "galaxy5"
		and b30_config.fleet_event_id == "g5_b30"
		and b30_config.battle_id == "galaxy5_battle30"
		and b30_hazard_type == "damage_per_second"
	)
	var bb3_passed: bool = (
		bool(bb3_eff.get("ok", false)) and bool(bb3_cost.get("ok", false))
		and bb3_config.fleet_event_id == "g5_bb3"
		and bb3_config.battle_id == "galaxy5_basebattle3"
		and bb3_config.resolver.boss.command_ship_id == "EnemyCommandShip"
		and bb3_config.resolver.boss.command_ship_name == "Enemy Base"
		and bb3_config.hazards == ["g5_bb3"]
		and bb3_eff.config.optimizer.boss_priority == "efficiency"
		and bb3_cost.config.optimizer.boss_priority == "kill_cost"
	)
	var baseline_passed: bool = (
		str(baseline.get("outcome", "")) == "lose"
		and is_equal_approx(float(baseline.get("boss_damage", 0.0)), 1365.0)
		and is_equal_approx(float(baseline.get("fleet_resources_used", 0.0)), 300.0)
		and is_equal_approx(float(baseline.get("boss_damage", 0.0)) / float(baseline.get("fleet_resources_used", 1.0)), 4.55)
	)
	var support_config: Dictionary = support.get("config", {})
	var analyzer_support := {}
	if not support_config.is_empty():
		var analyzer := preload("res://fleet_battle_analyzer.gd").new()
		add_child(analyzer)
		analyzer_support = analyzer.analyze(support_config, {})
		analyzer.queue_free()
	var support_triggered := _has_runtime_effect(support_battle, "g6_bu_reinforce1", "reinforcements")
	var absent_without_support := not _has_runtime_effect(no_support_battle, "g6_bu_reinforce1", "reinforcements")
	var spawned_support_fighters := _spawned_ship_count(support_battle, "Fighter")
	var spawned_fighters_without_support := _spawned_ship_count(no_support_battle, "Fighter")
	var support_scale_matches := _spawned_ship_scale_matches_initial(support_battle, "Cruiser")
	var support_passed: bool = (
		bool(support.get("ok", false))
		and support_config.supports == ["g6_bu_reinforce1"]
		and not support_config.resolver.support_details.is_empty()
		and support_battle.get("battle_config", {}).get("supports", []) == ["g6_bu_reinforce1"]
		and support_triggered and absent_without_support
		and spawned_support_fighters > 0 and spawned_fighters_without_support == 0
		and support_scale_matches
		and "reinforcement" in analyzer_support.get("support_tags", [])
		and "timed_event" in analyzer_support.get("support_tags", [])
	)
	return {
		"passed": b30_passed and bb3_passed and baseline_passed and support_passed and ranking_unit.passed
			and not bool(invalid_zero.get("ok", false)) and not bool(invalid_high.get("ok", false)),
		"b30_resolver": {"passed": b30_passed, "result": b30},
		"bb3_resolver": {"passed": bb3_passed, "efficiency": bb3_eff, "kill_cost": bb3_cost},
		"boss_hp_validation": {"passed": not invalid_zero.ok and not invalid_high.ok, "zero": invalid_zero, "above_max": invalid_high},
		"bb3_cruiser_baseline": {
			"passed": baseline_passed,
			"outcome": baseline.get("outcome"),
			"boss_damage": baseline.get("boss_damage"),
			"fleet_resources_used": baseline.get("fleet_resources_used"),
			"boss_damage_per_fr": float(baseline.get("boss_damage", 0.0)) / float(baseline.get("fleet_resources_used", 1.0)),
		},
		"support_resolver_and_battle": {
			"passed": support_passed,
			"resolver": support,
			"run_battle_received_support": support_battle.get("battle_config", {}).get("supports", []),
			"runtime_behavior_triggered": support_triggered,
			"behavior_absent_without_support": absent_without_support,
			"spawned_support_fighters": spawned_support_fighters,
			"spawned_fighters_without_support": spawned_fighters_without_support,
			"spawned_cruiser_scale_matches_initial": support_scale_matches,
			"support_runtime_events": support_battle.get("runtime_effect_events", []),
			"without_support_runtime_events": no_support_battle.get("runtime_effect_events", []),
			"analyzer": analyzer_support,
		},
		"ranking_unit_test": ranking_unit,
	}


func _has_runtime_effect(result: Dictionary, source_id: String, effect_type: String) -> bool:
	for event in result.get("runtime_effect_events", []):
		if event.get("event") == "triggered" and event.get("originator_node") == source_id and event.get("type") == effect_type:
			return true
	return false


func _spawned_ship_count(result: Dictionary, ship_id: String) -> int:
	var count := 0
	for ship in result.get("player_ships", []):
		if str(ship.get("id", "")) == ship_id and bool(ship.get("spawned_during_battle", false)):
			count += 1
	return count


func _spawned_ship_scale_matches_initial(result: Dictionary, ship_id: String) -> bool:
	var initial_max_hull := -1.0
	var spawned_max_hull := -1.0
	for ship in result.get("player_ships", []):
		if str(ship.get("id", "")) != ship_id:
			continue
		if bool(ship.get("spawned_during_battle", false)):
			spawned_max_hull = float(ship.get("max_hull", -1.0))
		else:
			initial_max_hull = float(ship.get("max_hull", -1.0))
	return initial_max_hull >= 0.0 and spawned_max_hull >= 0.0 and is_equal_approx(initial_max_hull, spawned_max_hull)


func _event_by_friendly_name(galaxy_id: String, friendly_name: String):
	var found = null
	for fleet_event in Fleet.fleet_event_refs.values():
		if str(fleet_event.galaxy_id) != galaxy_id:
			continue
		if str(fleet_event.stats.get("name", "")).strip_edges().to_upper() == friendly_name:
			if found != null:
				return null
			found = fleet_event
	return found


func _command_ship_entry(entries: Array):
	for entry in entries:
		if "Command" in str(entry.ship):
			return entry
	return null


func _serialize_fleet(entries: Array) -> Array:
	var result: Array = []
	for entry in entries:
		result.append({
			"ship": str(entry.ship),
			"grid_position": [entry.grid_position.x, entry.grid_position.y],
			"mods": entry.mods.duplicate(true),
			"difficulty_override": float(entry.difficulty_override),
		})
	return result


func _print_summary(galaxy_number: int, node_name: String, config: Dictionary) -> void:
	print("FRIENDLY_CONFIG Galaxy %d / %s" % [galaxy_number, node_name])
	print("Fleet Event: %s" % config.fleet_event_id)
	print("Battle ID: %s" % config.battle_id)
	print("Hazards: %s" % [config.hazards])
	print("Supports: %s" % [config.supports])
	print("Boss: %s" % [config.resolver.boss])
	print("Player: FR=%s Damage=%s Health=%s" % [config.fleet_resources, config.player_damage_scale, config.player_health_scale])
	print("Ships Available: %s" % [config.ships_available])


func _error(message: String) -> Dictionary:
	return {"ok": false, "error": message}
