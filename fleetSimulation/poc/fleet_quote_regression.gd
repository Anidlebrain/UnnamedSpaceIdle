extends Node
## Run from fleet_grid_regression after native FleetBattle initialization.

var checks: Array = []


func _check(label: String, passed: bool, evidence = null) -> void:
	checks.append({"label": label, "passed": passed, "evidence": evidence})
	print("QUOTE_REGRESSION %s %s" % [label, "PASS" if passed else "FAIL"])


func _group(ship: String, x: int, y: int, secondary = null) -> Dictionary:
	return {"ship": ship, "grid_position": [x, y], "primary_mod": null,
		"secondary_mod": secondary, "tertiary_mods": []}


func _loadouts(optimizer: Node, formation: Array) -> Dictionary:
	var result := {}
	for group in formation:
		result[group.ship] = {"id": optimizer._slot_loadout_id(group.primary_mod, group.secondary_mod),
			"primary_mod": group.primary_mod, "secondary_mod": group.secondary_mod,
			"tertiary_mods": group.tertiary_mods}
	return result


func _native(probe: Node, config: Dictionary, formation: Array, resources: float) -> Dictionary:
	var candidate := config.duplicate(true)
	candidate.formation = formation.duplicate(true)
	candidate.fleet_resources = resources
	var quote: Dictionary = await probe.quote_player_deployment(candidate)
	await probe.cleanup_battle()
	return quote


func _compare(probe: Node, optimizer: Node, config: Dictionary, formation: Array, label: String) -> void:
	var loadouts := _loadouts(optimizer, formation)
	var derived: Dictionary = optimizer._quote_from_native_costs(formation, loadouts)
	var native: Dictionary = await _native(probe, config, formation, float(config.fleet_resources))
	_check(label, not derived.is_empty() and derived.deployable == native.deployable
		and is_equal_approx(float(derived.fleet_resources_committed), float(native.fleet_resources_committed))
		and derived.within_budget == native.within_budget and derived.deployment == native.deployment,
		{"derived": derived, "native": native})


func _case(probe: Node, config: Dictionary, label: String) -> void:
	var optimizer := preload("res://fleet_optimizer_search.gd").new()
	add_child(optimizer)
	optimizer._base_config = config.duplicate(true)
	var seed := [_group("Cruiser", 0, 0, "CruiserSingleArmorTank"), _group("Frigate", 1, 0)]
	_check(label + " unknown cost requires native scene",
		optimizer._quote_from_native_costs(seed, _loadouts(optimizer, seed)).is_empty())
	var seed_native: Dictionary = await _native(probe, config, seed, float(config.fleet_resources))
	var seed_loadouts := _loadouts(optimizer, seed)
	for ship in seed_loadouts:
		if seed_native.get("native_modded_costs", {}).has(ship):
			optimizer._cost_keys[str(ship) + JSON.stringify(seed_loadouts[ship])] = seed_native.native_modded_costs[ship]
	_check(label + " original scene supplied both modded costs", optimizer._cost_keys.size() == 2, seed_native)
	if optimizer._cost_keys.size() != 2:
		optimizer.queue_free()
		return
	var enabled_state = optimizer._base_config.ships_available["Cruiser"]
	optimizer._base_config.ships_available["Cruiser"] = {"enabled": false, "available": 1}
	_check(label + " disabled ship cannot use derived quote",
		optimizer._quote_from_native_costs(seed, seed_loadouts).is_empty())
	optimizer._base_config.ships_available["Cruiser"] = enabled_state
	var cells := [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]]
	var same_type: Array = []
	for cell in cells:
		same_type.append(_group("Cruiser", cell[0], cell[1], "CruiserSingleArmorTank"))
	await _compare(probe, optimizer, config, same_type.slice(0, 1), label + " normal count")
	await _compare(probe, optimizer, config, same_type.slice(0, 2), label + " first overdeploy")
	await _compare(probe, optimizer, config, same_type, label + " fifth group")
	var mixed := same_type.slice(0, 3)
	mixed.append(_group("Frigate", 1, 1))
	mixed.append(_group("Frigate", 0, 2))
	await _compare(probe, optimizer, config, mixed, label + " mixed types and mods")
	if int(config.grid_size[0]) == 3:
		var all_cells: Array = []
		for x in range(3):
			for y in range(5):
				all_cells.append([x, y])
		var shuffled_indices := [14, 0, 9, 5, 12, 2, 7, 10, 4, 13, 1, 8, 6, 11, 3]
		var fifteen: Array = []
		for index in shuffled_indices:
			fifteen.append(_group("Cruiser", all_cells[index][0], all_cells[index][1], "CruiserSingleArmorTank"))
		await _compare(probe, optimizer, config, fifteen, label + " fifteen shuffled groups across A B C")
	var committed: float = float(optimizer._quote_from_native_costs(mixed, _loadouts(optimizer, mixed)).fleet_resources_committed)
	for resources in [committed, committed - 0.01]:
		optimizer._base_config.fleet_resources = resources
		var derived: Dictionary = optimizer._quote_from_native_costs(mixed, _loadouts(optimizer, mixed))
		var native: Dictionary = await _native(probe, config, mixed, resources)
		_check(label + " FR boundary %s" % str(resources), derived.within_budget == native.within_budget
			and is_equal_approx(float(derived.fleet_resources_committed), float(native.fleet_resources_committed)),
			{"derived": derived, "native": native})
	optimizer.queue_free()


func run(probe: Node, b46_config: Dictionary) -> Dictionary:
	var b46 := b46_config.duplicate(true)
	b46.ships_available["Cruiser"] = 1
	b46.ships_available["Frigate"] = 1
	b46.fleet_resources = 100000.0
	await _case(probe, b46, "B46 three columns")
	var resolver := preload("res://friendly_config_resolver.gd").new()
	add_child(resolver)
	var b8_input := {"galaxy": 6, "node": "B8", "boss": {"alive": false},
		"hazards": ["B10"], "supports": ["F2"],
		"player_state": {"fleet_resources": 100000.0, "damage_scale": 1000.0,
			"health_scale": 1000.0, "ships": {"Cruiser": 1, "Frigate": 1}},
		"baseline": {"enabled": true, "formation": {"A3": "Cruiser"},
			"loadouts": {"Cruiser": {"primary": null, "secondary": null}}}}
	var resolved: Dictionary = resolver.resolve(b8_input)
	_check("B8 resolves original hazard and support", bool(resolved.get("ok", false)), resolved)
	if bool(resolved.get("ok", false)):
		await _case(probe, resolved.config, "B8 hazard and support")
	resolver.queue_free()
	var passed := true
	for item in checks:
		passed = passed and bool(item.passed)
	return {"passed": passed, "checks": checks}
