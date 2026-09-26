extends Node
## Synthetic player stats isolate grid/search correctness from user progression.
var checks: Array = []

func check(label: String, passed: bool, evidence = null) -> void:
	checks.append({"label": label, "passed": passed, "evidence": evidence})
	print("GRID_REGRESSION %s %s" % [label, "PASS" if passed else "FAIL"])


func friendly(node: String, columns: int) -> Dictionary:
	return {"galaxy": 6, "node": node, "formation_columns": columns,
		"boss": {"alive": false}, "hazards": [], "supports": [],
		"player_state": {"fleet_resources": 100000, "damage_scale": 1000, "health_scale": 1000,
			"ships": {"Fighter": 15, "Corvette": 15, "Frigate": 15, "Cruiser": 15, "HeavyCruiser": 15}},
		"baseline": {"enabled": true, "formation": {"C3" if columns == 3 else "A3": "Cruiser"},
			"loadouts": {"Cruiser": {"primary": null, "secondary": null}}}}


func run(probe: Node) -> Dictionary:
	var resolver := preload("res://friendly_config_resolver.gd").new()
	add_child(resolver)
	var optimizer := preload("res://fleet_optimizer_search.gd").new()
	add_child(optimizer)
	var settings: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://optimizer_v2_daily.json"))
	var resolved := resolver.resolve(friendly("B46", 3))
	check("original G6 B46 grid is 3x5", resolved.get("ok", false) and int(resolved.config.grid_size[0]) == 3 and int(resolved.config.grid_size[1]) == 5)
	if not resolved.get("ok", false):
		return {"passed": false, "checks": checks, "error": resolved}
	var bad := friendly("B46", 2)
	check("B46 rejects configured two columns", not resolver.resolve(bad).ok)
	bad = friendly("B45", 3)
	check("B45 rejects configured three columns", not resolver.resolve(bad).ok)
	bad = friendly("B45", 2)
	bad.erase("formation_columns")
	check("legacy config defaults to two columns", resolver.resolve(bad).ok)
	bad.baseline.formation = {"C1": "Cruiser"}
	check("two-column baseline rejects C", not resolver.resolve(bad).ok)
	bad = friendly("B46", 3)
	bad.baseline.formation = {"D1": "Cruiser"}
	check("three-column baseline rejects D", not resolver.resolve(bad).ok)
	bad.baseline.formation = {"C1": "Cruiser", "c1": "Cruiser"}
	check("normalized duplicate cells rejected", not resolver.resolve(bad).ok)
	for value in [0, 27, 2.5, "3", true]:
		bad = friendly("B46", 3)
		bad.formation_columns = value
		check("invalid column value %s" % str(value), not resolver.resolve(bad).ok)
	optimizer._base_config = resolved.config.duplicate(true)
	optimizer._settings = settings.duplicate(true)
	optimizer._normalize_settings()
	check("three columns expose fifteen cells and groups", optimizer._cells.size() == 15 and optimizer._settings.max_total_groups == 15)
	check("position C5 round trip", optimizer._grid_from_position("C5") == [2, 4] and optimizer._position_name([2, 4]) == "C5")
	var seed: Array = []
	for i in range(5):
		seed.append({"ship": "Cruiser", "primary_mod": null, "secondary_mod": null, "grid_position": [2, i]})
	var seen := {}
	var valid := true
	for i in range(3003):
		var item := optimizer._formation_at(seed, i)
		valid = valid and optimizer._has_unique_positions(item)
		seen[optimizer._formation_key(item)] = true
	check("exact C(15,5)=3003 valid unique layouts", valid and seen.size() == 3003 and optimizer._unique_formation_count({"Cruiser": 5}) == 3003)
	seed = seed.slice(0, 3)
	seed[0].ship = "Frigate"
	seed[1].ship = "Corvette"
	seen.clear()
	for i in range(2730):
		seen[optimizer._formation_key(optimizer._formation_at(seed, i))] = true
	check("mixed exact 15*14*13 layouts", seen.size() == 2730)
	for columns in [1, 2, 3]:
		optimizer._configure_grid([columns, 5])
		var formation := [{"ship": "Cruiser", "grid_position": [columns - 1.0, 2.0]}]
		valid = true
		var reaches_last := false
		for item in optimizer._formation_neighbors(formation):
			valid = valid and optimizer._has_unique_positions(item)
			for group in item:
				reaches_last = reaches_last or int(group.grid_position[0]) == columns - 1
		check("%d-column neighbors stay in grid and cover rear column" % columns, valid and reaches_last)
		check("%d-column worker float occupied cell removed" % columns, optimizer._free_cells(formation).size() == columns * 5 - 1)
		check("%d-column out of grid/fraction/duplicate rejected" % columns,
			not optimizer._has_unique_positions([{"grid_position": [columns, 0]}])
			and not optimizer._has_unique_positions([{"grid_position": [-1, 0]}])
			and not optimizer._has_unique_positions([{"grid_position": [0.5, 0]}])
			and not optimizer._has_unique_positions(formation + formation))
	optimizer._configure_grid([3, 5])
	var compositions: Array = []
	var started := Time.get_ticks_usec()
	optimizer._append_compositions(optimizer._ship_types(), 0, {}, compositions)
	check("all 15503 nonempty five-type compositions within fifteen cells", compositions.size() == 15503,
		{"count": compositions.size(), "elapsed_ms": (Time.get_ticks_usec() - started) / 1000.0, "unbounded_leaf_count": 1048576})
	var full: Array = []
	for cell in optimizer._cells:
		full.append({"ship": "Cruiser", "grid_position": cell, "primary_mod": null, "secondary_mod": null})
	var stream := optimizer._build_mutation_stream({"formation": full})
	valid = true
	for bucket in stream.buckets:
		for item in bucket:
			valid = valid and optimizer._has_unique_positions(item) and item.size() <= 15
	check("full fifteen-group mutation stream valid", valid)
	optimizer._prepare_space()
	valid = true
	var reaches_c := false
	for i in range(200):
		var candidate := optimizer._next_global()
		valid = valid and optimizer._has_unique_positions(candidate) and candidate.size() <= 15
		for group in candidate:
			reaches_c = reaches_c or int(group.grid_position[0]) == 2
	check("global scheduling generates valid three-column candidates", valid and reaches_c)
	var legacy := preload("res://fleet_optimizer_v2.gd").new()
	add_child(legacy)
	legacy._base_config = resolved.config.duplicate(true)
	legacy._settings = settings.duplicate(true)
	legacy._normalize_settings()
	valid = not legacy._settings.smart_pruning
	for candidate in legacy._representative_formations(full):
		valid = valid and legacy._valid_grid_positions(candidate)
	check("legacy v2 disables two-column smart pruning and has valid fifteen-group representatives", valid)
	if "--grid-logic-only" in OS.get_cmdline_user_args():
		return summary([])
	var quote_tests := preload("res://fleet_quote_regression.gd").new()
	add_child(quote_tests)
	var quote_checks: Dictionary = await quote_tests.run(probe, resolved.config)
	checks.append_array(quote_checks.checks)
	var native_config: Dictionary = resolved.config.duplicate(true)
	native_config.formation = full
	var quote: Dictionary = await probe.quote_player_deployment(native_config)
	await probe.cleanup_battle()
	check("native scene accepts fifteen deployment groups", quote.deployable and quote.within_budget and int(quote.deployment.Cruiser.deployed) == 15, quote)
	# Exhaust every position with two loadouts, then independently replay Best.
	var native_runs := []
	for node in ["B45", "B46"]:
		var columns := 3 if node == "B46" else 2
		var input := friendly(node, columns)
		var config: Dictionary = resolver.resolve(input).config
		var limited := settings.duplicate(true)
		limited.ship_types = ["Cruiser"]
		limited.group_ranges = {"Cruiser": {"min": 1, "max": 1}}
		limited.baseline = input.baseline
		limited.search = {"profile": "exhaustive", "max_wall_seconds": 600, "max_simulations": 1000, "workers": 1, "simulation_clock": "offline_fixed_step"}
		var search := preload("res://fleet_optimizer_search.gd").new()
		add_child(search)
		var result: Dictionary = await search.optimize_v2(probe, config, limited)
		check("%s native exhaustive all positions and mods" % node,
			result.get("result_claim") == "EXHAUSTIVE BEST" and result.get("errors", 1) == 0
			and result.unique_results == columns * 5 * 2 and not str(result.finalization_status).begins_with("FAILED"),
			{"unique_results": result.get("unique_results"), "claim": result.get("result_claim"), "replay": result.get("finalization_status")})
		check("%s preserves verified baseline quality" % node,
			float(result.best_result.fleet_resources_used) <= float(result.verified_baseline.fleet_resources_used))
		native_runs.append(result)
		search.queue_free()
	return summary(native_runs)


func summary(native_runs: Array) -> Dictionary:
	var passed := true
	for item in checks:
		passed = passed and item.passed
	return {"passed": passed, "checks": checks, "native_runs": native_runs}
