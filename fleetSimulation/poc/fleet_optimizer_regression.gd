extends Node

var checks: Array = []

func check(label: String, passed: bool, evidence = null) -> void:
	checks.append({"label": label, "passed": passed, "evidence": evidence})
	print("V3_REGRESSION %s %s" % [label, "PASS" if passed else "FAIL"])


func run(probe: Node) -> Dictionary:
	var cases: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://optimizer_benchmark_cases.json"))
	var settings: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://optimizer_v2_daily.json"))
	var resolver := preload("res://friendly_config_resolver.gd").new()
	add_child(resolver)
	var optimizer := preload("res://fleet_optimizer_search.gd").new()
	add_child(optimizer)
	var float_position_formation := [
		{"ship": "Cruiser", "grid_position": [0.0, 2.0]},
		{"ship": "Frigate", "grid_position": [1.0, 2.0]},
	]
	var free_cells := optimizer._free_cells(float_position_formation)
	check("float worker positions are removed from free cells",
		[0, 2] not in free_cells and [1, 2] not in free_cells and free_cells.size() == 8,
		free_cells)
	var duplicate_position_formation: Array = float_position_formation.duplicate(true)
	duplicate_position_formation.append({"ship": "Fighter", "grid_position": [0, 2]})
	check("duplicate grid positions are rejected",
		not optimizer._has_unique_positions(duplicate_position_formation),
		duplicate_position_formation)
	var seed: Array = []
	for i in range(5):
		seed.append({"ship": "Cruiser", "primary_mod": null, "secondary_mod": null, "grid_position": [0, i]})
	var enumerated := {}
	for i in range(252):
		enumerated[optimizer._formation_key(optimizer._formation_at(seed, i))] = true
	check("lazy exact positions C(10,5)", enumerated.size() == 252)
	seed = seed.slice(0, 3)
	seed[0].ship = "Frigate"
	seed[1].ship = "Corvette"
	enumerated.clear()
	for i in range(720):
		enumerated[optimizer._formation_key(optimizer._formation_at(seed, i))] = true
	check("lazy mixed exact positions 10*9*8", enumerated.size() == 720)
	var a := optimizer._fake_boss_summary("a", 80, 100)
	var b := optimizer._fake_boss_summary("b", 81, 150)
	a.outcome = "victory"
	b.outcome = "victory"
	a.fleet_resources_committed = 120
	b.fleet_resources_committed = 90
	optimizer.objective = "normal"
	check("normal ranks Used before committed", optimizer._rank_before(a, b))
	optimizer._settings = {"simulation_clock": "offline_fixed_step"}
	check("offline replay compares simulation time by physics tick", optimizer._replay_field_matches("simulation_time", 11.23333333333349, 11.23333333333351))
	check("native replay accepts JSON float tails", optimizer._replay_field_matches("player_remaining_health", 528.5075000000001, 528.5074999999999))
	check("native replay rejects material numeric differences", not optimizer._replay_field_matches("player_remaining_health", 528.5075, 528.5175))
	check("native replay keeps null distinct from zero", not optimizer._replay_field_matches("boss_damage", null, 0.0))
	optimizer.objective = "boss"
	optimizer.boss_priority = "efficiency"
	b.outcome = "lose"
	check("efficiency allows loss above win", optimizer._rank_before(b, a))
	b.boss_damage_per_fr_is_infinite = true
	b.boss_damage_per_fr = "INF"
	b.fleet_resources_used = 0
	check("positive damage / zero FR ranks first", optimizer._rank_before(b, a))
	b.candidate_hash = "b"
	a.candidate_hash = "a"
	check("infinite efficiency improvement is explicit", optimizer._improvement(b, a).damage_per_fr_gain == "INF")
	optimizer.boss_priority = "kill_cost"
	b.killable_with_current_fr = null
	a.killable_with_current_fr = null
	check("unrefined null kill status is not an improvement", not optimizer._objective_improved(b, a))
	var ledger: Dictionary = probe.native_fr_settlement("galaxy5", 620.5, 29.92)
	check("native resource ledger rounds debit", is_equal_approx(float(ledger.resources_after), 591.5), ledger)
	var edge: Dictionary = probe.native_fr_settlement("galaxy5", 620.5, 29.999999999999996)
	check("native debit at integer boundary", edge.resources_after == 591.5, edge)
	var normal: Dictionary = resolver.resolve(cases.b13.friendly, cases.b13.common).config
	var baseline := optimizer._formation_from_candidate(cases.b13.friendly.baseline)
	normal.formation = baseline
	normal.simulation_detail = "full"
	var reference: Dictionary = await probe.run_battle(normal)
	check("Used FR preserves native precision", reference.fleet_resources_used == Fleet.fleet_battle.fleet_resources_committed - Fleet.fleet_battle.fleet_resources)
	await probe.cleanup_battle()
	# Disturb the process-global RNG between identical battles. The adapter must
	# reset it because original combat code uses randf() for fighter evasion.
	seed(987654321)
	for _index in range(37):
		randf()
	var rng_replay: Dictionary = await probe.run_battle(normal)
	await probe.cleanup_battle()
	check("combat RNG is independent of process history", core(reference) == core(rng_replay), {"reference": core(reference), "replay": core(rng_replay)})
	var quote: Dictionary = await probe.quote_player_deployment(normal, true)
	var native_costs_match := true
	for group in get_tree().get_nodes_in_group("deployment_group"):
		if group.team == Fleet.Team.LEFT and not group.removing:
			native_costs_match = native_costs_match and quote.native_modded_costs[group.fleet_ship_info.id] == group.fleet_ship_info.fleet_resources_cost
	check("quote costs come from native deployment groups", native_costs_match)
	var reused: Dictionary = await probe.run_battle(normal)
	await probe.cleanup_battle()
	check("prepared native quote reuses identical battle", core(reference) == core(reused), {"quote": quote, "reference": core(reference), "reused": core(reused)})
	normal.formation.reverse()
	var reversed: Dictionary = await probe.run_battle(normal)
	await probe.cleanup_battle()
	check("array ordering is equivalent at fixed grid", core(reference) == core(reversed), core(reversed))
	var lower: Dictionary = cases.get("b13_known_lower", {})
	if not lower.is_empty():
		normal.formation = optimizer._formation_from_candidate(lower)
		var result: Dictionary = await probe.run_battle(normal)
		await probe.cleanup_battle()
		check("known lower Used FR replay", result.outcome == "victory" and float(result.fleet_resources_used) < float(reference.fleet_resources_used), core(result))
	for fixture in cases.formation_sensitive:
		normal.formation = optimizer._formation_from_candidate(fixture)
		var sensitive: Dictionary = await probe.run_battle(normal)
		await probe.cleanup_battle()
		check("formation sensitivity " + fixture.expected_outcome, sensitive.outcome == fixture.expected_outcome, core(sensitive))
	for fixture in cases.composition_sensitive:
		normal.formation = fixture.formation.duplicate(true)
		var sensitive: Dictionary = await probe.run_battle(normal)
		await probe.cleanup_battle()
		check("composition sensitivity " + fixture.expected_outcome, sensitive.outcome == fixture.expected_outcome, core(sensitive))
	for source in ["ui_ab_test_02_config.json", "ui_ab_test_03_config.json"]:
		var config: Dictionary = JSON.parse_string(FileAccess.get_file_as_string("res://" + source))
		config.simulation_detail = "full"
		var fresh: Dictionary = await probe.run_battle(config)
		await probe.cleanup_battle()
		await probe.quote_player_deployment(config, true)
		var prepared: Dictionary = await probe.run_battle(config)
		await probe.cleanup_battle()
		check("prepared scene " + source, core(fresh) == core(prepared))
	var support_config: Dictionary = resolver.resolve(cases.b8.friendly, cases.b8.common).config
	support_config.formation = []
	for i in range(5):
		support_config.formation.append({"ship": "Cruiser", "grid_position": [0, i], "primary_mod": null, "secondary_mod": "CruiserSingleArmorTank"})
	support_config.fleet_mod_loadouts = {"Fighter": {"primary_mod": "FighterMiniRailgunMod", "secondary_mod": null}}
	optimizer._support_ship_types = ["Fighter"]
	optimizer._base_config = support_config.duplicate(true)
	optimizer._base_config.erase("fleet_mod_loadouts")
	optimizer._settings = {"simulation_detail": "full"}
	var dispatched_formation: Array = support_config.formation.duplicate(true)
	optimizer._decorate_support(dispatched_formation, support_config.fleet_mod_loadouts)
	var support_fresh: Dictionary = await probe.run_battle(optimizer._evaluation_config(dispatched_formation))
	await probe.cleanup_battle()
	await probe.quote_player_deployment(support_config, true)
	var support_prepared: Dictionary = await probe.run_battle(support_config)
	await probe.cleanup_battle()
	check("Support prepared/fresh equivalence", core(support_fresh) == core(support_prepared))
	var modified_reinforcements := 0
	for ship in support_fresh.player_ships:
		if ship.spawned_during_battle and "FighterMiniRailgunMod" in ship.mods:
			modified_reinforcements += 1
	check("undeployed reinforcement ship uses selected native mod", modified_reinforcements > 0, modified_reinforcements)
	optimizer._support_ship_types = ["Fighter"]
	var support_a: Array = support_config.formation.duplicate(true)
	var support_b: Array = support_config.formation.duplicate(true)
	optimizer._decorate_support(support_a, {})
	optimizer._decorate_support(support_b, support_config.fleet_mod_loadouts)
	check("support-only mods have distinct candidate keys", optimizer._formation_key(support_a) != optimizer._formation_key(support_b))
	optimizer._support_ship_types = []
	var boss_support_config: Dictionary = resolver.resolve(cases.boss_support.friendly, cases.boss_support.common).config
	boss_support_config.formation = optimizer._formation_from_candidate(cases.boss_support.friendly.baseline)
	var boss_support: Dictionary = await probe.run_battle(boss_support_config)
	await probe.cleanup_battle()
	check("Boss with original Support route", not boss_support.has("error") and not boss_support.runtime_effect_events.is_empty(), core(boss_support))
	# Failure tests deliberately omit observed.outcome. No recovery or workers.
	for case_name in ["b13", "boss_efficiency"]:
		var fixture: Dictionary = cases[case_name].duplicate(true)
		fixture.friendly.baseline = {"enabled": true, "formation": {"A1": "Fighter"},
			"loadouts": {"Fighter": {"primary": null, "secondary": null}}}
		if case_name == "b13":
			fixture.friendly.diagnostic = {"micro_test": cases.b13.friendly.baseline.duplicate(true)}
		fixture.friendly.search = {"profile": "fast", "workers": 4, "max_wall_seconds": 300}
		var resolved: Dictionary = resolver.resolve(fixture.friendly, fixture.common).config
		var failed_optimizer := preload("res://fleet_optimizer_search.gd").new()
		add_child(failed_optimizer)
		var config_settings := settings.duplicate(true)
		config_settings.merge(resolved.optimizer, true)
		var failed: Dictionary = await failed_optimizer.optimize_v2(probe, resolved, config_settings)
		check("baseline fail fast " + case_name, failed.result_claim == "BASELINE VALIDATION FAILED" and int(failed.simulations_used) == 1 and failed_optimizer._workers.is_empty(), failed.get("baseline_validation", {}))
		failed_optimizer.queue_free()
	# Continuous native boss fights with the same per-battle deployment cap.
	var boss: Dictionary = resolver.resolve(cases.boss_kill.friendly).config
	var boss_settings := settings.duplicate(true)
	boss_settings.merge(boss.optimizer, true)
	optimizer._probe = probe
	optimizer._base_config = boss
	optimizer._settings = boss_settings
	optimizer._normalize_settings()
	optimizer._settings.max_wall_seconds = 3600
	optimizer.objective = "boss"
	optimizer.boss_priority = "kill_cost"
	optimizer.boss_remaining_hp = 3500
	optimizer._environment_key = optimizer._battle_environment_key(boss)
	optimizer._started_msec = Time.get_ticks_msec()
	optimizer._analyzer = preload("res://fleet_battle_analyzer.gd").new()
	optimizer.add_child(optimizer._analyzer)
	optimizer._pruning_stats = {"hard_pruned": {"fr_budget": 0, "disabled_ship": 0}, "simulated": 0, "refined": 0, "generated": 0}
	optimizer._search_audit = {"candidates_generated": 0, "queued": 0, "simulated": 0, "wins": 0, "losses": 0}
	var candidate: Dictionary = await optimizer._run_verified_baseline()
	var sliced := candidate.duplicate(true)
	optimizer._refinement_slice_deadline = optimizer._elapsed_seconds()
	await optimizer._refine_candidate(sliced)
	check("baseline sequence slice preserves exploration", not sliced.kill_refined and sliced.kill_sequence.size() == 1 and sliced.kill_sequence_stop_reason == "refinement_slice_budget_reached")
	optimizer._refinement_slice_deadline = INF
	await optimizer._refine_candidate(sliced)
	check("partial sequence resumes to a native verified kill", sliced.killable_with_current_fr == true and sliced.kill_sequence.size() == 3)
	await optimizer._refine_candidate(candidate)
	check("boss real sequence and last battle refund", bool(candidate.killable_with_current_fr) and candidate.kill_sequence.size() == 3 and float(candidate.refined_total_kill_fr) < 900, candidate.kill_sequence)
	var poor := candidate.duplicate(true)
	poor.kill_refined = false
	optimizer._base_config.fleet_resources = 600
	await optimizer._refine_candidate(poor)
	check("kill total may exceed per-battle budget", bool(poor.killable_with_per_battle_fr) and poor.kill_sequence.size() == 3 and float(poor.refined_total_kill_fr) > 600, poor.kill_sequence)
	check("resource cap resets for each battle", poor.kill_sequence.all(func(item): return item.per_battle_fr_budget == 600))
	poor.kill_refined = false
	optimizer._base_config.fleet_resources = float(poor.deployment_quote_committed_fr) - 1.0
	await optimizer._refine_candidate(poor)
	check("single deployment must fit cap", not bool(poor.killable_with_per_battle_fr) and poor.kill_sequence_stop_reason == "insufficient_committed_fr" and int(poor.failed_before_battle) == 1)
	optimizer._verified_baseline = candidate
	check("no completed sequence retains baseline", optimizer._select_recommendation([]) == candidate)
	check("completed finalist takes precedence", optimizer._select_recommendation([sliced]) == sliced)
	var passed := true
	for item in checks:
		passed = passed and bool(item.passed)
	return {"passed": passed, "checks": checks}


func core(result: Dictionary) -> Dictionary:
	var answer := {}
	for key in ["outcome", "fleet_resources_committed", "fleet_resources_used", "boss_damage", "simulation_time", "runtime_effect_events"]:
		answer[key] = result.get(key)
	for key in ["player_ships", "enemy_ships"]:
		var ships: Array = result.get(key, []).duplicate(true)
		ships.sort_custom(func(a, b): return JSON.stringify(a) < JSON.stringify(b))
		answer[key] = ships
	return answer
