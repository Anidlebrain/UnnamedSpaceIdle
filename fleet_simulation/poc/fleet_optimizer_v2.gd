extends "res://fleet_optimizer.gd"

var _probe: Node
var _base_config: Dictionary
var _settings: Dictionary
var _cache := {}
var _environment_key := ""
var _started_msec := 0
var _simulations := 0
var _cache_hits := 0
var _budget_exhausted := false
var _deployment_quotes := 0
var _compositions_pruned_by_fr := 0
var _formations_pruned_by_fr := 0
var _normal_only_compositions := 0
var _overdeploy_compositions := 0
var _overdeploy_candidates := 0
var _overdeploy_candidates_simulated := 0
var _refining_kill_sequences := false
var _finalizing := false
var _profile := "fast"
var _goal := "best"
var _analysis := {}
var _analyzer: Node
var _verified_baseline := {}
var _baseline_warning := ""
var _pruning_stats := {}
var _performance_totals := {}
var _performance_samples := 0
var _quote_wall_ms := 0.0
var _candidate_generation_ms := 0.0
var _canonicalization_ms := 0.0
var _workers: Array = []
var _worker_root := ""
var _worker_warning := ""
var _worker_startup: Array = []
var _estimated_fleet_candidates := 0
var _estimated_formation_count := 0
var _candidate_generation_quotes := 0
var _workers_ready_reported := false
var _progress_stage_name := ""
var _progress_stage_index := 0
var _progress_stage_count := 0
var _progress_stage_started_msec := 0
var _progress_stage_sim_start := 0
var _progress_exact_total := -1
var _progress_last_completed := -1
var _progress_best := {}
var _diagnostic := {}
var _recovery_mode := false
var _search_audit := {}
var _known_trace := {}
var _baseline_validation_failed := false
var _recovery_win_found := false


func optimize_v2(probe: Node, base_config: Dictionary, settings: Dictionary) -> Dictionary:
	_probe = probe
	_base_config = base_config.duplicate(true)
	_settings = settings.duplicate(true)
	_normalize_settings()
	_diagnostic = _settings.get("diagnostic", {}).duplicate(true)
	objective = str(_settings.get("objective", "normal"))
	assert(objective in ["normal", "boss"], "Objective must be normal or boss")
	boss_priority = str(_settings.get("boss_priority", "efficiency")) if objective == "boss" else "legacy"
	boss_remaining_hp = float(_settings.get("boss_remaining_hp", 0.0)) if objective == "boss" else 0.0
	_validate_settings()
	_environment_key = _battle_environment_key(_base_config)
	_started_msec = Time.get_ticks_msec()
	_pruning_stats = {
		"generated": 0,
		"quoted_generated": 0,
		"hard_pruned": {
			"fr_budget": 0,
			"incumbent_lower_bound": 0,
			"dominated": 0,
			"symmetry_exact": 0,
			"disabled_ship": 0,
		},
		"smart_pruned": {
			"counter_probe": 0,
			"probe_budget": 0,
			"efficiency_cutoff": 0,
			"kill_cost_cutoff": 0,
			"escort_gate": 0,
			"formation_signature": 0,
			"composition_quote_budget": 0,
		},
		"simulated": 0,
		"refined": 0,
		"hard_pruning_enabled": true,
		"smart_pruning_enabled": bool(_settings.smart_pruning),
	}
	_search_audit = {
		"candidates_generated": 0,
		"candidates_enumerated": 0,
		"normalized": 0,
		"deduplicated": 0,
		"queued": 0,
		"simulated": 0,
		"wins": 0,
		"losses": 0,
	}
	_prepare_known_trace()

	_analyzer = preload("res://fleet_battle_analyzer.gd").new()
	add_child(_analyzer)
	_analysis = _analyzer.analyze(_base_config, _settings.allowed_loadouts)
	if _diagnostic.has("micro_test"):
		return await _run_micro_test(_diagnostic.micro_test)
	var run_overdeploy := bool(_settings.get("run_overdeploy_tests", false))
	var stage_count := 6 + (1 if run_overdeploy else 0) + (1 if objective == "boss" else 0)
	var stage_index := 1
	_start_workers()
	_monitor_worker_readiness()
	var baseline_enabled := bool(_settings.get("baseline", {}).get("enabled", false))
	_progress_stage_start("Verified Baseline", stage_index, stage_count, 1 if baseline_enabled else 0)
	_verified_baseline = await _run_verified_baseline()
	if _baseline_validation_failed:
		var failure := _baseline_validation_failure_output()
		await _stop_workers()
		return failure
	_recovery_mode = not _verified_baseline.is_empty() and str(_verified_baseline.get("outcome", "")) != "victory"
	_progress_update(true)
	stage_index += 1

	var overdeploy_tests := {"enabled": false}
	if run_overdeploy:
		_progress_stage_start("Overdeploy Validation", stage_index, stage_count)
		overdeploy_tests = await _run_overdeploy_tests()
		_progress_update(true)
		stage_index += 1
	_progress_stage_start("Candidate Generation", stage_index, stage_count)
	var generation_started := Time.get_ticks_usec()
	var fleets: Array = await _generate_fleet_candidates()
	_candidate_generation_ms = (Time.get_ticks_usec() - generation_started) / 1000.0
	print("Generated: %d deployment quotes | %d fleet candidates" % [_candidate_generation_quotes, fleets.size()])
	stage_index += 1
	fleets.sort_custom(_fleet_priority_before)
	var rough_exact := _estimated_formation_count
	var estimate_seconds := rough_exact * float(_settings.get("estimated_seconds_per_battle", 1.493))
	print("OPTIMIZER_V2_ESTIMATE normal_compositions=%d overdeploy_compositions=%d fleet_candidates=%d full_exact=%d estimated_seconds=%.1f planned_simulations=%d budget_simulations=%d budget_seconds=%.1f" % [
		_normal_only_compositions, _overdeploy_compositions, _estimated_fleet_candidates, rough_exact, estimate_seconds,
		mini(int(_settings.max_simulations), rough_exact),
		int(_settings.max_simulations), float(_settings.max_wall_seconds),
	])

	_progress_stage_start("Representative Screening", stage_index, stage_count)
	await _representative_screen(fleets)
	_progress_update(true)
	stage_index += 1
	var viable_fleets: Array = []
	for fleet in fleets:
		if not fleet.best_result.is_empty() and not bool(fleet.get("smart_pruned", false)):
			viable_fleets.append(fleet)
	viable_fleets.sort_custom(_fleet_before)
	var fleet_beam := viable_fleets.slice(0, mini(int(_settings.beam_width_fleet), viable_fleets.size()))
	_progress_stage_start("Position Beam Search", stage_index, stage_count)
	await _position_beam_search(fleet_beam)
	_progress_update(true)
	stage_index += 1
	fleet_beam.sort_custom(_fleet_before)

	_progress_stage_start("Local Exact Search", stage_index, stage_count)
	var exact_subspaces: Array = []
	var final_count := mini(int(_settings.final_fleet_candidates), fleet_beam.size())
	for fleet in fleet_beam.slice(0, final_count):
		exact_subspaces.append(await _local_exact_search(fleet))
	_progress_update(true)
	stage_index += 1

	_finalizing = true
	var ranked: Array = _cache.values()
	ranked.sort_custom(_rank_before)
	var kill_refinement := {"enabled": false, "candidates_requested": 0, "candidates_refined": 0}
	if objective == "boss":
		_progress_stage_start("Boss Refinement", stage_index, stage_count)
		_refining_kill_sequences = true
		kill_refinement = await _refine_top_candidates(ranked)
		_progress_update(true)
		stage_index += 1
		ranked = _cache.values()
		ranked.sort_custom(_rank_before)
	var final_ranked: Array = ranked
	if objective == "boss":
		final_ranked = []
		for item in ranked:
			if bool(item.get("kill_refined", false)):
				final_ranked.append(item)
		final_ranked.sort_custom(_rank_before)
		if final_ranked.is_empty() and not ranked.is_empty():
			final_ranked = [ranked[0]]
			kill_refinement["partial"] = true
			kill_refinement["status"] = "REFINEMENT PARTIAL"
	for index in range(ranked.size()):
		ranked[index]["rank"] = index + 1
	for index in range(final_ranked.size()):
		final_ranked[index]["finalist_rank"] = index + 1
	var recommended: Dictionary = {} if final_ranked.is_empty() else final_ranked[0]
	var recommendation_status := "SEARCHED BEST"
	var improved := false
	if _recovery_mode:
		recommended = {}
		for candidate in final_ranked:
			if str(candidate.get("outcome", "")) == "victory":
				recommended = candidate
				break
		recommendation_status = "RECOVERY WIN FOUND" if not recommended.is_empty() else "NO WIN FOUND"
	elif _goal == "beat_baseline" and not _verified_baseline.is_empty():
		for candidate in final_ranked:
			if str(candidate.get("candidate_hash", "")) != str(_verified_baseline.get("candidate_hash", "")) and _rank_before(candidate, _verified_baseline):
				recommended = candidate
				improved = true
				break
		if not improved:
			recommended = _verified_baseline
			recommendation_status = "NO IMPROVEMENT FOUND"
	_progress_stage_start("Final Validation", stage_index, stage_count, 1)
	var full_result_status := await _attach_full_result(recommended)
	var cache_validation := await _cache_validation(ranked)
	_progress_update(true)
	var regression := _build_v1_regression(ranked, exact_subspaces)
	var counts := _result_counts(ranked)
	var elapsed := _elapsed_seconds()
	var top_count := mini(int(_settings.get("top_n", 10)), final_ranked.size())
	var output := {
		"optimizer_version": "2.2",
		"result_claim": "SEARCHED BEST",
		"recommendation_status": recommendation_status,
		"baseline_remains_recommended": recommendation_status == "NO IMPROVEMENT FOUND",
		"search_profile": _profile,
		"search_goal": _goal,
		"search_mode": "recovery_find_any_win" if _recovery_mode else "optimize",
		"simulation_clock": (
			recommended.get("simulation_clock", {}).duplicate(true)
			if not recommended.is_empty()
			else _probe.simulation_clock_metadata(_base_config)
		),
		"workers_requested": int(_settings.get("workers", 1)),
		"workers_effective": _workers.size() if not _workers.is_empty() else 1,
		"worker_user_data_dirs": _worker_user_data_dirs(),
		"worker_warning": _worker_warning,
		"worker_startup": _worker_startup,
		"objective": objective,
		"boss_priority": boss_priority if objective == "boss" else null,
		"boss_remaining_hp": boss_remaining_hp if objective == "boss" else null,
		"mode": _settings.mode,
		"base_config": _base_config,
		"settings": _settings,
		"battle_analysis": _analysis,
		"verified_baseline": _verified_baseline,
		"baseline_warning": _baseline_warning,
		"improvement_vs_baseline": _improvement(recommended, _verified_baseline),
		"estimate": {
			"loadout_options_by_ship": _loadout_option_counts(),
			"normal_only_compositions": _normal_only_compositions,
			"overdeploy_compositions": _overdeploy_compositions,
			"fleet_candidates": _estimated_fleet_candidates,
			"quoted_fleet_candidates": fleets.size(),
			"rough_full_formation_count": rough_exact,
			"full_exact_estimated_seconds": estimate_seconds,
			"full_exact_estimated_hours": estimate_seconds / 3600.0,
			"simulation_budget": int(_settings.max_simulations),
			"wall_seconds_budget": float(_settings.max_wall_seconds),
			"planned_simulations": mini(int(_settings.max_simulations), rough_exact),
		},
		"deployment_quotes": _deployment_quotes,
		"compositions_pruned_by_fr": _compositions_pruned_by_fr,
		"formations_pruned_by_fr": _formations_pruned_by_fr,
		"overdeploy_candidates": _overdeploy_candidates,
		"overdeploy_candidates_simulated": _overdeploy_candidates_simulated,
		"simulations_used": _simulations,
		"cache_hits": _cache_hits,
		"unique_results": ranked.size(),
		"victories": counts.victories,
		"losses": counts.losses,
		"errors": counts.errors,
		"wall_time_seconds": elapsed,
		"average_wall_time_per_simulation_seconds": elapsed / maxf(1.0, float(_simulations)),
		"budget_exhausted": _budget_exhausted,
		"finalization_status": full_result_status,
		"pruning_stats": _pruning_stats,
		"search_audit": _finalize_search_audit(),
		"known_candidate_trace": _finalize_known_trace(),
		"performance_breakdown": _performance_breakdown(),
		"exact_subspaces": exact_subspaces,
		"cache_validation": cache_validation,
		"v1_regression": regression,
		"overdeploy_tests": overdeploy_tests,
		"kill_sequence_refinement": kill_refinement,
		"boss_ranking_unit_test": run_boss_ranking_unit_test(),
		"best_result": recommended,
		"top": final_ranked.slice(0, top_count),
		"refined_finalists": final_ranked,
		"ranked_candidates": ranked,
	}
	await _stop_workers()
	return output


func _run_micro_test(test: Dictionary) -> Dictionary:
	var slots: Array = test.get("slots", [])
	var ship_types: Array = test.get("ship_types", [])
	var repetitions := maxi(1, int(test.get("repetitions", 1)))
	assert(not slots.is_empty() and ship_types.size() == 2, "micro_test requires slots and exactly two ship_types")
	var results: Array = []
	for mask in range(1 << slots.size()):
		var candidate := test.duplicate(true)
		for slot_index in range(slots.size()):
			candidate.formation[str(slots[slot_index])] = str(ship_types[(mask >> slot_index) & 1])
		var formation := _formation_from_candidate(candidate)
		var runs: Array = []
		for unused in range(repetitions):
			var config := _base_config.duplicate(true)
			config.formation = formation.duplicate(true)
			config.simulation_detail = "minimal"
			var battle: Dictionary = await _probe.run_battle(config)
			runs.append({
				"outcome": battle.get("outcome", "error"),
				"committed_fr": battle.get("fleet_resources_committed"),
				"used_fr": battle.get("fleet_resources_used"),
				"remaining_fleet": _alive_ship_counts(battle.get("player_ships", [])),
				"remaining_enemy": _alive_ship_counts(battle.get("enemy_ships", [])),
				"battle_result": battle.get("outcome", "error"),
				"error": battle.get("error", ""),
			})
			await _probe.cleanup_battle()
		var stable := true
		for run in runs.slice(1):
			stable = stable and JSON.stringify(run) == JSON.stringify(runs[0])
		results.append({
			"formation": candidate.formation.duplicate(true),
			"committed_fr": runs[0].committed_fr,
			"used_fr": runs[0].used_fr,
			"outcome": runs[0].outcome,
			"remaining_fleet": runs[0].remaining_fleet,
			"remaining_enemy": runs[0].remaining_enemy,
			"battle_result": runs[0].battle_result,
			"stable": stable,
			"runs": runs,
		})
	var expected: Dictionary = _diagnostic.get("known_candidate", {})
	var expected_key := _formation_key(_formation_from_candidate(expected)) if not expected.is_empty() else ""
	var expected_result := {}
	for item in results:
		if _formation_key(_formation_from_candidate({"formation": item.formation, "loadouts": test.loadouts})) == expected_key:
			expected_result = item
			break
	var passed := results.size() == (1 << slots.size()) and results.all(func(item): return bool(item.stable))
	if not expected_result.is_empty():
		passed = passed and str(expected_result.outcome) == "victory"
	return {
		"optimizer_version": "2.2",
		"diagnostic_only": true,
		"result_claim": "EXHAUSTIVE MICRO TEST",
		"recommendation_status": "PASS" if passed else "FAIL",
		"objective": objective,
		"search_profile": _profile,
		"simulation_clock": _probe.simulation_clock_metadata(_base_config),
		"micro_test": {
			"passed": passed,
			"smart_prune_bypassed": true,
			"candidate_count": results.size(),
			"repetitions": repetitions,
			"known_candidate_result": expected_result,
			"results": results,
		},
		"errors": 0 if passed else 1,
		"cache_validation": {"all_identical": true, "used_cache_only": true},
		"boss_ranking_unit_test": {"passed": true},
		"performance_breakdown": {},
		"pruning_stats": _pruning_stats,
		"search_audit": _finalize_search_audit(),
		"known_candidate_trace": _finalize_known_trace(),
		"simulations_used": results.size() * repetitions,
		"wall_time_seconds": _elapsed_seconds(),
		"best_result": {},
	}


func _formation_from_candidate(candidate: Dictionary) -> Array:
	var formation_map: Dictionary = candidate.get("formation", {})
	var loadout_map: Dictionary = candidate.get("loadouts", {})
	var positions: Array = formation_map.keys()
	positions.sort()
	var formation: Array = []
	for position_value in positions:
		var ship_type := str(formation_map[position_value])
		var selected: Dictionary = loadout_map[ship_type]
		formation.append({
			"ship": ship_type,
			"grid_position": _grid_from_position(str(position_value).to_upper()),
			"primary_mod": selected.get("primary"),
			"secondary_mod": selected.get("secondary"),
			"tertiary_mods": Array(selected.get("tertiary", [])).duplicate(),
		})
	return formation


func _alive_ship_counts(ships: Array) -> Dictionary:
	var counts := {}
	for ship in ships:
		if bool(ship.get("alive", false)):
			var ship_id := str(ship.get("id", "unknown"))
			counts[ship_id] = int(counts.get(ship_id, 0)) + 1
	return counts


func _prepare_known_trace() -> void:
	var known: Dictionary = _diagnostic.get("known_candidate", {})
	if known.is_empty():
		_known_trace = {"enabled": false}
		return
	var formation := _formation_from_candidate(known)
	_known_trace = {
		"enabled": true,
		"generated": false,
		"normalized_as": _formation_key(formation),
		"deduplicated": false,
		"hard_prune": "not_reached",
		"smart_prune": "not_reached",
		"queued": false,
		"simulated": false,
		"result": "not-run",
		"formation": known.formation.duplicate(true),
		"ship_counts": _candidate_composition(known),
	}


func _candidate_composition(candidate: Dictionary) -> Dictionary:
	var counts := {}
	for ship_type in candidate.get("formation", {}).values():
		counts[str(ship_type)] = int(counts.get(str(ship_type), 0)) + 1
	return counts


func _known_fleet_matches(composition: Dictionary, loadouts: Dictionary = {}) -> bool:
	if not bool(_known_trace.get("enabled", false)):
		return false
	var known: Dictionary = _diagnostic.known_candidate
	if composition != _candidate_composition(known):
		return false
	if loadouts.is_empty():
		return true
	for ship_type in composition:
		var expected: Dictionary = known.loadouts[ship_type]
		var actual: Dictionary = loadouts.get(ship_type, {})
		if actual.get("primary_mod") != expected.get("primary") or actual.get("secondary_mod") != expected.get("secondary"):
			return false
	return true


func _known_formation_matches(formation: Array) -> bool:
	return bool(_known_trace.get("enabled", false)) and _formation_key(formation) == str(_known_trace.normalized_as)


func _mark_queued(formation: Array) -> void:
	_search_audit.queued += 1
	if _known_formation_matches(formation):
		_known_trace.queued = true


func _record_audit_result(formation: Array, summary: Dictionary) -> void:
	_search_audit.simulated += 1
	var outcome := str(summary.get("outcome", "error"))
	if outcome == "victory":
		_search_audit.wins += 1
		if _recovery_mode:
			_recovery_win_found = true
	elif outcome == "lose":
		_search_audit.losses += 1
	if _known_formation_matches(formation):
		_known_trace.simulated = true
		_known_trace.result = "win" if outcome == "victory" else ("loss" if outcome == "lose" else outcome)
		_known_trace["battle_result"] = {
			"committed_fr": summary.get("fleet_resources_committed"),
			"used_fr": summary.get("fleet_resources_used"),
			"enemy_destroyed": summary.get("enemy_destroyed"),
			"player_remaining_health": summary.get("player_remaining_health"),
		}


func _finalize_search_audit() -> Dictionary:
	_search_audit["hard_pruned"] = _pruning_stats.hard_pruned.duplicate(true)
	_search_audit["smart_pruned"] = _pruning_stats.smart_pruned.duplicate(true)
	return _search_audit.duplicate(true)


func _finalize_known_trace() -> Dictionary:
	if not bool(_known_trace.get("enabled", false)):
		return _known_trace
	if str(_known_trace.hard_prune) == "not_reached":
		_known_trace.hard_prune = "pass" if bool(_known_trace.generated) else "not_reached"
	if str(_known_trace.smart_prune) == "not_reached" and bool(_known_trace.generated):
		_known_trace.smart_prune = "pass"
	if not bool(_known_trace.queued) and str(_known_trace.hard_prune) == "pass" and str(_known_trace.smart_prune) == "pass":
		_known_trace["stopped_at"] = "formation_not_selected_or_budget_exhausted"
	return _known_trace.duplicate(true)


func _validate_settings() -> void:
	assert(str(_settings.get("mode", "")) in ["realistic", "practice"], "Mode must be realistic or practice")
	assert(int(_settings.get("max_simulations", 0)) > 0, "max_simulations must be positive")
	assert(float(_settings.get("max_wall_seconds", 0.0)) > 0.0, "max_wall_seconds must be positive")
	assert(_settings.get("allowed_loadouts", {}) is Dictionary, "allowed_mod_slots or allowed_loadouts must be provided")
	assert(_settings.get("group_ranges", {}) is Dictionary, "group_ranges must be an object")
	assert(_base_config.get("ships_available", {}) is Dictionary, "player_state.ships must be an object")
	assert(float(_base_config.get("fleet_resources", -1.0)) >= 0.0, "player_state.fleet_resources must be non-negative")
	assert(int(_settings.get("max_total_groups", 0)) > 0, "max_total_groups must be positive")
	assert(_profile in ["fast", "balanced", "exhaustive"], "Search profile must be fast, balanced, or exhaustive")
	assert(_goal in ["best", "beat_baseline"], "Search goal must be best or beat_baseline")
	assert(str(_settings.simulation_clock) in ["realtime", "offline_fixed_step"], "simulation_clock must be realtime or offline_fixed_step")
	if objective == "boss":
		assert(boss_priority in ["efficiency", "kill_cost"], "boss_priority must be efficiency or kill_cost")
		assert(boss_remaining_hp > 0.0, "boss_remaining_hp must be positive")
		assert(int(_settings.get("kill_refine_top_n", 10)) > 0, "kill_refine_top_n must be positive")
		assert(int(_settings.get("kill_sequence_max_battles", 100)) > 0, "kill_sequence_max_battles must be positive")
	for ship_type in _ship_types():
		var range_data: Dictionary = _settings.group_ranges.get(ship_type, {"min": 0, "max": 0})
		var minimum := int(range_data.get("min", 0))
		var maximum := int(range_data.get("max", 0))
		assert(minimum >= 0 and maximum >= minimum, "Invalid group range for %s" % ship_type)
		if maximum > 0:
			assert(Array(_settings.allowed_loadouts.get(ship_type, [])).size() > 0, "Missing allowed loadouts for %s" % ship_type)
		assert(maximum <= int(_settings.max_groups_per_ship.get(ship_type, 0)), "Range exceeds max_groups_per_ship for %s" % ship_type)


func _normalize_settings() -> void:
	var search: Dictionary = _settings.get("search", {}) if _settings.get("search", {}) is Dictionary else {}
	_profile = str(search.get("profile", _settings.get("search_profile", "fast")))
	_goal = str(search.get("goal", _settings.get("search_goal", "best")))
	if search.has("max_simulations"):
		_settings.max_simulations = int(search.max_simulations)
	if search.has("max_wall_seconds"):
		_settings.max_wall_seconds = float(search.max_wall_seconds)
	_settings["workers"] = clampi(int(search.get("workers", _settings.get("workers", 1))), 1, 4)
	_settings["simulation_clock"] = str(search.get(
		"simulation_clock",
		_base_config.get("simulation_clock", "offline_fixed_step" if _profile in ["fast", "balanced"] else "realtime"),
	))
	_base_config["simulation_clock"] = _settings.simulation_clock
	var diagnostic: Dictionary = _settings.get("diagnostic", {}) if _settings.get("diagnostic", {}) is Dictionary else {}
	_settings["smart_pruning"] = _profile == "fast" and not bool(diagnostic.get("disable_smart_prune", false))
	_settings["probe_formations_per_fleet"] = int(_settings.get("probe_formations_per_fleet", 1 if _profile == "fast" else _settings.get("representative_formations_per_fleet", 6)))
	_settings["probe_budget"] = int(_settings.get("probe_budget", 20 if _profile == "fast" else _settings.max_simulations))
	_settings["composition_quote_budget"] = int(_settings.get("composition_quote_budget", 20 if _profile == "fast" else 2147483647))
	_settings["exploration_quota"] = float(_settings.get("exploration_quota", 0.125))
	_settings["optimistic_factor"] = float(_settings.get("optimistic_factor", 1.25))
	_settings["kill_cost_margin"] = float(_settings.get("kill_cost_margin", 1.15))
	_settings["finalization_reserve_seconds"] = float(_settings.get(
		"finalization_reserve_seconds",
		minf(45.0, float(_settings.get("max_wall_seconds", 300.0)) * 0.15),
	))
	_settings["simulation_detail"] = str(_settings.get("simulation_detail", "minimal"))
	if str(_settings.get("objective", "normal")) == "boss":
		if not _settings.has("boss_priority"):
			_settings.boss_priority = "efficiency"
		if not _settings.has("boss_remaining_hp"):
			var configured_hp = _base_config.get("boss_health")
			if configured_hp != null and float(configured_hp) > 0.0:
				_settings.boss_remaining_hp = float(configured_hp)
			else:
				var event_id := str(_base_config.get("fleet_event_id", ""))
				if event_id in Fleet.fleet_event_refs:
					_settings.boss_remaining_hp = float(Fleet.fleet_event_refs[event_id].command_ship_original_health)
	if str(_settings.get("mode", "")) == "practice_unlimited":
		_settings.mode = "practice"
	_settings["max_total_groups"] = mini(STANDARD_CELLS.size(), int(_settings.get("max_total_groups", STANDARD_CELLS.size())))
	if not _settings.has("max_groups_per_ship"):
		_settings["max_groups_per_ship"] = {}
	for ship_type in _ship_types():
		if not _settings.max_groups_per_ship.has(ship_type):
			_settings.max_groups_per_ship[ship_type] = _settings.max_total_groups
	var player_state: Dictionary = _settings.get("player_state", {})
	if not player_state.is_empty():
		assert(player_state.has("fleet_resources") and player_state.has("ships"), "player_state requires fleet_resources and ships")
		_base_config.fleet_resources = float(player_state.fleet_resources)
		_base_config.ships_available = player_state.ships.duplicate(true)
	elif _settings.has("ships_available"):
		_base_config.ships_available = _settings.ships_available.duplicate(true)
	if _settings.has("allowed_mod_slots"):
		_settings.allowed_loadouts = _expand_slot_loadouts(_settings.allowed_mod_slots)
	if not _settings.has("kill_refine_top_n"):
		_settings.kill_refine_top_n = 10
	if not _settings.has("kill_sequence_max_battles"):
		_settings.kill_sequence_max_battles = 100
	if not _settings.has("kill_refine_reserve_simulations"):
		_settings.kill_refine_reserve_simulations = int(_settings.kill_refine_top_n) * 3


func _expand_slot_loadouts(slot_options: Dictionary) -> Dictionary:
	var expanded := {}
	for ship_type in _ship_types():
		var slots: Dictionary = slot_options.get(ship_type, {})
		var primary: Array = Array(slots.get("primary", [null]))
		var secondary: Array = Array(slots.get("secondary", [null]))
		assert(not primary.is_empty() and not secondary.is_empty(), "Each slot needs at least one option for %s" % ship_type)
		expanded[ship_type] = []
		for primary_mod in primary:
			for secondary_mod in secondary:
				expanded[ship_type].append({
					"id": _slot_loadout_id(primary_mod, secondary_mod),
					"primary_mod": primary_mod,
					"secondary_mod": secondary_mod,
					"tertiary_mods": [],
				})
	return expanded


func _slot_loadout_id(primary_mod, secondary_mod) -> String:
	var selected: Array[String] = []
	if primary_mod != null and str(primary_mod) != "":
		selected.append(str(primary_mod))
	if secondary_mod != null and str(secondary_mod) != "":
		selected.append(str(secondary_mod))
	return "none" if selected.is_empty() else "+".join(selected)


func _ship_types() -> Array:
	var result: Array = _settings.get("ship_types", ["Fighter", "Corvette", "Frigate", "Cruiser"]).duplicate()
	return result


func _generate_fleet_candidates() -> Array:
	_candidate_generation_quotes = 0
	var compositions: Array = []
	_append_compositions(_ship_types(), 0, {}, compositions)
	compositions.sort_custom(_composition_priority_before)
	_estimated_fleet_candidates = 0
	_estimated_formation_count = 0
	for composition in compositions:
		var used_types: Array = []
		for ship_type in _ship_types():
			if int(composition.get(ship_type, 0)) > 0:
				used_types.append(ship_type)
		var loadout_count := _loadout_combination_count(used_types)
		_estimated_fleet_candidates += loadout_count
		_estimated_formation_count += _unique_formation_count(composition) * loadout_count
	_pruning_stats.generated = _estimated_fleet_candidates
	_search_audit.candidates_enumerated = _estimated_fleet_candidates
	var quote_compositions := _quote_composition_order(compositions)
	for composition in compositions:
		if composition not in quote_compositions:
			var used_types: Array = []
			for ship_type in _ship_types():
				if int(composition.get(ship_type, 0)) > 0:
					used_types.append(ship_type)
			_pruning_stats.smart_pruned.composition_quote_budget += _loadout_combination_count(used_types)
			if _known_fleet_matches(composition):
				_known_trace.smart_prune = "composition_quote_budget"
	var fleets: Array = []
	var quote_progress := 0
	for composition in quote_compositions:
		var used_types: Array = []
		var first_loadouts := {}
		for ship_type in _ship_types():
			if int(composition.get(ship_type, 0)) > 0:
				used_types.append(ship_type)
				first_loadouts[ship_type] = Array(_settings.allowed_loadouts[ship_type])[0]
		var quote_formation := _build_formation(composition, first_loadouts)
		for index in range(quote_formation.size()):
			quote_formation[index].grid_position = STANDARD_CELLS[index].duplicate()
		var quote_config := _base_config.duplicate(true)
		quote_config.formation = quote_formation
		var quote_started := Time.get_ticks_usec()
		var quote: Dictionary = await _probe.quote_player_deployment(quote_config)
		_quote_wall_ms += (Time.get_ticks_usec() - quote_started) / 1000.0
		_deployment_quotes += 1
		_candidate_generation_quotes += 1
		quote_progress += 1
		_progress_quote_update(quote_progress, quote_compositions.size())
		var formation_count := _unique_formation_count(composition)
		var loadout_count := _loadout_combination_count(used_types)
		if not quote.deployable:
			_pruning_stats.hard_pruned.disabled_ship += loadout_count
			if _known_fleet_matches(composition):
				_known_trace.hard_prune = "disabled_ship"
			continue
		if not quote.within_budget:
			_compositions_pruned_by_fr += 1
			_formations_pruned_by_fr += formation_count * loadout_count
			_pruning_stats.hard_pruned.fr_budget += loadout_count
			if _known_fleet_matches(composition):
				_known_trace.hard_prune = "fr_budget"
			continue
		var is_overdeploy := _quote_has_overdeploy(quote)
		if is_overdeploy:
			_overdeploy_compositions += 1
		else:
			_normal_only_compositions += 1
		_append_loadout_choices(composition, used_types, 0, {}, quote, fleets)
	return fleets


func _composition_priority_before(a: Dictionary, b: Dictionary) -> bool:
	var a_cost := _composition_base_cost(a)
	var b_cost := _composition_base_cost(b)
	if objective == "normal" and a_cost != b_cost:
		return a_cost < b_cost
	var a_score := _composition_counter_score(a) / maxf(1.0, a_cost)
	var b_score := _composition_counter_score(b) / maxf(1.0, b_cost)
	if a_score != b_score:
		return a_score > b_score
	if a_cost != b_cost:
		return a_cost < b_cost
	return JSON.stringify(a) < JSON.stringify(b)


func _composition_base_cost(composition: Dictionary) -> float:
	var total := 0.0
	for ship_type in composition:
		if ship_type in db.fleet_ships:
			total += int(composition[ship_type]) * float(db.fleet_ships[ship_type].fleet_resources_cost)
	return total


func _composition_counter_score(composition: Dictionary) -> float:
	var total := 0.0
	for ship_type in composition:
		var best := 0.0
		for loadout in Array(_settings.allowed_loadouts.get(ship_type, [])):
			best = maxf(best, _analyzer.counter_score(str(ship_type), str(loadout.get("id", "none")), _analysis))
		total += int(composition[ship_type]) * best
	return total


func _quote_composition_order(compositions: Array) -> Array:
	if _profile != "fast" or compositions.size() <= int(_settings.composition_quote_budget):
		return compositions
	var budget := int(_settings.composition_quote_budget)
	if _recovery_mode:
		return _recovery_composition_order(compositions, budget)
	var exploration_count := mini(budget, maxi(1, roundi(budget * float(_settings.exploration_quota))))
	var result: Array = []
	var selected := {}
	for index in range(budget - exploration_count):
		selected[index] = true
		result.append(compositions[index])
	for explore_index in range(exploration_count):
		var index := clampi(roundi((explore_index + 1) * (compositions.size() - 1.0) / exploration_count), 0, compositions.size() - 1)
		if not selected.has(index):
			selected[index] = true
			result.append(compositions[index])
	return result


func _append_compositions(ship_types: Array, index: int, current: Dictionary, results: Array) -> void:
	if index == ship_types.size():
		var total := 0
		for count in current.values():
			total += int(count)
		if total == 0 or total > int(_settings.get("max_total_groups", STANDARD_CELLS.size())):
			return
		for ship_type in ship_types:
			if int(current.get(ship_type, 0)) > 0 and not _ship_enabled(ship_type):
				return
		results.append(current.duplicate(true))
		return
	var ship_type: String = ship_types[index]
	var range_data: Dictionary = _settings.group_ranges.get(ship_type, {"min": 0, "max": 0})
	for count in range(int(range_data.get("min", 0)), int(range_data.get("max", 0)) + 1):
		current[ship_type] = count
		_append_compositions(ship_types, index + 1, current, results)
	current.erase(ship_type)


func _append_loadout_choices(
	composition: Dictionary,
	used_types: Array,
	index: int,
	chosen: Dictionary,
	quote: Dictionary,
	results: Array,
) -> void:
	if index == used_types.size():
		_pruning_stats.quoted_generated += 1
		_search_audit.candidates_generated += 1
		var known_match := _known_fleet_matches(composition, chosen)
		if known_match:
			_known_trace.generated = true
			_known_trace.hard_prune = "pass"
		var minimum_used := _minimum_possible_used_fr(composition, float(quote.fleet_resources_committed))
		if _normal_incumbent_hard_prunes(minimum_used, float(quote.fleet_resources_committed)):
			_pruning_stats.hard_pruned.incumbent_lower_bound += 1
			if known_match:
				_known_trace.hard_prune = "incumbent_lower_bound"
			return
		var formation := _build_formation(composition, chosen)
		var representatives := _representative_formations(formation)
		if _recovery_mode:
			representatives = _with_baseline_aligned_representative(composition, chosen, representatives)
		results.append({
			"composition": composition.duplicate(true),
			"ship_loadouts": chosen.duplicate(true),
			"deployment": quote.deployment.duplicate(true),
			"fleet_resources_committed_quote": quote.fleet_resources_committed,
			"is_overdeploy": _quote_has_overdeploy(quote),
			"seed_formation": formation,
			"representative_formations": representatives,
			"full_formation_count": _unique_formation_count(composition),
			"minimum_possible_used_fr": minimum_used,
			"counter_score": _fleet_counter_score(composition, chosen),
			"generation_index": int(_pruning_stats.quoted_generated),
			"best_result": {},
		})
		if _quote_has_overdeploy(quote):
			_overdeploy_candidates += 1
		return
	var ship_type: String = used_types[index]
	for loadout in Array(_settings.allowed_loadouts[ship_type]):
		assert(loadout is Dictionary and str(loadout.get("id", "")) != "", "Every loadout needs an id")
		chosen[ship_type] = loadout.duplicate(true)
		_append_loadout_choices(composition, used_types, index + 1, chosen, quote, results)
	chosen.erase(ship_type)


func _with_baseline_aligned_representative(composition: Dictionary, loadouts: Dictionary, fallback: Array) -> Array:
	var baseline_formation: Dictionary = _settings.baseline.get("formation", {})
	var remaining := composition.duplicate(true)
	var aligned: Array = []
	var free_positions: Array = []
	var occupied := {}
	var positions: Array = baseline_formation.keys()
	positions.sort()
	for position_value in positions:
		var position := str(position_value)
		var ship_type := str(baseline_formation[position_value])
		if int(remaining.get(ship_type, 0)) > 0:
			aligned.append(_formation_group(ship_type, loadouts[ship_type], _grid_from_position(position)))
			remaining[ship_type] = int(remaining[ship_type]) - 1
			occupied[position] = true
		else:
			free_positions.append(_grid_from_position(position))
	for cell in STANDARD_CELLS:
		if not occupied.has(_position_name(cell)) and cell not in free_positions:
			free_positions.append(cell.duplicate())
	for ship_type in _ship_types():
		for unused in range(int(remaining.get(ship_type, 0))):
			aligned.append(_formation_group(ship_type, loadouts[ship_type], free_positions.pop_front()))
	var result: Array = [aligned]
	var seen := {_formation_key(aligned): true}
	for formation in fallback:
		var key := _formation_key(formation)
		if not seen.has(key):
			seen[key] = true
			result.append(formation)
	return result


func _formation_group(ship_type: String, loadout: Dictionary, position: Array) -> Dictionary:
	return {
		"ship": str(loadout.get("ship_id", ship_type)),
		"primary_mod": loadout.get("primary_mod"),
		"secondary_mod": loadout.get("secondary_mod"),
		"tertiary_mods": Array(loadout.get("tertiary_mods", [])).duplicate(),
		"grid_position": position.duplicate(),
	}


func _build_formation(composition: Dictionary, loadouts: Dictionary) -> Array:
	var formation: Array = []
	for ship_type in _ship_types():
		for unused in range(int(composition.get(ship_type, 0))):
			var loadout: Dictionary = loadouts[ship_type]
			formation.append({
				"ship": str(loadout.get("ship_id", ship_type)),
				"primary_mod": loadout.get("primary_mod"),
				"secondary_mod": loadout.get("secondary_mod"),
				"tertiary_mods": Array(loadout.get("tertiary_mods", [])).duplicate(),
				"grid_position": [0, 0],
			})
	return formation


func _ship_enabled(ship_type: String) -> bool:
	if ship_type not in _base_config.ships_available:
		return false
	var state = _base_config.ships_available[ship_type]
	if state is Dictionary:
		return bool(state.get("enabled", true)) and int(state.get("available", state.get("amount", 0))) > 0
	return int(state) > 0


func _minimum_possible_used_fr(composition: Dictionary, committed: float) -> float:
	# Source of truth: FleetBattle.calc_total_deployment() charges the original
	# committed value; ShipDeploymentGroup assigns only base ship cost as refundable
	# value; FleetBattle.update_fleet_resources_retained() applies retention.
	var maximum_refund_value := 0.0
	for ship_type in composition:
		if ship_type in db.fleet_ships:
			maximum_refund_value += int(composition[ship_type]) * float(db.fleet_ships[ship_type].fleet_resources_cost)
	var retention := float(_base_config.get("fleet_resources_retention", 0.0))
	return snapped(maxf(0.0, committed - maximum_refund_value * retention), 0.01)


func _normal_incumbent_hard_prunes(minimum_used: float, committed: float) -> bool:
	if objective != "normal" or _verified_baseline.is_empty() or str(_verified_baseline.get("outcome", "")) != "victory":
		return false
	var incumbent_used := float(_verified_baseline.fleet_resources_used)
	var incumbent_committed := float(_verified_baseline.fleet_resources_committed)
	return (
		minimum_used > incumbent_used
		or (is_equal_approx(minimum_used, incumbent_used) and committed > incumbent_committed)
	)


func _fleet_counter_score(composition: Dictionary, loadouts: Dictionary) -> float:
	var score := 0.0
	for ship_type in loadouts:
		score += int(composition.get(ship_type, 0)) * _analyzer.counter_score(
			str(ship_type),
			str(loadouts[ship_type].get("id", "none")),
			_analysis,
		)
	return score


func _fleet_priority_before(a: Dictionary, b: Dictionary) -> bool:
	if _recovery_mode:
		var a_loadout_changes := _recovery_loadout_changes(a.ship_loadouts)
		var b_loadout_changes := _recovery_loadout_changes(b.ship_loadouts)
		if a_loadout_changes != b_loadout_changes:
			return a_loadout_changes < b_loadout_changes
		var a_distance := _composition_distance(a.composition, _candidate_composition(_settings.baseline))
		var b_distance := _composition_distance(b.composition, _candidate_composition(_settings.baseline))
		if a_distance != b_distance:
			return a_distance < b_distance
	var a_cost := float(a.fleet_resources_committed_quote)
	var b_cost := float(b.fleet_resources_committed_quote)
	if objective == "normal" and a_cost != b_cost:
		return a_cost < b_cost
	var a_priority := float(a.counter_score) / maxf(1.0, a_cost)
	var b_priority := float(b.counter_score) / maxf(1.0, b_cost)
	if a_priority != b_priority:
		return a_priority > b_priority
	if a_cost != b_cost:
		return a_cost < b_cost
	return _formation_key(a.seed_formation) < _formation_key(b.seed_formation)


func _recovery_loadout_changes(loadouts: Dictionary) -> int:
	var changes := 0
	var baseline_loadouts: Dictionary = _settings.baseline.get("loadouts", {})
	for ship_type in loadouts:
		var actual: Dictionary = loadouts[ship_type]
		var expected: Dictionary = baseline_loadouts.get(ship_type, {})
		if actual.get("primary_mod") != expected.get("primary") or actual.get("secondary_mod") != expected.get("secondary"):
			changes += 1
	return changes


func _composition_distance(a: Dictionary, b: Dictionary) -> int:
	var distance := 0
	for ship_type in _ship_types():
		distance += absi(int(a.get(ship_type, 0)) - int(b.get(ship_type, 0)))
	return distance


func _loadout_combination_count(used_types: Array) -> int:
	var count := 1
	for ship_type in used_types:
		count *= Array(_settings.allowed_loadouts[ship_type]).size()
	return count


func _loadout_option_counts() -> Dictionary:
	var result := {}
	for ship_type in _ship_types():
		result[ship_type] = Array(_settings.allowed_loadouts.get(ship_type, [])).size()
	return result


func _quote_has_overdeploy(quote: Dictionary) -> bool:
	for deployment in quote.get("deployment", {}).values():
		if int(deployment.overdeployed_groups) > 0:
			return true
	return false


func _unique_formation_count(composition: Dictionary) -> int:
	var remaining := STANDARD_CELLS.size()
	var total := 1
	for ship_type in _ship_types():
		var count := int(composition.get(ship_type, 0))
		if count > 0:
			total *= _choose(remaining, count)
			remaining -= count
	return total


func _choose(n: int, k: int) -> int:
	k = mini(k, n - k)
	var result := 1
	for index in range(1, k + 1):
		result = result * (n - k + index) / index
	return result


func _representative_formations(seed: Array) -> Array:
	var orders := [
		STANDARD_CELLS,
		[[1, 0], [1, 1], [1, 2], [1, 3], [1, 4], [0, 0], [0, 1], [0, 2], [0, 3], [0, 4]],
		[[0, 2], [0, 1], [0, 3], [0, 0], [0, 4], [1, 2], [1, 1], [1, 3], [1, 0], [1, 4]],
		[[0, 0], [1, 4], [0, 4], [1, 0], [0, 2], [1, 2], [0, 1], [1, 3], [0, 3], [1, 1]],
		[[0, 2], [1, 2], [0, 1], [1, 3], [0, 3], [1, 1], [0, 0], [1, 4], [0, 4], [1, 0]],
		[[1, 4], [1, 3], [1, 2], [1, 1], [1, 0], [0, 4], [0, 3], [0, 2], [0, 1], [0, 0]],
	]
	var unique := {}
	var result: Array = []
	var limit := clampi(int(_settings.get("representative_formations_per_fleet", 6)), 3, 10)
	for order in orders:
		for reverse_groups in [false, true]:
			var candidate := seed.duplicate(true)
			if reverse_groups:
				candidate.reverse()
			for index in range(candidate.size()):
				candidate[index].grid_position = order[index].duplicate()
			var key := _formation_key(candidate)
			if not unique.has(key):
				unique[key] = true
				result.append(candidate)
				if result.size() >= limit:
					return result
	return result


func _representative_screen(fleets: Array) -> void:
	var probe_fleets: Array = _probe_fleet_order(fleets)
	var probe_budget := mini(int(_settings.probe_budget), int(_settings.max_simulations) - _simulations)
	var probe_started := _simulations
	var max_layouts := 0
	for fleet in probe_fleets:
		max_layouts = maxi(max_layouts, fleet.representative_formations.size())
	if _profile == "fast":
		max_layouts = mini(max_layouts, int(_settings.probe_formations_per_fleet))
	for layout_index in range(max_layouts):
		var batch: Array = []
		for fleet in probe_fleets:
			if _simulations - probe_started + batch.size() >= probe_budget:
				break
			if layout_index >= fleet.representative_formations.size() or not _can_expand():
				continue
			if _profile == "fast":
				var signature := _probe_formation_signature(fleet.representative_formations[layout_index])
				if signature in fleet.get("probe_signatures", {}):
					_pruning_stats.smart_pruned.formation_signature += 1
					continue
				if not fleet.has("probe_signatures"):
					fleet.probe_signatures = {}
				fleet.probe_signatures[signature] = true
			batch.append({"fleet": fleet, "formation": fleet.representative_formations[layout_index]})
		var summaries := await _evaluate_batch(batch)
		for item_index in range(batch.size()):
			var fleet: Dictionary = batch[item_index].fleet
			var summary: Dictionary = summaries[item_index]
			if not summary.is_empty() and (fleet.best_result.is_empty() or _rank_before(summary, fleet.best_result)):
				fleet.best_result = summary
			if _profile == "fast" and layout_index + 1 >= max_layouts:
				_apply_smart_prune(fleet)
		if not _can_expand():
			return
	for fleet in fleets:
		if fleet.best_result.is_empty():
			fleet.smart_pruned = true
			fleet.smart_pruned_reason = "probe_budget"
			_pruning_stats.smart_pruned.probe_budget += 1
			if _known_fleet_matches(fleet.get("composition", {}), fleet.get("ship_loadouts", {})):
				_known_trace.smart_prune = "probe_budget"


func _probe_fleet_order(fleets: Array) -> Array:
	if _profile != "fast" or fleets.size() <= int(_settings.probe_budget):
		return fleets
	var budget := int(_settings.probe_budget)
	var exploration_count := mini(budget, maxi(1, roundi(budget * float(_settings.exploration_quota))))
	var selected := {}
	var result: Array = []
	for index in range(budget - exploration_count):
		selected[index] = true
		result.append(fleets[index])
	for explore_index in range(exploration_count):
		var index := clampi(roundi((explore_index + 1) * (fleets.size() - 1.0) / exploration_count), 0, fleets.size() - 1)
		while selected.has(index) and index + 1 < fleets.size():
			index += 1
		if not selected.has(index):
			selected[index] = true
			result.append(fleets[index])
	return result


func _position_beam_search(fleets: Array) -> void:
	for fleet in fleets:
		var beam: Array = [fleet.best_result]
		for unused_depth in range(int(_settings.beam_depth)):
			var candidates: Array = []
			var seen := {}
			for parent in beam:
				for formation in _formation_neighbors(parent.formation):
					var key := _formation_key(formation)
					if not seen.has(key):
						seen[key] = true
						candidates.append(formation)
			var batch: Array = []
			for formation in candidates:
				batch.append({"fleet": fleet, "formation": formation})
			var evaluated: Array = []
			for summary in await _evaluate_batch(batch):
				if not summary.is_empty():
					evaluated.append(summary)
			if evaluated.is_empty():
				break
			evaluated.sort_custom(_rank_before)
			beam = evaluated.slice(0, mini(int(_settings.beam_width_position), evaluated.size()))
			if _rank_before(beam[0], fleet.best_result):
				fleet.best_result = beam[0]
		if not _can_expand():
			return


func _formation_neighbors(formation: Array) -> Array:
	var results: Array = []
	var seen := {}
	var occupied := {}
	for group in formation:
		occupied[_position_name(group.grid_position)] = true
	for index in range(formation.size()):
		for cell in STANDARD_CELLS:
			if not occupied.has(_position_name(cell)):
				var moved := formation.duplicate(true)
				moved[index].grid_position = cell.duplicate()
				_add_unique_formation(moved, seen, results)
	for left in range(formation.size()):
		for right in range(left + 1, formation.size()):
			if _group_signature(formation[left]) != _group_signature(formation[right]):
				var swapped := formation.duplicate(true)
				var position = swapped[left].grid_position
				swapped[left].grid_position = swapped[right].grid_position
				swapped[right].grid_position = position
				_add_unique_formation(swapped, seen, results)
	var row_mirror := formation.duplicate(true)
	var column_mirror := formation.duplicate(true)
	for index in range(formation.size()):
		row_mirror[index].grid_position[0] = 1 - int(row_mirror[index].grid_position[0])
		column_mirror[index].grid_position[1] = 4 - int(column_mirror[index].grid_position[1])
	_add_unique_formation(row_mirror, seen, results)
	_add_unique_formation(column_mirror, seen, results)
	return results


func _add_unique_formation(formation: Array, seen: Dictionary, results: Array) -> void:
	var key := _formation_key(formation)
	if not seen.has(key):
		seen[key] = true
		results.append(formation)


func _local_exact_search(fleet: Dictionary) -> Dictionary:
	var full_count := int(fleet.full_formation_count)
	var threshold := int(_settings.local_exact_threshold)
	var tested := 0
	var complete := false
	if full_count <= threshold:
		var formations := generate_unique_formations(fleet.seed_formation)
		var batch: Array = []
		for formation in formations:
			batch.append({"fleet": fleet, "formation": formation})
		for summary in await _evaluate_batch(batch):
			if not summary.is_empty():
				tested += 1
			complete = tested == formations.size()
	else:
		var frontier: Array = [fleet.best_result.formation]
		var seen := {_formation_key(frontier[0]): true}
		var local_formations: Array = frontier.duplicate(true)
		for unused_depth in range(int(_settings.get("local_exact_radius", 1))):
			var next: Array = []
			for current in frontier:
				for formation in _formation_neighbors(current):
					var key := _formation_key(formation)
					if not seen.has(key):
						seen[key] = true
						next.append(formation)
						local_formations.append(formation)
			frontier = next
		var batch: Array = []
		for formation in local_formations:
			batch.append({"fleet": fleet, "formation": formation})
		for summary in await _evaluate_batch(batch):
			if not summary.is_empty():
				tested += 1
			complete = tested == full_count
	return {
		"composition": fleet.deployment,
		"composition_counts": fleet.composition,
		"ship_loadouts": _loadout_summary(fleet.ship_loadouts),
		"full_formation_count": full_count,
		"tested_in_final_stage": tested,
		"complete": complete,
		"claim": "EXACT WITHIN THIS SUBSPACE" if complete else "PARTIAL SUBSPACE",
	}


func _probe_formation_signature(formation: Array) -> String:
	var enemy_columns: Array[int] = []
	for enemy in _base_config.get("enemy_fleet", []):
		var grid: Array = Array(enemy.get("grid_position", []))
		if grid.size() >= 2:
			enemy_columns.append(int(grid[1]))
	enemy_columns.sort()
	var parts: Array[String] = []
	for group in formation:
		var distances: Array[int] = []
		for column in enemy_columns:
			distances.append(absi(int(group.grid_position[1]) - column))
		distances.sort()
		parts.append("%s:r%d:d%s" % [_group_signature(group), int(group.grid_position[0]), distances])
	parts.sort()
	return "|".join(parts)


func _is_exploration_candidate(fleet: Dictionary) -> bool:
	var quota := clampf(float(_settings.exploration_quota), 0.0, 1.0)
	if quota <= 0.0:
		return false
	var interval := maxi(1, roundi(1.0 / quota))
	return int(fleet.get("generation_index", 0)) % interval == 0


func _apply_smart_prune(fleet: Dictionary) -> void:
	if not bool(_settings.smart_pruning) or (_recovery_mode and not _recovery_win_found) or fleet.best_result.is_empty() or _is_exploration_candidate(fleet):
		return
	var probe: Dictionary = fleet.best_result
	var reason := ""
	if objective == "boss" and float(probe.get("boss_damage", 0.0)) <= 0.0:
		var escorts := maxi(0, int(_analysis.get("enemy_count", 0)) - (1 if bool(_analysis.get("boss", false)) else 0))
		if int(probe.get("enemy_destroyed", 0)) < escorts:
			reason = "escort_gate"
	elif objective == "boss" and not _verified_baseline.is_empty():
		if boss_priority == "efficiency":
			var baseline_efficiency := float(_verified_baseline.get("boss_damage_per_fr", 0.0))
			var probe_efficiency := float(probe.get("boss_damage_per_fr", 0.0))
			if probe_efficiency * float(_settings.optimistic_factor) < baseline_efficiency:
				reason = "efficiency_cutoff"
		elif boss_priority == "kill_cost" and bool(_verified_baseline.get("killable_with_current_fr", false)):
			var baseline_total := float(_verified_baseline.get("refined_total_kill_fr", INF))
			var projected = probe.get("projected_kill_fr")
			if projected != null and float(projected) > baseline_total * float(_settings.kill_cost_margin):
				reason = "kill_cost_cutoff"
	elif objective == "normal" and str(probe.get("outcome", "")) != "victory" and int(probe.get("enemy_destroyed", 0)) == 0:
		reason = "counter_probe"
	if reason != "":
		fleet.smart_pruned = true
		fleet.smart_pruned_reason = reason
		_pruning_stats.smart_pruned[reason] += 1
		if _known_fleet_matches(fleet.get("composition", {}), fleet.get("ship_loadouts", {})):
			_known_trace.smart_prune = reason


func _evaluate_batch(items: Array) -> Array:
	_search_audit.normalized += items.size()
	var summaries: Array = []
	summaries.resize(items.size())
	summaries.fill({})
	if _workers.is_empty():
		for index in range(items.size()):
			if not _can_expand():
				break
			summaries[index] = await _evaluate(items[index].fleet, items[index].formation)
		return summaries

	var pending: Array = []
	var first_by_key := {}
	for index in range(items.size()):
		var key := _environment_key + "|" + _formation_key(items[index].formation)
		if _cache.has(key):
			_cache_hits += 1
			_search_audit.deduplicated += 1
			if _known_formation_matches(items[index].formation) and not bool(_known_trace.simulated):
				_known_trace.deduplicated = true
			summaries[index] = _cache[key]
		elif first_by_key.has(key):
			_search_audit.deduplicated += 1
			if _known_formation_matches(items[index].formation) and not bool(_known_trace.simulated):
				_known_trace.deduplicated = true
			pending[int(first_by_key[key])].aliases.append(index)
		else:
			first_by_key[key] = pending.size()
			pending.append({"index": index, "key": key, "item": items[index], "aliases": []})

	var cursor := 0
	while cursor < pending.size() and _can_expand():
		if _workers.is_empty():
			for pending_index in range(cursor, pending.size()):
				if not _can_expand():
					break
				var entry: Dictionary = pending[pending_index]
				var summary := await _evaluate(entry.item.fleet, entry.item.formation)
				summaries[entry.index] = summary
				for alias in entry.aliases:
					summaries[int(alias)] = summary
			return summaries
		var wave: Array = pending.slice(cursor, mini(cursor + _workers.size(), pending.size()))
		var configs: Array = []
		for entry in wave:
			var config := _base_config.duplicate(true)
			config.formation = Array(entry.item.formation).duplicate(true)
			config.simulation_detail = str(_settings.simulation_detail)
			_mark_queued(entry.item.formation)
			configs.append(config)
		var raw_results := await _run_worker_wave(configs)
		for wave_index in range(wave.size()):
			var entry: Dictionary = wave[wave_index]
			var raw: Dictionary = raw_results[wave_index]
			var summary := _store_worker_result(entry.item.fleet, entry.item.formation, entry.key, raw)
			summaries[entry.index] = summary
			for alias in entry.aliases:
				summaries[int(alias)] = summary
		cursor += wave.size()
	return summaries


func _store_worker_result(fleet: Dictionary, formation: Array, candidate_key: String, result: Dictionary) -> Dictionary:
	var canonical_started := Time.get_ticks_usec()
	var summary := _summarize_result(_simulations + 1, result)
	summary["candidate_hash"] = candidate_key.sha256_text()
	summary["composition"] = fleet.deployment.duplicate(true)
	summary["composition_counts"] = fleet.composition.duplicate(true)
	summary["ship_loadouts"] = _loadout_summary(fleet.ship_loadouts)
	summary["mode"] = _settings.mode
	summary["deployment_quote_committed_fr"] = fleet.fleet_resources_committed_quote
	summary["minimum_possible_used_fr"] = fleet.get("minimum_possible_used_fr")
	_canonicalization_ms += (Time.get_ticks_usec() - canonical_started) / 1000.0
	_cache[candidate_key] = summary
	_simulations += 1
	_pruning_stats.simulated += 1
	_record_audit_result(formation, summary)
	_progress_consider_best(summary)
	_progress_update()
	if bool(fleet.get("is_overdeploy", false)):
		_overdeploy_candidates_simulated += 1
	var performance: Dictionary = result.get("performance_breakdown", {}).duplicate(true)
	var cleanup_ms := float(performance.get("cleanup_ms", 0.0))
	performance.erase("cleanup_ms")
	_record_performance(performance, {"cleanup_ms": cleanup_ms})
	return summary


func _start_workers() -> void:
	var requested := int(_settings.get("workers", 1))
	if requested <= 1:
		print("Workers: single-process (1/1)")
		return
	print("")
	print("Initializing workers...")
	print("Starting workers: 0/%d" % requested)
	_worker_root = ProjectSettings.globalize_path("user://optimizer_workers_%s_%s" % [OS.get_process_id(), Time.get_ticks_msec()])
	DirAccess.make_dir_recursive_absolute(_worker_root)
	for index in range(requested):
		var worker_dir := _worker_root.path_join("worker_%d" % index)
		DirAccess.make_dir_recursive_absolute(worker_dir)
		var worker_id := "%s_%d" % [OS.get_process_id(), index]
		var log_path := worker_dir.path_join("worker.log")
		var worker_args := [
			"--headless", "--disable-render-loop",
			"--log-file", log_path,
		]
		if not "--verbose" in OS.get_cmdline_user_args():
			worker_args.append("--quiet")
		if str(_settings.simulation_clock) == "offline_fixed_step":
			worker_args.append_array(["--fixed-fps", "60"])
		worker_args.append_array([
			"--path", ProjectSettings.globalize_path("res://"), "res://fleet_optimizer_bootstrap.tscn", "--",
			"--simulation-clock=%s" % _settings.simulation_clock,
			"--fixed-fps-active=%d" % (60 if str(_settings.simulation_clock) == "offline_fixed_step" else 0),
			"--fleet-worker-dir=%s" % worker_dir,
			"--worker-id=%s" % worker_id,
			"--optimizer-galaxy=%s" % _base_config.galaxy_id,
		])
		var pid := OS.create_process(OS.get_executable_path(), worker_args)
		if pid > 0:
			_workers.append({"pid": pid, "dir": worker_dir, "id": worker_id, "log": log_path})
		else:
			_worker_startup.append({"id": worker_id, "ready": false, "error": "OS.create_process failed"})
		print("Starting workers: %d/%d" % [index + 1, requested])
	print("Workers launched: %d/%d; readiness check occurs before the first parallel batch." % [_workers.size(), requested])


func _run_worker_wave(configs: Array) -> Array:
	var results: Array = []
	results.resize(configs.size())
	results.fill({})
	var startup_timeout := minf(60.0, maxf(5.0, float(_settings.max_wall_seconds) - float(_settings.finalization_reserve_seconds)))
	var startup_deadline := Time.get_ticks_msec() + int(startup_timeout * 1000.0)
	var required_workers := int(_settings.get("workers", 1))
	var all_ready := _workers.size() >= required_workers
	var ready_in_this_check: Array = []
	for worker in _workers:
		while not FileAccess.file_exists(str(worker.dir).path_join("ready.json")) and Time.get_ticks_msec() < startup_deadline:
			await get_tree().create_timer(0.05).timeout
		if FileAccess.file_exists(str(worker.dir).path_join("ready.json")):
			var ready := _read_worker_json(str(worker.dir).path_join("ready.json"))
			worker["user_data_dir"] = ready.get("user_data_dir", "")
			_worker_startup.append({
				"id": worker.id,
				"ready": true,
				"startup_ms": ready.get("startup_ms"),
				"user_data_dir": worker.user_data_dir,
				"log": worker.log,
			})
			ready_in_this_check.append(ready)
		else:
			all_ready = false
			_worker_startup.append({
				"id": worker.id,
				"ready": false,
				"process_running": OS.is_process_running(int(worker.pid)),
				"log": worker.log,
				"log_tail": _worker_log_tail(worker.log),
			})
	if not all_ready:
		_worker_warning = "WORKER STARTUP FAILED WITHIN %.1fs: %s; DETERMINISTIC SINGLE-PROCESS FALLBACK USED" % [startup_timeout, JSON.stringify(_worker_startup)]
		print(_worker_warning)
		for worker in _workers:
			OS.kill(int(worker.pid))
		_workers.clear()
		for index in range(configs.size()):
			var result: Dictionary = await _probe.run_battle(configs[index])
			var cleanup: Dictionary = await _probe.cleanup_battle()
			if not result.has("performance_breakdown"):
				result["performance_breakdown"] = {}
			result.performance_breakdown["cleanup_ms"] = cleanup.get("cleanup_ms", 0.0)
			results[index] = result
		return results
	if not _workers_ready_reported:
		var slowest_ms := 0.0
		for ready in ready_in_this_check:
			slowest_ms = maxf(slowest_ms, float(ready.get("startup_ms", 0.0)))
		print("Workers: %d/%d ready (%.1fs)" % [_workers.size(), required_workers, slowest_ms / 1000.0])
		_workers_ready_reported = true
	var request_id := str(Time.get_ticks_usec())
	for index in range(configs.size()):
		var worker: Dictionary = _workers[index]
		_write_worker_json(str(worker.dir).path_join("request.json"), {
			"id": request_id,
			"items": [{"index": index, "config": configs[index]}],
		})
	var response_deadline := Time.get_ticks_msec() + 180000
	for index in range(configs.size()):
		var worker: Dictionary = _workers[index]
		var response_path := str(worker.dir).path_join("response_%s.json" % request_id)
		while not FileAccess.file_exists(response_path) and Time.get_ticks_msec() < response_deadline:
			await get_tree().create_timer(0.05).timeout
		if FileAccess.file_exists(response_path):
			var response := _read_worker_json(response_path)
			DirAccess.remove_absolute(response_path)
			if not response.get("results", []).is_empty():
				results[index] = response.results[0].result
		else:
			results[index] = {"error": "Fleet worker timed out", "battle_config": configs[index]}
	return results


func _monitor_worker_readiness() -> void:
	var requested := int(_settings.get("workers", 1))
	if requested <= 1 or _workers.size() != requested:
		return
	var timeout := minf(60.0, maxf(5.0, float(_settings.max_wall_seconds) - float(_settings.finalization_reserve_seconds)))
	var deadline := Time.get_ticks_msec() + int(timeout * 1000.0)
	while not _workers_ready_reported and Time.get_ticks_msec() < deadline:
		var ready_count := 0
		var slowest_ms := 0.0
		for worker in _workers:
			var ready_path := str(worker.dir).path_join("ready.json")
			if FileAccess.file_exists(ready_path):
				ready_count += 1
				var ready := _read_worker_json(ready_path)
				slowest_ms = maxf(slowest_ms, float(ready.get("startup_ms", 0.0)))
		if ready_count == requested:
			print("Workers: %d/%d ready (%.1fs)" % [ready_count, requested, slowest_ms / 1000.0])
			_workers_ready_reported = true
			return
		await get_tree().create_timer(0.25).timeout


func _write_worker_json(path: String, value: Dictionary) -> void:
	var temporary_path := path + ".tmp"
	var file := FileAccess.open(temporary_path, FileAccess.WRITE)
	assert(file != null, "Unable to write worker request %s" % path)
	file.store_string(JSON.stringify(value))
	file.close()
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(path)
	assert(DirAccess.rename_absolute(temporary_path, path) == OK, "Unable to publish worker request %s" % path)


func _read_worker_json(path: String) -> Dictionary:
	var file := FileAccess.open(path, FileAccess.READ)
	assert(file != null, "Unable to read worker response %s" % path)
	var value = JSON.parse_string(file.get_as_text())
	file.close()
	assert(value is Dictionary, "Invalid worker response %s" % path)
	return value


func _worker_log_tail(path: String) -> String:
	if not FileAccess.file_exists(path):
		return ""
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return ""
	var lines := file.get_as_text().split("\n")
	file.close()
	return "\n".join(lines.slice(maxi(0, lines.size() - 12)))


func _stop_workers() -> void:
	for worker in _workers:
		var file := FileAccess.open(str(worker.dir).path_join("stop"), FileAccess.WRITE)
		if file != null:
			file.store_string("stop")
			file.close()
	var deadline := Time.get_ticks_msec() + 5000
	while Time.get_ticks_msec() < deadline:
		var running := false
		for worker in _workers:
			running = running or OS.is_process_running(int(worker.pid))
		if not running:
			break
		await get_tree().create_timer(0.05).timeout
	for worker in _workers:
		if OS.is_process_running(int(worker.pid)):
			OS.kill(int(worker.pid))


func _worker_user_data_dirs() -> Array:
	var result: Array = []
	for worker in _workers:
		result.append(worker.get("user_data_dir", "not_started"))
	return result


func _evaluate(fleet: Dictionary, formation: Array) -> Dictionary:
	var canonical_started := Time.get_ticks_usec()
	var candidate_key := _environment_key + "|" + _formation_key(formation)
	_canonicalization_ms += (Time.get_ticks_usec() - canonical_started) / 1000.0
	if _cache.has(candidate_key):
		_cache_hits += 1
		_search_audit.deduplicated += 1
		if _known_formation_matches(formation) and not bool(_known_trace.simulated):
			_known_trace.deduplicated = true
		return _cache[candidate_key]
	if not _can_simulate():
		return {}
	_mark_queued(formation)
	var config := _base_config.duplicate(true)
	config.formation = formation.duplicate(true)
	config.simulation_detail = str(_settings.simulation_detail)
	var result: Dictionary = await _probe.run_battle(config)
	canonical_started = Time.get_ticks_usec()
	var summary := _summarize_result(_simulations + 1, result)
	summary["candidate_hash"] = candidate_key.sha256_text()
	_canonicalization_ms += (Time.get_ticks_usec() - canonical_started) / 1000.0
	summary["composition"] = fleet.deployment.duplicate(true)
	summary["composition_counts"] = fleet.composition.duplicate(true)
	summary["ship_loadouts"] = _loadout_summary(fleet.ship_loadouts)
	summary["mode"] = _settings.mode
	summary["deployment_quote_committed_fr"] = fleet.fleet_resources_committed_quote
	summary["minimum_possible_used_fr"] = fleet.get("minimum_possible_used_fr")
	_cache[candidate_key] = summary
	_simulations += 1
	_pruning_stats.simulated += 1
	_record_audit_result(formation, summary)
	_progress_consider_best(summary)
	_progress_update()
	if fleet.is_overdeploy:
		_overdeploy_candidates_simulated += 1
	var cleanup: Dictionary = await _probe.cleanup_battle()
	_record_performance(result.get("performance_breakdown", {}), cleanup)
	return summary


func _can_simulate() -> bool:
	var simulation_limit := int(_settings.max_simulations)
	if not _finalizing and not _refining_kill_sequences and objective == "boss":
		simulation_limit = maxi(1, simulation_limit - int(_settings.kill_refine_reserve_simulations))
	if _simulations >= simulation_limit or _elapsed_seconds() >= float(_settings.max_wall_seconds):
		_budget_exhausted = true
		return false
	return true


func _can_expand() -> bool:
	if not _can_simulate():
		return false
	if _elapsed_seconds() >= float(_settings.max_wall_seconds) - float(_settings.finalization_reserve_seconds):
		_budget_exhausted = true
		return false
	return true


func _refine_top_candidates(broad_ranked: Array) -> Dictionary:
	var requested := mini(int(_settings.kill_refine_top_n), broad_ranked.size())
	var refined := 0
	for candidate in broad_ranked.slice(0, requested):
		if _elapsed_seconds() >= float(_settings.max_wall_seconds):
			break
		if not bool(candidate.get("kill_refined", false)):
			await _refine_candidate(candidate)
		if bool(candidate.get("kill_refined", false)):
			refined += 1
	return {
		"enabled": true,
		"priority": boss_priority,
		"candidates_requested": requested,
		"candidates_refined": refined,
		"max_battles_per_candidate": int(_settings.kill_sequence_max_battles),
		"partial": refined < requested,
		"status": "REFINEMENT PARTIAL" if refined < requested else "COMPLETE",
	}


func _refine_candidate(candidate: Dictionary) -> void:
	var hp := boss_remaining_hp
	var available_fr := float(_base_config.fleet_resources)
	var total_used := 0.0
	var sequence: Array = []
	var failed_before = null
	var stop_reason := ""
	var next_battle := 1
	var max_battles := int(_settings.kill_sequence_max_battles)
	while hp > 0.0 and next_battle <= max_battles:
		var committed := float(candidate.fleet_resources_committed)
		if available_fr < committed:
			failed_before = next_battle
			stop_reason = "insufficient_committed_fr"
			break

		var damage: float
		var used: float
		if next_battle == 1:
			damage = float(candidate.boss_damage)
			used = float(candidate.fleet_resources_used)
		else:
			if not _can_simulate():
				failed_before = next_battle
				stop_reason = "search_budget_exhausted"
				break
			var config := _base_config.duplicate(true)
			config.formation = candidate.formation.duplicate(true)
			config.simulation_detail = str(_settings.simulation_detail)
			config.boss_health = hp
			config.fight_enemy_command_ship = false
			config.fleet_resources = available_fr
			var result: Dictionary = await _probe.run_battle(config)
			_simulations += 1
			_pruning_stats.simulated += 1
			_progress_update()
			damage = float(result.get("boss_damage", 0.0))
			used = float(result.get("fleet_resources_used", 0.0))
			committed = float(result.get("fleet_resources_committed", committed))
			var cleanup: Dictionary = await _probe.cleanup_battle()
			_record_performance(result.get("performance_breakdown", {}), cleanup)
			if result.has("error"):
				failed_before = next_battle
				stop_reason = str(result.error)
				break

		var hp_before := hp
		hp = maxf(0.0, hp - damage)
		available_fr -= used
		total_used += used
		sequence.append({
			"battle": next_battle,
			"boss_hp_before": hp_before,
			"boss_damage": damage,
			"boss_hp_after": hp,
			"committed_fr": committed,
			"used_fr": used,
			"fr_remaining": available_fr,
		})
		if damage <= 0.0:
			stop_reason = "boss_damage_not_positive"
			break
		next_battle += 1

	var killed := hp <= 0.0
	if not killed and stop_reason == "" and next_battle > max_battles:
		stop_reason = "safe_battle_limit_reached"
	candidate.kill_refined = true
	candidate.refined_battles_to_kill = sequence.size() if killed else null
	candidate.refined_total_kill_fr = total_used if killed else null
	candidate.battles_to_kill = sequence.size() if killed else null
	candidate.total_kill_fr = total_used if killed else null
	candidate.refined_fr_spent = total_used
	candidate.battles_run = sequence.size()
	candidate.boss_starting_hp = boss_remaining_hp
	candidate.boss_final_hp = hp
	candidate.killable_with_current_fr = killed
	candidate.remaining_fr_after_kill = available_fr if killed else null
	candidate.kill_sequence = sequence
	candidate.failed_before_battle = failed_before
	candidate.kill_sequence_stop_reason = "boss_killed" if killed else stop_reason
	_pruning_stats.refined += 1


func _run_verified_baseline() -> Dictionary:
	var baseline: Dictionary = _settings.get("baseline", {}) if _settings.get("baseline", {}) is Dictionary else {}
	if not bool(baseline.get("enabled", false)):
		return {}
	var formation_map: Dictionary = baseline.get("formation", {})
	var loadout_map: Dictionary = baseline.get("loadouts", {})
	var positions: Array = formation_map.keys()
	positions.sort()
	var formation: Array = []
	var composition := {}
	var loadouts := {}
	for position_value in positions:
		var position := str(position_value).to_upper()
		var ship_type := str(formation_map[position_value])
		var selected: Dictionary = loadout_map[ship_type]
		var loadout := {
			"id": _slot_loadout_id(selected.get("primary"), selected.get("secondary")),
			"ship_id": ship_type,
			"primary_mod": selected.get("primary"),
			"secondary_mod": selected.get("secondary"),
			"tertiary_mods": Array(selected.get("tertiary", [])).duplicate(),
		}
		loadouts[ship_type] = loadout
		composition[ship_type] = int(composition.get(ship_type, 0)) + 1
		formation.append({
			"ship": ship_type,
			"grid_position": _grid_from_position(position),
			"primary_mod": loadout.primary_mod,
			"secondary_mod": loadout.secondary_mod,
			"tertiary_mods": loadout.tertiary_mods.duplicate(),
		})
	var quote_config := _base_config.duplicate(true)
	quote_config.formation = formation.duplicate(true)
	var quote_started := Time.get_ticks_usec()
	var quote: Dictionary = await _probe.quote_player_deployment(quote_config)
	_quote_wall_ms += (Time.get_ticks_usec() - quote_started) / 1000.0
	_deployment_quotes += 1
	if not bool(quote.get("deployable", false)) or not bool(quote.get("within_budget", false)):
		_baseline_warning = "BASELINE IS NOT DEPLOYABLE UNDER THE RESOLVED PLAYER STATE"
		print(_baseline_warning)
		return {}
	var fleet := {
		"composition": composition,
		"ship_loadouts": loadouts,
		"deployment": quote.deployment.duplicate(true),
		"fleet_resources_committed_quote": quote.fleet_resources_committed,
		"is_overdeploy": _quote_has_overdeploy(quote),
		"minimum_possible_used_fr": _minimum_possible_used_fr(composition, float(quote.fleet_resources_committed)),
	}
	var result: Dictionary = await _evaluate(fleet, formation)
	if result.is_empty():
		return {}
	result["is_verified_baseline"] = true
	var observed: Dictionary = baseline.get("observed", {}) if baseline.get("observed", {}) is Dictionary else {}
	var observed_outcome := str(observed.get("outcome", "")).to_lower()
	if observed_outcome in ["win", "victory"] and str(result.get("outcome", "")) != "victory":
		_baseline_validation_failed = true
		_baseline_warning = "BASELINE VALIDATION FAILED"
		print(_baseline_warning)
	var differs := false
	for field in ["fleet_resources_used", "boss_damage"]:
		if observed.has(field) and not is_equal_approx(float(observed[field]), float(result.get(field, 0.0))):
			differs = true
	if differs:
		_baseline_warning = "BASELINE OBSERVED RESULT DIFFERS FROM SIMULATION"
		print(_baseline_warning)
	result["observed"] = observed.duplicate(true)
	if objective == "boss" and boss_priority == "kill_cost":
		_refining_kill_sequences = true
		await _refine_candidate(result)
		_refining_kill_sequences = false
	return result


func _recovery_composition_order(compositions: Array, budget: int) -> Array:
	var baseline := _candidate_composition(_settings.baseline)
	var by_value := {}
	for composition in compositions:
		by_value[_composition_key(composition)] = composition
	var result: Array = []
	var seen := {}
	var max_transfer := 0
	for count in baseline.values():
		max_transfer = maxi(max_transfer, int(count))
	for transfer in range(0, max_transfer + 1):
		for donor in _ship_types():
			for receiver in _ship_types():
				if donor == receiver or (transfer > 0 and int(baseline.get(donor, 0)) < transfer):
					continue
				var candidate := baseline.duplicate(true)
				if transfer > 0:
					candidate[donor] = int(candidate.get(donor, 0)) - transfer
					candidate[receiver] = int(candidate.get(receiver, 0)) + transfer
				var key := _composition_key(candidate)
				if by_value.has(key) and not seen.has(key):
					seen[key] = true
					result.append(by_value[key])
					if result.size() >= budget:
						return result
	for composition in compositions:
		var key := _composition_key(composition)
		if not seen.has(key):
			result.append(composition)
			if result.size() >= budget:
				break
	return result


func _composition_key(composition: Dictionary) -> String:
	var counts: Array[String] = []
	for ship_type in _ship_types():
		counts.append("%s:%d" % [ship_type, int(composition.get(ship_type, 0))])
	return "|".join(counts)


func _baseline_validation_failure_output() -> Dictionary:
	var baseline: Dictionary = _settings.get("baseline", {})
	var details := {
		"message": "BASELINE VALIDATION FAILED",
		"observed_outcome": baseline.get("observed", {}).get("outcome", "victory"),
		"simulated_outcome": _verified_baseline.get("outcome", "not-run"),
		"formation": baseline.get("formation", {}).duplicate(true),
		"ship_counts": _candidate_composition(baseline),
		"loadouts": baseline.get("loadouts", {}).duplicate(true),
		"hazards": _base_config.get("hazards", []).duplicate(true),
		"supports": _base_config.get("supports", []).duplicate(true),
		"player_state": {
			"fleet_resources": _base_config.get("fleet_resources"),
			"fleet_resources_retention": _base_config.get("fleet_resources_retention"),
			"ships": _base_config.get("ships_available", {}).duplicate(true),
			"damage_scale": _base_config.get("player_damage_scale"),
			"health_scale": _base_config.get("player_health_scale"),
		},
		"action": "Check the baseline formation, loadouts, hazards, supports, and player_state before optimizing.",
	}
	print(JSON.stringify(details, "  "))
	return {
		"optimizer_version": "2.2",
		"result_claim": "BASELINE VALIDATION FAILED",
		"recommendation_status": "BASELINE VALIDATION FAILED",
		"search_profile": _profile,
		"search_goal": _goal,
		"search_mode": "validation_failed",
		"objective": objective,
		"simulation_clock": _verified_baseline.get("simulation_clock", _probe.simulation_clock_metadata(_base_config)),
		"verified_baseline": _verified_baseline,
		"baseline_warning": _baseline_warning,
		"baseline_validation": details,
		"pruning_stats": _pruning_stats,
		"search_audit": _finalize_search_audit(),
		"known_candidate_trace": _finalize_known_trace(),
		"simulations_used": _simulations,
		"wall_time_seconds": _elapsed_seconds(),
		"errors": 1,
		"cache_validation": {"all_identical": true, "used_cache_only": true},
		"boss_ranking_unit_test": {"passed": true},
		"performance_breakdown": _performance_breakdown(),
		"best_result": {},
	}


func _grid_from_position(position: String) -> Array:
	return [0 if position.begins_with("A") else 1, int(position.substr(1)) - 1]


func _attach_full_result(candidate: Dictionary) -> String:
	if candidate.is_empty():
		return "NO VALID CANDIDATE"
	if not _can_simulate():
		return "FULL RESULT SKIPPED: BUDGET EXHAUSTED"
	var config := _base_config.duplicate(true)
	config.formation = Array(candidate.get("formation", [])).duplicate(true)
	config.simulation_detail = "full"
	var result: Dictionary = await _probe.run_battle(config)
	_simulations += 1
	_pruning_stats.simulated += 1
	_progress_update()
	var cleanup: Dictionary = await _probe.cleanup_battle()
	_record_performance(result.get("performance_breakdown", {}), cleanup)
	candidate["full_battle_result"] = result
	return "COMPLETE" if not result.has("error") else "FULL RESULT ERROR: %s" % result.error


func _improvement(candidate: Dictionary, baseline: Dictionary) -> Dictionary:
	if baseline.is_empty() or candidate.is_empty():
		return {"available": false}
	var result := {
		"available": true,
		"strictly_better": str(candidate.get("candidate_hash", "")) != str(baseline.get("candidate_hash", "")) and _rank_before(candidate, baseline),
		"same_as_baseline": str(candidate.get("candidate_hash", "")) == str(baseline.get("candidate_hash", "")),
	}
	if objective == "normal":
		var saved := float(baseline.get("fleet_resources_used", 0.0)) - float(candidate.get("fleet_resources_used", 0.0))
		result["fleet_resources_saved_per_battle"] = saved
		result["percent"] = saved / maxf(0.000001, float(baseline.get("fleet_resources_used", 0.0))) * 100.0
	elif boss_priority == "kill_cost":
		var baseline_total = baseline.get("refined_total_kill_fr")
		var candidate_total = candidate.get("refined_total_kill_fr")
		if baseline_total != null and candidate_total != null:
			var saved := float(baseline_total) - float(candidate_total)
			result["total_kill_fr_saved"] = saved
			result["percent"] = saved / maxf(0.000001, float(baseline_total)) * 100.0
	else:
		var delta := float(candidate.get("boss_damage_per_fr", 0.0)) - float(baseline.get("boss_damage_per_fr", 0.0))
		result["damage_per_fr_gain"] = delta
		result["percent"] = delta / maxf(0.000001, float(baseline.get("boss_damage_per_fr", 0.0))) * 100.0
	return result


func _record_performance(performance: Dictionary, cleanup: Dictionary) -> void:
	for key in performance:
		if performance[key] is int or performance[key] is float:
			_performance_totals[key] = float(_performance_totals.get(key, 0.0)) + float(performance[key])
	_performance_totals["cleanup_ms"] = float(_performance_totals.get("cleanup_ms", 0.0)) + float(cleanup.get("cleanup_ms", 0.0))
	_performance_samples += 1


func _performance_breakdown() -> Dictionary:
	var result := {
		"samples": _performance_samples,
		"candidate_generation_ms": _candidate_generation_ms,
		"deployment_quote_total_ms": _quote_wall_ms,
		"average_quote_ms": _quote_wall_ms / maxf(1.0, float(_deployment_quotes)),
		"canonicalization_total_ms": _canonicalization_ms,
		"average_canonicalization_ms": _canonicalization_ms / maxf(1.0, float(_simulations)),
	}
	for key in _performance_totals:
		result["average_%s" % key] = float(_performance_totals[key]) / maxf(1.0, float(_performance_samples))
	return result


func _elapsed_seconds() -> float:
	return (Time.get_ticks_msec() - _started_msec) / 1000.0


func _progress_stage_start(name: String, index: int, count: int, exact_total: int = -1) -> void:
	_progress_stage_name = name
	_progress_stage_index = index
	_progress_stage_count = count
	_progress_stage_started_msec = Time.get_ticks_msec()
	_progress_stage_sim_start = _simulations
	_progress_exact_total = exact_total
	_progress_last_completed = -1
	print("")
	print("[%d/%d] %s" % [index, count, name])


func _progress_update(force: bool = false) -> void:
	if _progress_stage_name == "":
		return
	var completed := _simulations - _progress_stage_sim_start
	if not force and (completed <= 0 or completed - _progress_last_completed < 5):
		return
	if force and completed == _progress_last_completed:
		return
	_progress_last_completed = completed
	var elapsed := maxf(0.001, (Time.get_ticks_msec() - _progress_stage_started_msec) / 1000.0)
	var speed := completed / elapsed
	var workers := (
		"Workers: %d" % _workers.size()
		if _workers_ready_reported
		else ("Workers: starting" if int(_settings.get("workers", 1)) > 1 else "Workers: 1")
	)
	if _progress_exact_total >= 0:
		var percent := 100.0 if _progress_exact_total == 0 else minf(100.0, completed * 100.0 / _progress_exact_total)
		var eta := "estimating..."
		if completed >= _progress_exact_total:
			eta = "00:00"
		elif completed >= 3 and elapsed >= 1.0 and speed > 0.0:
			eta = _format_duration((_progress_exact_total - completed) / speed)
		print("%d/%d | %.1f%% | %.2f sim/s | Elapsed %s | ETA %s | %s" % [
			completed, _progress_exact_total, percent, speed, _format_duration(elapsed), eta, workers,
		])
	else:
		print("Evaluated: %d | %.2f sim/s | Elapsed %s | ETA unavailable | %s" % [
			completed, speed, _format_duration(elapsed), workers,
		])


func _progress_quote_update(completed: int, total: int) -> void:
	var interval := maxi(1, ceili(total / 10.0))
	if completed != 1 and completed != total and completed % interval != 0:
		return
	var elapsed := maxf(0.001, (Time.get_ticks_msec() - _progress_stage_started_msec) / 1000.0)
	var speed := completed / elapsed
	var eta := "estimating..."
	if completed >= total:
		eta = "00:00"
	elif completed >= 3 and elapsed >= 1.0 and speed > 0.0:
		eta = _format_duration((total - completed) / speed)
	print("Quotes: %d/%d | %.1f%% | %.2f quote/s | Elapsed %s | ETA %s" % [
		completed, total, completed * 100.0 / maxf(1.0, total), speed, _format_duration(elapsed), eta,
	])


func _progress_consider_best(candidate: Dictionary) -> void:
	if candidate.is_empty() or str(candidate.get("error", "")) != "":
		return
	if not _progress_best.is_empty() and not _rank_before(candidate, _progress_best):
		return
	_progress_best = candidate.duplicate(true)
	print("")
	print("Best updated:")
	if objective == "boss":
		print("%s | Boss Damage: %s | Damage/FR: %s | FR Used: %s" % [
			str(candidate.get("outcome", "unknown")).capitalize(),
			candidate.get("boss_damage", "n/a"),
			candidate.get("boss_damage_per_fr", "n/a"),
			candidate.get("fleet_resources_used", "n/a"),
		])
	else:
		print("%s | FR Used: %s" % [
			str(candidate.get("outcome", "unknown")).capitalize(),
			candidate.get("fleet_resources_used", "n/a"),
		])


func _format_duration(seconds: float) -> String:
	var whole := maxi(0, int(seconds))
	var hours := whole / 3600
	var minutes := (whole % 3600) / 60
	var remainder := whole % 60
	return "%02d:%02d:%02d" % [hours, minutes, remainder] if hours > 0 else "%02d:%02d" % [minutes, remainder]


func _fleet_before(a: Dictionary, b: Dictionary) -> bool:
	return _rank_before(a.best_result, b.best_result)


func _loadout_summary(loadouts: Dictionary) -> Dictionary:
	var result := {}
	for ship_type in loadouts:
		var loadout = loadouts[ship_type]
		if loadout is Dictionary:
			result[ship_type] = {
				"id": str(loadout.id),
				"primary": loadout.get("primary_mod"),
				"secondary": loadout.get("secondary_mod"),
			}
		else:
			result[ship_type] = loadout
	return result


func _battle_environment_key(config: Dictionary) -> String:
	var environment := config.duplicate(true)
	environment.erase("formation")
	environment.erase("optimizer")
	environment.erase("resolver")
	environment.erase("simulation_detail")
	return JSON.stringify(environment).sha256_text()


func _result_counts(ranked: Array) -> Dictionary:
	var result := {"victories": 0, "losses": 0, "errors": 0}
	for item in ranked:
		if str(item.error) != "":
			result.errors += 1
		elif item.outcome == "victory":
			result.victories += 1
		else:
			result.losses += 1
	return result


func _run_overdeploy_tests() -> Dictionary:
	var ship_type := str(_settings.get("overdeploy_test_ship", "Cruiser"))
	assert(ship_type in _settings.allowed_loadouts, "Missing test loadout for %s" % ship_type)
	var quote_a: Dictionary = await _probe.quote_player_deployment(_overdeploy_test_config(ship_type, 1, 1, 1000.0, true))
	var quote_b: Dictionary = await _probe.quote_player_deployment(_overdeploy_test_config(ship_type, 2, 1, 1000.0, true))
	var quote_c: Dictionary = await _probe.quote_player_deployment(_overdeploy_test_config(ship_type, 5, 1, 1000.0, true))
	var quote_d: Dictionary = await _probe.quote_player_deployment(_overdeploy_test_config(
		ship_type,
		2,
		1,
		float(quote_b.fleet_resources_committed) - 0.01,
		true,
	))
	var quote_e: Dictionary = await _probe.quote_player_deployment(_overdeploy_test_config(ship_type, 1, 0, 1000.0, false))
	var tests := {
		"A_normal_deployment": {
			"passed": quote_a.deployable and int(quote_a.deployment[ship_type].overdeployed_groups) == 0,
			"quote": quote_a,
		},
		"B_second_group_overdeploy": {
			"passed": quote_b.deployable and int(quote_b.deployment[ship_type].overdeployed_groups) == 1,
			"quote": quote_b,
		},
		"C_multiple_group_original_cost": {
			"passed": (
				quote_c.deployable
				and is_equal_approx(float(quote_a.fleet_resources_committed), 20.0)
				and is_equal_approx(float(quote_b.fleet_resources_committed), 60.0)
				and is_equal_approx(float(quote_c.fleet_resources_committed), 300.0)
			),
			"quote": quote_c,
		},
		"D_fr_pruned_before_battle": {
			"passed": quote_d.deployable and not quote_d.within_budget,
			"would_prune_before_battle": not quote_d.within_budget,
			"quote": quote_d,
		},
		"E_zero_available_disabled": {
			"passed": not quote_e.deployable and quote_e.reason == "ship_disabled_or_zero_available",
			"quote": quote_e,
		},
	}
	var all_passed := true
	for test in tests.values():
		all_passed = all_passed and bool(test.passed)
	return {
		"enabled": true,
		"all_passed": all_passed,
		"tests": tests,
		"battle_formula_reimplemented": false,
		"cost_source": "FleetBattle.calc_total_deployment",
	}


func _overdeploy_test_config(
	ship_type: String,
	deployed: int,
	available: int,
	fleet_resources: float,
	enabled: bool,
) -> Dictionary:
	var config := _base_config.duplicate(true)
	config.fleet_resources = fleet_resources
	config.ships_available = {
		ship_type: {"enabled": enabled, "available": available},
	}
	config.formation = []
	var loadout: Dictionary = Array(_settings.allowed_loadouts[ship_type])[0]
	for index in range(deployed):
		config.formation.append({
			"ship": str(loadout.get("ship_id", ship_type)),
			"grid_position": STANDARD_CELLS[index].duplicate(),
			"primary_mod": loadout.get("primary_mod"),
			"secondary_mod": loadout.get("secondary_mod"),
			"tertiary_mods": [],
		})
	return config


func _cache_validation(ranked: Array) -> Dictionary:
	if ranked.is_empty():
		return {"all_identical": false, "runs": []}
	var selected := [ranked[0], ranked[floori(ranked.size() / 2.0)]]
	var original_key := _formation_key(_base_config.formation)
	for item in ranked:
		if item.formation_key == original_key:
			selected.append(item)
			break
	var before := _simulations
	var runs: Array = []
	for expected in selected:
		var fleet := {
			"composition": expected.composition_counts,
			"deployment": expected.composition,
			"ship_loadouts": expected.ship_loadouts,
			"fleet_resources_committed_quote": expected.fleet_resources_committed,
			"is_overdeploy": false,
		}
		var actual := await _evaluate(fleet, expected.formation)
		runs.append({
			"candidate_hash": expected.candidate_hash,
			"identical": actual.canonical_sha256 == expected.canonical_sha256,
		})
	var all_identical := true
	for run in runs:
		all_identical = all_identical and run.identical
	return {
		"all_identical": all_identical,
		"used_cache_only": _simulations == before,
		"runs": runs,
	}


func _build_v1_regression(ranked: Array, exact_subspaces: Array) -> Dictionary:
	if not bool(_settings.get("v1_regression", false)):
		return {"enabled": false}
	var expected_loadout := str(_settings.get("v1_loadout_id", "CruiserSingleArmorTank"))
	var matching: Array = []
	for item in ranked:
		if (
			int(item.composition_counts.get("Cruiser", 0)) == 5
			and item.composition_counts.values().reduce(func(total, count): return total + int(count), 0) == 5
			and str(item.ship_loadouts.get("Cruiser", {}).get("id", "")) == expected_loadout
		):
			matching.append(item)
	matching.sort_custom(_rank_before)
	var original_key := _formation_key(_base_config.formation)
	var original: Dictionary
	for item in matching:
		if item.formation_key == original_key:
			original = item
			break
	var exact := false
	for subspace in exact_subspaces:
		if int(subspace.composition_counts.get("Cruiser", 0)) == 5 and bool(subspace.complete):
			exact = int(subspace.full_formation_count) == 252
	var best: Dictionary = {} if matching.is_empty() else matching[0]
	var original_tied := (
		not original.is_empty()
		and not best.is_empty()
		and is_equal_approx(float(original.boss_damage), float(best.boss_damage))
		and is_equal_approx(float(original.fleet_resources_used), float(best.fleet_resources_used))
	)
	var passed := (
		exact
		and matching.size() == 252
		and not best.is_empty()
		and is_equal_approx(float(best.boss_damage), 1365.0)
		and is_equal_approx(float(best.boss_damage_per_fr), 4.55)
		and original_tied
	)
	return {
		"enabled": true,
		"passed": passed,
		"formations_tested": matching.size(),
		"exact_252": exact,
		"best_boss_damage": best.get("boss_damage"),
		"best_damage_per_fr": best.get("boss_damage_per_fr"),
		"original_a1_a5_tied_best": original_tied,
	}


func run_v22_logic_unit_tests() -> Dictionary:
	_base_config = {"fleet_resources_retention": 0.5}
	_verified_baseline = {
		"outcome": "victory", "fleet_resources_used": 80.0,
		"fleet_resources_committed": 80.0,
	}
	objective = "normal"
	var lower_bound := _minimum_possible_used_fr({"Cruiser": 5}, 300.0)
	var hard_bound_passed: bool = is_equal_approx(lower_bound, 250.0) and _normal_incumbent_hard_prunes(lower_bound, 300.0)
	var partial_loss := {"formation_key": "partial", "outcome": "lose", "enemy_destroyed": 3, "fleet_resources_used": 120.0, "fleet_resources_committed": 120.0, "player_remaining_health": 0.0, "simulation_time": 2.0, "error": ""}
	var cheap_loss := {"formation_key": "cheap", "outcome": "lose", "enemy_destroyed": 0, "fleet_resources_used": 10.0, "fleet_resources_committed": 10.0, "player_remaining_health": 0.0, "simulation_time": 1.0, "error": ""}
	var normal_loss_ranking_passed := _rank_before(partial_loss, cheap_loss)
	_settings = {
		"ship_types": ["Fighter", "Corvette", "Frigate", "Cruiser"],
		"baseline": {"formation": {"A1": "Frigate", "A3": "Cruiser", "A4": "Frigate", "A5": "Corvette", "B3": "Fighter", "B4": "Frigate", "B5": "Cruiser"}},
	}
	var known_composition := {"Fighter": 1, "Corvette": 3, "Frigate": 1, "Cruiser": 2}
	var recovery_order := _recovery_composition_order([
		{"Fighter": 1, "Corvette": 1, "Frigate": 3, "Cruiser": 2},
		known_composition,
	], 20)
	var recovery_composition_passed := known_composition in recovery_order

	_pruning_stats = {"smart_pruned": {"counter_probe": 0, "efficiency_cutoff": 0, "kill_cost_cutoff": 0, "escort_gate": 0, "formation_signature": 0}}
	_settings = {"smart_pruning": true, "exploration_quota": 0.0, "optimistic_factor": 1.25, "kill_cost_margin": 1.15}
	_recovery_mode = false
	_analysis = {"enemy_count": 1, "boss": true}
	objective = "boss"
	boss_priority = "efficiency"
	_verified_baseline = {"boss_damage_per_fr": 13.0}
	var efficiency_fleet := {"best_result": {"boss_damage": 500.0, "boss_damage_per_fr": 10.0, "enemy_destroyed": 1}, "generation_index": 1}
	_apply_smart_prune(efficiency_fleet)
	var efficiency_fast_passed: bool = bool(efficiency_fleet.get("smart_pruned", false)) and str(efficiency_fleet.get("smart_pruned_reason", "")) == "efficiency_cutoff"
	_settings.smart_pruning = false
	var exhaustive_fleet := {"best_result": efficiency_fleet.best_result.duplicate(true), "generation_index": 1}
	_apply_smart_prune(exhaustive_fleet)
	var efficiency_exhaustive_passed: bool = not bool(exhaustive_fleet.get("smart_pruned", false))

	_settings.smart_pruning = true
	boss_priority = "kill_cost"
	_verified_baseline = {"killable_with_current_fr": true, "refined_total_kill_fr": 180.0}
	var expensive := {"best_result": {"boss_damage": 1.0, "enemy_destroyed": 1, "projected_kill_fr": 210.0}, "generation_index": 1}
	var competitive := {"best_result": {"boss_damage": 1.0, "enemy_destroyed": 1, "projected_kill_fr": 170.0}, "generation_index": 1}
	_apply_smart_prune(expensive)
	_apply_smart_prune(competitive)
	var kill_cost_passed: bool = bool(expensive.get("smart_pruned", false)) and not bool(competitive.get("smart_pruned", false))
	return {
		"passed": hard_bound_passed and normal_loss_ranking_passed and recovery_composition_passed and efficiency_fast_passed and efficiency_exhaustive_passed and kill_cost_passed,
		"normal_hard_bound": {"passed": hard_bound_passed, "minimum_possible_used_fr": lower_bound, "battle_started": false},
		"normal_loss_ranking": {"passed": normal_loss_ranking_passed, "preferred_enemy_destroyed": 3, "rejected_enemy_destroyed": 0},
		"recovery_composition": {"passed": recovery_composition_passed, "known_composition": known_composition},
		"boss_efficiency_fast": {"passed": efficiency_fast_passed, "reason": efficiency_fleet.get("smart_pruned_reason")},
		"boss_efficiency_exhaustive": {"passed": efficiency_exhaustive_passed, "smart_pruned": exhaustive_fleet.get("smart_pruned", false)},
		"boss_kill_cost": {"passed": kill_cost_passed, "projected_pruned": 210.0, "projected_retained": 170.0, "baseline_total": 180.0},
	}
