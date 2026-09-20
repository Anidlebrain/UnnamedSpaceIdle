extends "res://fleet_optimizer_v2.gd"
## Anytime portfolio. Only native deployment quotes and completed battles can
## reject/rank a candidate. Scheduling is explicitly not a proof of dominance.

var _rng := RandomNumberGenerator.new()
var _quotes := {}
var _cost_keys := {}
var _compositions: Array = []
var _composition_cursor := 0
var _global_pass := 0
var _pending := {}
var _mutation_streams := {}
var _support_ship_types: Array = []
var _parents: Array = []
var _parent_keys := {}
var _parent_cursor := 0
var _lanes := {"global": 0, "incumbent": 0, "archive": 0}
var _attempts := 0
var _quote_hits := 0
var _evaluated_compositions := {}
var _quoted_compositions := {}
var _generated := 0
var _rejected := 0
var _bootstrap_ms := 0.0
var _analysis_ms := 0.0
var _enumeration_ms := 0.0
var _scheduling_ms := 0.0
var _first_improvement = null
var _time_to_best := 0.0
var _incumbent_history: Array = []
var _exhaustive_complete := false
var _exhaustive_incomplete := false
var _stop_reason := "SEARCH SPACE SCHEDULE EXHAUSTED"
var _sequence_cache := {}
var _refinement_slice_deadline := INF
var _verified_kill_best := {}
var _max_battle_seconds := 1.0
var _shutdown_ms := 0.0
var _ipc_ms := 0.0


func optimize_v2(probe: Node, base_config: Dictionary, settings: Dictionary) -> Dictionary:
	_bootstrap_ms = float(Time.get_ticks_msec())
	_probe = probe
	_base_config = base_config.duplicate(true)
	_settings = settings.duplicate(true)
	_normalize_settings()
	_settings.smart_pruning = false
	_diagnostic = _settings.get("diagnostic", {}).duplicate(true)
	objective = str(_settings.get("objective", "normal"))
	boss_priority = str(_settings.get("boss_priority", "efficiency")) if objective == "boss" else "legacy"
	boss_remaining_hp = float(_settings.get("boss_remaining_hp", 0.0)) if objective == "boss" else 0.0
	_validate_settings()
	for detail in _base_config.get("resolver", {}).get("support_details", []):
		for definition in detail.get("definition", []):
			for reinforcement in definition.get("reinforcement_details", []):
				var ship: String = reinforcement.ship
				if ship in _settings.allowed_loadouts and ship not in _support_ship_types:
					_support_ship_types.append(ship)
	_environment_key = _battle_environment_key(_base_config)
	# Include engine/bootstrap time in the daily budget, not just the search loop.
	_started_msec = 0
	_rng.seed = 20260913
	_pruning_stats = {"generated": 0, "quoted_generated": 0, "simulated": 0, "refined": 0,
		"hard_pruned": {"fr_budget": 0, "disabled_ship": 0, "invalid_formation": 0}, "smart_pruned": {},
		"hard_pruning_enabled": true, "smart_pruning_enabled": false}
	_search_audit = {"candidates_generated": 0, "candidates_enumerated": 0, "normalized": 0,
		"deduplicated": 0, "queued": 0, "simulated": 0, "wins": 0, "losses": 0}
	_prepare_known_trace()
	_analyzer = preload("res://fleet_battle_analyzer.gd").new()
	add_child(_analyzer)
	var analysis_started := Time.get_ticks_usec()
	_analysis = _analyzer.analyze(_base_config, _settings.allowed_loadouts)
	_analysis_ms = (Time.get_ticks_usec() - analysis_started) / 1000.0
	_progress_stage_start("Baseline Validation", 1, 4, 1)
	_verified_baseline = await _run_verified_baseline()
	if _baseline_validation_failed:
		return _baseline_validation_failure_output()
	if _diagnostic.has("micro_test"):
		return await _run_micro_test(_diagnostic.micro_test)
	_start_workers()
	_seed_parent(_verified_baseline)
	if objective == "boss" and boss_priority == "kill_cost":
		_refinement_slice_deadline = minf(_elapsed_seconds() + float(_settings.max_wall_seconds) * 0.10, float(_settings.max_wall_seconds) * 0.35)
		await _refine_candidate(_verified_baseline)
		_refinement_slice_deadline = INF
		_consider_kill_best(_verified_baseline)
	_progress_stage_start("Interleaved Global / Archive / Incumbent Search", 2, 4)
	_prepare_space()
	if _profile == "exhaustive":
		await _search_exhaustive()
	else:
		await _search_anytime()
	_finalizing = true
	var ranked: Array = _cache.values()
	# A separate comparator keeps projected and verified kill rankings transitive.
	ranked.sort_custom(_schedule_before)
	var refinement := {"enabled": false}
	if objective == "boss" and boss_priority == "kill_cost":
		_progress_stage_start("Native Kill Sequences", 3, 4)
		refinement = await _refine_top_candidates(ranked)
	var finalists: Array = []
	for candidate in ranked:
		if str(candidate.get("error", "")) != "":
			continue
		if objective == "normal" and candidate.outcome != "victory":
			continue
		if objective == "boss" and boss_priority == "kill_cost" and not (candidate.get("killable_with_current_fr", false) == true):
			continue
		finalists.append(candidate)
	finalists.sort_custom(_rank_before)
	for index in range(finalists.size()):
		finalists[index].rank = index + 1
	var best: Dictionary = {} if finalists.is_empty() else finalists[0]
	_progress_stage_start("Final Native Replay", 4, 4, 1)
	var validation := await _attach_full_result(best)
	print("Final validation: %s" % validation)
	if not best.is_empty() and not validation.begins_with("FAILED"):
		print("Final verified: %s Used FR=%s Boss Damage/FR=%s" % [best.outcome, best.fleet_resources_used, best.boss_damage_per_fr])
	var cache_check := await _cache_validation(ranked)
	var counts := _result_counts(ranked)
	var shutdown_started := Time.get_ticks_usec()
	await _stop_workers()
	_shutdown_ms = (Time.get_ticks_usec() - shutdown_started) / 1000.0
	var status := "BEST FOUND" if not best.is_empty() else "NO VERIFIED AFFORDABLE KILL"
	if _exhaustive_complete and not (objective == "boss" and boss_priority == "kill_cost"):
		status = "EXHAUSTIVE BEST"
	if validation.begins_with("FAILED"):
		status = "FINAL VALIDATION FAILED"
		best = {}
	var output := {
		"optimizer_version": "3.0", "result_claim": status, "recommendation_status": status,
		"search_termination": _stop_reason, "budget_exhausted": _budget_exhausted,
		"search_profile": _profile, "search_goal": _goal, "search_mode": "lazy_exhaustive" if _profile == "exhaustive" else "anytime_portfolio",
		"objective": objective, "boss_priority": boss_priority, "boss_remaining_hp": boss_remaining_hp,
		"simulation_clock": best.get("simulation_clock", _probe.simulation_clock_metadata(_base_config)),
		"base_config": _base_config, "settings": _settings, "battle_analysis": _analysis,
		"verified_baseline": _verified_baseline, "baseline_warning": _baseline_warning,
		"improvement_vs_baseline": _improvement(best, _verified_baseline),
		"baseline_remains_recommended": not best.is_empty() and best.candidate_hash == _verified_baseline.candidate_hash,
		"best_result": best, "top": finalists.slice(0, int(_settings.get("top_n", 10))),
		"refined_finalists": finalists.slice(0, int(_settings.get("top_n", 10))), "ranked_candidates": ranked,
		"simulations_used": _simulations, "unique_results": ranked.size(), "cache_hits": _cache_hits,
		"victories": counts.victories, "losses": counts.losses,
		"errors": counts.errors + (1 if validation.begins_with("FAILED") else 0),
		"wall_time_seconds": _elapsed_seconds(), "time_to_first_improvement_seconds": _first_improvement,
		"time_to_best_seconds": _time_to_best, "incumbent_history": _incumbent_history,
		"deployment_quotes": _deployment_quotes, "deployment_quote_cache_hits": _quote_hits,
		"workers_requested": int(_settings.workers), "workers_effective": maxi(1, _workers.size()),
		"worker_startup": _worker_startup, "worker_warning": _worker_warning,
		"pruning_stats": _pruning_stats, "search_audit": _search_audit,
		"coverage": {"composition_count": _compositions.size(), "compositions_quoted": _quoted_compositions.size(),
			"compositions_simulated": _evaluated_compositions.size(), "native_quote_classes": _quotes.size(),
			"global_pass": _global_pass, "global_cursor": _composition_cursor, "scheduled_by_lane": _lanes,
			"candidate_attempts": _attempts, "materialized": _generated, "affordability_rejections": _rejected,
			"full_search_completed": _exhaustive_complete,
			"unvisited_status": "NOT SEARCHED; no mathematical rejection is claimed",
			"formation_count_in_configured_space": _estimated_formation_count},
		"performance_breakdown": _performance_breakdown(), "cache_validation": cache_check,
		"finalization_status": validation, "kill_sequence_refinement": refinement,
		"boss_ranking_unit_test": run_boss_ranking_unit_test(), "v1_regression": {"enabled": false},
	}
	return output


func _run_verified_baseline() -> Dictionary:
	var baseline: Dictionary = _settings.get("baseline", {})
	if not bool(baseline.get("enabled", false)) or baseline.get("formation", {}).is_empty():
		_baseline_validation_failed = true
		_baseline_warning = "BASELINE VALIDATION FAILED: a player-verified baseline is required"
		return {}
	var formation := _formation_from_candidate(baseline)
	var fleet := await _materialize(formation, true)
	if fleet.is_empty():
		_baseline_validation_failed = true
		_baseline_warning = "BASELINE VALIDATION FAILED: deployment is not affordable/enabled"
		return {}
	# Validation is mandatory even when startup has consumed the exploration budget.
	_mark_queued(formation)
	var raw: Dictionary = await _probe.run_battle(_config_for(formation))
	var cleanup: Dictionary = await _probe.cleanup_battle()
	raw.performance_breakdown["cleanup_ms"] = cleanup.get("cleanup_ms", 0.0)
	var result := _store_worker_result(fleet, formation, _environment_key + "|" + _formation_key(formation), raw)
	result["is_verified_baseline"] = true
	result["observed"] = baseline.get("observed", {}).duplicate(true)
	_baseline_validation_failed = str(result.error) != "" or (
		result.outcome != "victory" if objective == "normal" else float(result.boss_damage) <= 0.0)
	if _baseline_validation_failed:
		_baseline_warning = "BASELINE VALIDATION FAILED"
		print(_baseline_warning)
	else:
		for field in ["fleet_resources_used", "boss_damage"]:
			if result.observed.has(field) and float(result.observed[field]) >= 0 and not is_equal_approx(float(result.observed[field]), float(result[field])):
				_baseline_warning = "BASELINE OBSERVED RESULT DIFFERS FROM SIMULATION"
	return result


func _prepare_space() -> void:
	var started := Time.get_ticks_usec()
	_append_compositions(_ship_types(), 0, {}, _compositions)
	# Enumerate all composition descriptors before native evaluation. Round robin
	# across group counts and ship masks prevents a cheap-prefix monopoly.
	var buckets := {}
	for composition in _compositions:
		var count := 0
		var mask := 0
		var loadouts := 1
		for i in range(_ship_types().size()):
			var ship: String = _ship_types()[i]
			count += int(composition.get(ship, 0))
			if int(composition.get(ship, 0)) > 0:
				mask |= 1 << i
				loadouts *= _settings.allowed_loadouts[ship].size()
		for ship in _support_ship_types:
			if int(composition.get(ship, 0)) == 0:
				loadouts *= _settings.allowed_loadouts[ship].size()
		_estimated_formation_count += _unique_formation_count(composition) * loadouts
		var key := "%d:%d" % [count, mask]
		if not buckets.has(key):
			buckets[key] = []
		buckets[key].append(composition)
	var keys: Array = buckets.keys()
	_shuffle(keys)
	for key in keys:
		_shuffle(buckets[key])
	_compositions = []
	var remaining := true
	while remaining:
		remaining = false
		for key in keys:
			if not buckets[key].is_empty():
				_compositions.append(buckets[key].pop_back())
				remaining = true
	_search_audit.candidates_enumerated = _compositions.size()
	_search_audit["enumeration_unit"] = "composition descriptors; not materialized formation/loadout candidates"
	_search_audit["theoretical_candidate_count"] = _estimated_formation_count
	_enumeration_ms = (Time.get_ticks_usec() - started) / 1000.0
	print("All %d composition descriptors enumerated in %.1fms; %d formation/loadout combinations" % [_compositions.size(), _enumeration_ms, _estimated_formation_count])


func _search_anytime() -> void:
	var wave: Array = []
	while _can_expand():
		var started := Time.get_ticks_usec()
		# Global restart never depends on baseline proximity or a prior loss.
		var lane := "global" if _attempts % 4 == 0 else ("incumbent" if _attempts % 4 in [1, 2] else "archive")
		if _profile == "balanced":
			lane = "global" if _attempts % 10 in [0, 3, 6, 9] else ("incumbent" if _attempts % 10 in [1, 4, 7] else "archive")
		_attempts += 1
		var formation: Array = []
		if lane == "global":
			formation = _next_global()
		elif lane == "incumbent":
			formation = _next_mutation(_progress_best)
		else:
			if not _parents.is_empty():
				formation = _next_mutation(_parents[_parent_cursor % _parents.size()])
				_parent_cursor += 1
		_scheduling_ms += (Time.get_ticks_usec() - started) / 1000.0
		if formation.is_empty():
			continue
		var key := _environment_key + "|" + _formation_key(formation)
		if _cache.has(key) or _pending.has(key):
			_cache_hits += 1
			_search_audit.deduplicated += 1
			continue
		var fleet := await _materialize(formation)
		if fleet.is_empty():
			continue
		_pending[key] = true
		_lanes[lane] += 1
		wave.append({"fleet": fleet, "formation": formation})
		if wave.size() >= maxi(1, _workers.size()):
			await _consume_wave(wave)
			wave = []
	if not wave.is_empty() and _can_expand():
		await _consume_wave(wave)


func _consume_wave(wave: Array) -> void:
	for result in await _evaluate_batch(wave):
		if result.is_empty() or str(result.get("error", "")) != "":
			_exhaustive_incomplete = true
		if not result.is_empty():
			_seed_parent(result)
	_pending.clear()


func _next_global() -> Array:
	if _compositions.is_empty():
		return []
	var composition: Dictionary = _compositions[_composition_cursor]
	_composition_cursor += 1
	if _composition_cursor == _compositions.size():
		_composition_cursor = 0
		_global_pass += 1
	var loadouts := {}
	for ship in _ship_types():
		if int(composition.get(ship, 0)) > 0:
			var options: Array = _settings.allowed_loadouts[ship]
			loadouts[ship] = options[_rng.randi_range(0, options.size() - 1)]
	for ship in _support_ship_types:
		if not loadouts.has(ship):
			var options: Array = _settings.allowed_loadouts[ship]
			loadouts[ship] = options[_rng.randi_range(0, options.size() - 1)]
	var formation := _build_formation(composition, loadouts)
	_decorate_support(formation, loadouts)
	var cells := STANDARD_CELLS.duplicate(true)
	_shuffle(cells)
	for i in range(formation.size()):
		formation[i].grid_position = cells[i].duplicate()
	return formation


func _seed_parent(candidate: Dictionary) -> void:
	if candidate.is_empty() or str(candidate.get("error", "")) != "":
		return
	_evaluated_compositions[_composition_key(candidate.composition_counts)] = true
	var key := _composition_key(candidate.composition_counts) + JSON.stringify(candidate.ship_loadouts)
	if _parent_keys.has(key):
		var old: Dictionary = _parent_keys[key]
		if _schedule_before(candidate, old):
			_parents.erase(old)
			_parents.append(candidate)
			_parent_keys[key] = candidate
		return
	_parent_keys[key] = candidate
	_parents.append(candidate)
	# Preserve diverse losing compositions; a bad layout proves nothing.
	if _parents.size() > 32:
		var removed: Dictionary = _parents.pop_front()
		_parent_keys.erase(_composition_key(removed.composition_counts) + JSON.stringify(removed.ship_loadouts))


func _next_mutation(parent: Dictionary) -> Array:
	if parent.is_empty():
		return _next_global()
	var key: String = parent.formation_key
	if not _mutation_streams.has(key):
		_mutation_streams[key] = _build_mutation_stream(parent)
	var stream: Dictionary = _mutation_streams[key]
	var bucket_index := int(stream.cursor) % 6
	stream.cursor += 1
	var bucket: Array = stream.buckets[bucket_index]
	if not bucket.is_empty():
		return bucket.pop_back()
	# Keep global position jumps after the finite exact perturbations are spent.
	var formation: Array = parent.formation.duplicate(true)
	var cells := STANDARD_CELLS.duplicate(true)
	_shuffle(cells)
	for i in range(formation.size()):
		formation[i].grid_position = cells[i].duplicate()
	return formation


func _build_mutation_stream(parent: Dictionary) -> Dictionary:
	var formation: Array = parent.formation
	var buckets: Array = [[], [], [], [], [], []]
	# Worker JSON turns integer coordinates into floats. Array.erase() can then
	# fail to remove an occupied integer cell, producing a duplicate position
	# which the original battle scene silently relocates. Use the canonical grid
	# name so search, replay, and the user-facing formation describe one layout.
	var free := _free_cells(formation)
	var seen_ships := {}
	for i in range(formation.size()):
		var removed := formation.duplicate(true)
		removed.remove_at(i)
		if not removed.is_empty() and _within_ranges(removed):
			buckets[0].append(removed)
		var donor: String = formation[i].ship
		for ship in _ship_types():
			if not _ship_enabled(ship) or ship == donor:
				continue
			var selected := _loadout_for_parent(ship, parent)
			var replaced := formation.duplicate(true)
			replaced[i] = _formation_group(ship, selected, replaced[i].grid_position)
			if _within_ranges(replaced):
				buckets[1].append(replaced)
			for j in range(i + 1, formation.size()):
				if str(formation[j].ship) != donor:
					continue
				var pair := replaced.duplicate(true)
				pair[j] = _formation_group(ship, selected, pair[j].grid_position)
				if _within_ranges(pair):
					buckets[2].append(pair)
		if not seen_ships.has(donor):
			seen_ships[donor] = true
			for loadout in _settings.allowed_loadouts.get(donor, []):
				var modified := formation.duplicate(true)
				for group in modified:
					if str(group.ship) == donor:
						group.merge(_formation_group(donor, loadout, group.grid_position), true)
				buckets[3].append(modified)
	buckets[4] = _formation_neighbors(formation)
	if formation.size() < int(_settings.max_total_groups):
		for ship in _ship_types():
			if not _ship_enabled(ship):
				continue
			for cell in free:
				var added := formation.duplicate(true)
				added.append(_formation_group(ship, _loadout_for_parent(ship, parent), cell))
				if _within_ranges(added):
					buckets[5].append(added)
	var support_choices := _support_choices_from(formation)
	for bucket in buckets:
		for variant in bucket:
			_decorate_support(variant, support_choices)
	for ship in _support_ship_types:
		if not seen_ships.has(ship):
			for loadout in _settings.allowed_loadouts[ship]:
				var choices := support_choices.duplicate(true)
				choices[ship] = loadout
				var modified := formation.duplicate(true)
				_decorate_support(modified, choices)
				buckets[3].append(modified)
	for bucket in buckets:
		_shuffle(bucket)
	return {"cursor": 0, "buckets": buckets}


func _loadout_for_parent(ship: String, parent: Dictionary) -> Dictionary:
	for group in parent.formation:
		if str(group.ship) == ship:
			var result: Dictionary = group.duplicate(true)
			result["id"] = _slot_loadout_id(group.get("primary_mod"), group.get("secondary_mod"))
			return result
	var options: Array = _settings.allowed_loadouts[ship]
	return options[_rng.randi_range(0, options.size() - 1)]


func _within_ranges(formation: Array) -> bool:
	var counts := {}
	for group in formation:
		counts[group.ship] = int(counts.get(group.ship, 0)) + 1
	for ship in _ship_types():
		var limits: Dictionary = _settings.group_ranges.get(ship, {})
		if int(counts.get(ship, 0)) < int(limits.get("min", 0)) or int(counts.get(ship, 0)) > int(limits.get("max", 0)):
			return false
	return true


func _occupied_position_names(formation: Array) -> Dictionary:
	var occupied := {}
	for group in formation:
		occupied[_position_name(Array(group.grid_position))] = true
	return occupied


func _free_cells(formation: Array) -> Array:
	var occupied := _occupied_position_names(formation)
	var free: Array = []
	for cell in STANDARD_CELLS:
		if not occupied.has(_position_name(cell)):
			free.append(cell.duplicate())
	return free


func _has_unique_positions(formation: Array) -> bool:
	return _occupied_position_names(formation).size() == formation.size()


func _materialize(formation: Array, mandatory: bool = false) -> Dictionary:
	_generated += 1
	_pruning_stats.generated += 1
	_search_audit.candidates_generated += 1
	if not _has_unique_positions(formation):
		var hard_pruned: Dictionary = _pruning_stats.get("hard_pruned", {})
		hard_pruned["invalid_formation"] = int(hard_pruned.get("invalid_formation", 0)) + 1
		_pruning_stats["hard_pruned"] = hard_pruned
		_rejected += 1
		return {}
	var composition := {}
	var loadouts := {}
	for group in formation:
		var ship: String = group.ship
		if not _ship_enabled(ship):
			_pruning_stats.hard_pruned.disabled_ship += 1
			return {}
		composition[ship] = int(composition.get(ship, 0)) + 1
		loadouts[ship] = {"id": _slot_loadout_id(group.get("primary_mod"), group.get("secondary_mod")),
			"primary_mod": group.get("primary_mod"), "secondary_mod": group.get("secondary_mod"),
			"tertiary_mods": group.get("tertiary_mods", [])}
	# Native calc_total_deployment depends on type counts, native modded cost and
	# availability, not positions. Never merge combat candidates by this quote key.
	var base_cost_lower_bound := 0.0
	var known_nonnegative_costs := true
	for ship in composition:
		var signature: String = str(ship) + JSON.stringify(loadouts[ship])
		if not _cost_keys.has(signature):
			known_nonnegative_costs = false
			continue
		base_cost_lower_bound += int(composition[ship]) * float(_cost_keys[signature])
		known_nonnegative_costs = known_nonnegative_costs and float(_cost_keys[signature]) >= 0.0
	# Only costs observed in an actual native deployment scene can support this
	# lower bound. An unknown loadout must first receive a native quote.
	if not mandatory and known_nonnegative_costs and not NumberUtils.fleet_less_or_equal(base_cost_lower_bound, float(_base_config.fleet_resources)):
		_pruning_stats.hard_pruned.fr_budget += 1
		_rejected += 1
		return {}
	var key := _native_quote_key(composition, loadouts)
	var quote: Dictionary
	if key != "" and _quotes.has(key):
		_quote_hits += 1
		quote = _quotes[key]
	else:
		if not mandatory and not _can_expand():
			return {}
		var started := Time.get_ticks_usec()
		quote = await _probe.quote_player_deployment(_config_for(formation), _workers.is_empty())
		_quote_wall_ms += (Time.get_ticks_usec() - started) / 1000.0
		_deployment_quotes += 1
		for ship in composition:
			if quote.get("native_modded_costs", {}).has(ship):
				_cost_keys[str(ship) + JSON.stringify(loadouts[ship])] = quote.native_modded_costs[ship]
		key = _native_quote_key(composition, loadouts)
		if key != "":
			_quotes[key] = quote
	_quoted_compositions[_composition_key(composition)] = true
	if not quote.deployable or not quote.within_budget:
		_pruning_stats.hard_pruned.fr_budget += 1
		_rejected += 1
		return {}
	for ship in _support_choices_from(formation):
		if not loadouts.has(ship):
			loadouts[ship] = _support_choices_from(formation)[ship]
	return {"composition": composition, "ship_loadouts": loadouts, "deployment": quote.deployment,
		"fleet_resources_committed_quote": quote.fleet_resources_committed, "is_overdeploy": _quote_has_overdeploy(quote)}


func _native_quote_key(composition: Dictionary, loadouts: Dictionary) -> String:
	var parts: Array[String] = []
	for ship in _ship_types():
		if not composition.has(ship):
			continue
		var signature: String = ship + JSON.stringify(loadouts[ship])
		if not _cost_keys.has(signature):
			return ""
		parts.append(JSON.stringify([ship, composition[ship], _cost_keys[signature]], "", true, true))
	return "|".join(parts)


func _evaluation_config(formation: Array) -> Dictionary:
	return _config_for(formation)


func _config_for(formation: Array) -> Dictionary:
	var config := _base_config.duplicate(true)
	config.formation = formation.duplicate(true)
	config.simulation_detail = str(_settings.simulation_detail)
	config.fleet_mod_loadouts = _support_choices_from(formation)
	return config


func _shuffle(values: Array) -> void:
	for i in range(values.size() - 1, 0, -1):
		var j := _rng.randi_range(0, i)
		var temporary = values[i]
		values[i] = values[j]
		values[j] = temporary


func _schedule_before(a: Dictionary, b: Dictionary) -> bool:
	if objective != "boss" or boss_priority != "kill_cost":
		return _rank_before(a, b)
	var a_error := str(a.get("error", "")) != ""
	var b_error := str(b.get("error", "")) != ""
	if a_error != b_error:
		return not a_error
	var av := _nullable_number(a.get("projected_kill_fr"))
	var bv := _nullable_number(b.get("projected_kill_fr"))
	if av != bv:
		return av < bv
	var efficiency := _compare_efficiency(a, b)
	return efficiency < 0 if efficiency != 0 else str(a.formation_key) < str(b.formation_key)


func _can_simulate() -> bool:
	return _can_expand() if not _finalizing and not _refining_kill_sequences else _elapsed_seconds() < float(_settings.max_wall_seconds) - maxf(2.0, _max_battle_seconds * 1.5)


func _can_expand() -> bool:
	var reserve := maxf(5.0, _max_battle_seconds * 2.0)
	if objective == "boss" and boss_priority == "kill_cost":
		reserve = maxf(reserve, float(_settings.max_wall_seconds) * 0.20)
	if _elapsed_seconds() >= float(_settings.max_wall_seconds) - reserve:
		_budget_exhausted = true
		_stop_reason = "TIME BUDGET REACHED"
		return false
	if _simulations >= int(_settings.max_simulations):
		_budget_exhausted = true
		_stop_reason = "SIMULATION BUDGET REACHED"
		return false
	return true


func _record_performance(performance: Dictionary, cleanup: Dictionary) -> void:
	super._record_performance(performance, cleanup)
	_max_battle_seconds = maxf(_max_battle_seconds, (float(performance.get("run_battle_total_ms_before_cleanup", 0.0)) + float(cleanup.get("cleanup_ms", 0.0))) / 1000.0)


func _progress_consider_best(candidate: Dictionary) -> void:
	if candidate.is_empty() or str(candidate.get("error", "")) != "":
		return
	if not _progress_best.is_empty() and not _schedule_before(candidate, _progress_best):
		return
	var quality_improved := _progress_best.is_empty() or _objective_improved(candidate, _progress_best)
	_progress_best = candidate
	if not quality_improved:
		return
	if objective == "boss" and boss_priority == "kill_cost":
		return # A single-battle estimate is not a verified kill-cost improvement.
	_time_to_best = _elapsed_seconds()
	if not _verified_baseline.is_empty() and _objective_improved(candidate, _verified_baseline) and _first_improvement == null:
		_first_improvement = _time_to_best
	_incumbent_history.append({"seconds": _time_to_best, "used_fr": candidate.fleet_resources_used,
		"boss_damage_per_fr": candidate.boss_damage_per_fr, "candidate_hash": candidate.candidate_hash})
	print("Best native candidate: %s Used FR=%s Boss Damage/FR=%s at %.2fs" % [candidate.outcome, candidate.fleet_resources_used, candidate.boss_damage_per_fr, _time_to_best])


func _objective_improved(a: Dictionary, b: Dictionary) -> bool:
	if objective == "normal":
		return a.outcome == "victory" and (b.outcome != "victory" or float(a.fleet_resources_used) < float(b.fleet_resources_used))
	if boss_priority == "efficiency":
		return _compare_efficiency(a, b) < 0
	return (a.get("killable_with_current_fr", false) == true) and (not (b.get("killable_with_current_fr", false) == true) or float(a.refined_total_kill_fr) < float(b.refined_total_kill_fr))


func _refine_top_candidates(broad_ranked: Array) -> Dictionary:
	var tested := 0
	var requested := maxi(3, int(_settings.kill_refine_top_n))
	var seen_compositions := {}
	var ordered: Array = []
	# Half quality-ranked, half composition-diverse. These estimates schedule only.
	for candidate in broad_ranked.slice(0, requested):
		ordered.append(candidate)
	for candidate in broad_ranked:
		var key := _composition_key(candidate.composition_counts)
		if not seen_compositions.has(key):
			seen_compositions[key] = true
			if candidate not in ordered:
				ordered.append(candidate)
	for candidate in ordered:
		if not _can_simulate():
			break
		if float(candidate.boss_damage) <= 0 or str(candidate.error) != "":
			continue
		await _refine_candidate(candidate)
		_consider_kill_best(candidate)
		tested += 1
	return {"enabled": true, "candidates_requested": ordered.size(), "candidates_refined": tested,
		"partial": tested < ordered.size(), "comparison": "completed affordable native sequences only"}


func _refine_candidate(candidate: Dictionary) -> void:
	if bool(candidate.get("kill_refined", false)):
		return
	_refining_kill_sequences = true
	var hp := boss_remaining_hp
	var available := float(_base_config.fleet_resources)
	var total := 0.0
	var sequence: Array = []
	var reason := "battle_limit_reached"
	var required_committed := float(candidate.deployment_quote_committed_fr)
	for index in range(int(_settings.kill_sequence_max_battles)):
		if not NumberUtils.fleet_less_or_equal(required_committed, available):
			reason = "insufficient_committed_fr"
			break
		var result: Dictionary = candidate
		if index > 0:
			if _elapsed_seconds() >= _refinement_slice_deadline:
				reason = "refinement_slice_budget_reached"
				break
			if not _can_simulate():
				reason = "time_budget_reached"
				break
			var config := _config_for(candidate.formation)
			config.boss_health = hp
			config.fight_enemy_command_ship = false
			config.fleet_resources = available
			var key: String = _battle_environment_key(config) + "|" + candidate.formation_key
			if _sequence_cache.has(key):
				_cache_hits += 1
				result = _sequence_cache[key]
			else:
				result = await _probe.run_battle(config)
				_simulations += 1
				_pruning_stats.simulated += 1
				var cleanup: Dictionary = await _probe.cleanup_battle()
				_record_performance(result.get("performance_breakdown", {}), cleanup)
				_sequence_cache[key] = result
		if str(result.get("error", "")) != "":
			reason = str(result.error)
			break
		var damage := float(result.boss_damage)
		var used := float(result.fleet_resources_used)
		var before := hp
		hp = maxf(0.0, hp - damage)
		# Invoke original Fleet.battle_complete -> PlayerInfo.gain_resource. The
		# native ledger floors FR; objective still sums the exact reported Used FR.
		var ledger: Dictionary = _probe.native_fr_settlement(str(_base_config.galaxy_id), available, used)
		available = float(ledger.resources_after)
		total += used
		sequence.append({"battle": index + 1, "boss_hp_before": before, "boss_damage": damage,
			"boss_hp_after": hp, "committed_fr": required_committed, "used_fr": used,
			"native_resource_debit": ledger.resource_debit, "fr_remaining": available,
			"outcome": result.outcome})
		if hp <= 0:
			reason = "boss_killed"
			break
		if damage <= 0:
			reason = "boss_damage_not_positive"
			break
	var killed := hp <= 0.0
	candidate.kill_refined = reason not in ["time_budget_reached", "battle_limit_reached", "refinement_slice_budget_reached"]
	candidate.killable_with_current_fr = killed
	candidate.refined_total_kill_fr = total if killed else null
	candidate.refined_battles_to_kill = sequence.size() if killed else null
	candidate.total_kill_fr = candidate.refined_total_kill_fr
	candidate.battles_to_kill = candidate.refined_battles_to_kill
	candidate.refined_fr_spent = total
	candidate.kill_sequence = sequence
	candidate.kill_sequence_stop_reason = reason
	candidate.boss_final_hp = hp
	candidate.remaining_fr_after_kill = available if killed else null
	candidate.failed_before_battle = null if killed else sequence.size() + 1
	_pruning_stats.refined += 1
	_refining_kill_sequences = false


func _consider_kill_best(candidate: Dictionary) -> void:
	if not (candidate.get("killable_with_current_fr", false) == true):
		return
	if not _verified_kill_best.is_empty() and not _rank_before(candidate, _verified_kill_best):
		return
	var quality_improved := _verified_kill_best.is_empty() or _objective_improved(candidate, _verified_kill_best)
	_verified_kill_best = candidate
	if not quality_improved:
		return
	_time_to_best = _elapsed_seconds()
	if _objective_improved(candidate, _verified_baseline) and _first_improvement == null:
		_first_improvement = _time_to_best
	_incumbent_history.append({"seconds": _time_to_best, "total_used_fr": candidate.refined_total_kill_fr,
		"candidate_hash": candidate.candidate_hash})


func _attach_full_result(candidate: Dictionary) -> String:
	if candidate.is_empty():
		return "NO VERIFIED CANDIDATE"
	if not _has_unique_positions(Array(candidate.get("formation", []))):
		return "FAILED: candidate formation contains duplicate grid positions"
	var config := _config_for(candidate.formation)
	config.simulation_detail = "full"
	var raw: Dictionary = await _probe.run_battle(config)
	_simulations += 1
	var cleanup: Dictionary = await _probe.cleanup_battle()
	_record_performance(raw.get("performance_breakdown", {}), cleanup)
	var actual := _summarize_result(_simulations, raw)
	var mismatch := {}
	var fields := ["outcome", "fleet_resources_used", "fleet_resources_committed", "boss_damage", "player_remaining_health", "enemy_destroyed"]
	# Realtime snapshot timing includes post-battle physics/process frame waits.
	# Keep the existing reference canonical semantics; offline replay is stricter.
	if str(_settings.simulation_clock) == "offline_fixed_step":
		fields.append("simulation_time")
	for key in fields:
		if not _replay_field_matches(key, candidate.get(key), actual.get(key)):
			mismatch[key] = {"search": candidate.get(key), "replay": actual.get(key)}
			if key == "simulation_time":
				mismatch[key]["search_physics_ticks"] = roundi(float(candidate.get(key)) * Engine.physics_ticks_per_second)
				mismatch[key]["replay_physics_ticks"] = roundi(float(actual.get(key)) * Engine.physics_ticks_per_second)
	candidate.full_battle_result = raw
	if not mismatch.is_empty() or raw.has("error"):
		return "FAILED: native replay differences=%s; error=%s" % [JSON.stringify(mismatch), raw.get("error", "")]
	return "COMPLETE: native replay matches search result"


func _replay_field_matches(key: String, search_value, replay_value) -> bool:
	if key == "simulation_time" and str(_settings.simulation_clock) == "offline_fixed_step":
		# Fixed-step time is accumulated as a float. Separate Godot processes can
		# differ in the last binary digit while completing on the same physics tick.
		return (
			roundi(float(search_value) * Engine.physics_ticks_per_second)
			== roundi(float(replay_value) * Engine.physics_ticks_per_second)
		)
	if key in ["fleet_resources_used", "fleet_resources_committed", "boss_damage", "player_remaining_health"]:
		# Worker results cross a JSON/process boundary. Preserve strict null handling,
		# but do not reject the same native result for a floating-point tail that is
		# shorter than the value printed in the failure diagnostic.
		if search_value == null or replay_value == null:
			return search_value == replay_value
		return is_equal_approx(float(search_value), float(replay_value))
	return search_value == replay_value


func _performance_breakdown() -> Dictionary:
	var result := super._performance_breakdown()
	result["candidate_generation_ms"] = _enumeration_ms + _scheduling_ms
	result["process_bootstrap_ms"] = _bootstrap_ms
	result["candidate_preprocessing_ms"] = _analysis_ms
	result["enumeration_ms"] = _enumeration_ms
	result["scheduling_ms"] = _scheduling_ms
	result["worker_shutdown_ms"] = _shutdown_ms
	result["worker_serialization_io_ms"] = _ipc_ms
	result["max_observed_battle_seconds"] = _max_battle_seconds
	result["battle_totals_ms"] = _performance_totals.duplicate()
	return result


func _search_exhaustive() -> void:
	# Lazy mixed-radix loadouts + combinatorial unranking: bounded memory even
	# for millions of arrangements. Completion is asserted only after every item.
	for composition in _compositions:
		var used_types: Array = []
		for ship in _ship_types():
			if int(composition.get(ship, 0)) > 0:
				used_types.append(ship)
		for ship in _support_ship_types:
			if ship not in used_types:
				used_types.append(ship)
		for loadout_index in range(_loadout_combination_count(used_types)):
			var cursor := loadout_index
			var loadouts := {}
			for ship in used_types:
				var options: Array = _settings.allowed_loadouts[ship]
				loadouts[ship] = options[cursor % options.size()]
				cursor = cursor / options.size()
			var seed := _build_formation(composition, loadouts)
			_decorate_support(seed, loadouts)
			var fleet: Dictionary = {}
			var wave: Array = []
			for index in range(_unique_formation_count(composition)):
				if not _can_expand():
					return
				var formation := _formation_at(seed, index)
				if fleet.is_empty():
					fleet = await _materialize(formation)
					if fleet.is_empty():
						_exhaustive_incomplete = _exhaustive_incomplete or _budget_exhausted
						break
				wave.append({"fleet": fleet, "formation": formation})
				if wave.size() >= maxi(1, _workers.size()):
					await _consume_wave(wave)
					wave = []
			if not wave.is_empty():
				await _consume_wave(wave)
	_exhaustive_complete = not _exhaustive_incomplete
	_stop_reason = "CONFIGURED SPACE EXHAUSTED"


func _formation_at(seed: Array, index: int) -> Array:
	var classes := _equivalence_classes(seed)
	var cells := STANDARD_CELLS.duplicate(true)
	var result := seed.duplicate(true)
	for group_class in classes:
		var count: int = group_class.indices.size()
		var radix := _choose(cells.size(), count)
		var rank_in_class := index % radix
		index = index / radix
		var chosen: Array = []
		var start := 0
		for k in range(count):
			for i in range(start, cells.size()):
				var block := _choose(cells.size() - i - 1, count - k - 1)
				if rank_in_class < block:
					chosen.append(cells[i])
					start = i + 1
					break
				rank_in_class -= block
		for k in range(count):
			result[group_class.indices[k]].grid_position = chosen[k].duplicate()
			cells.erase(chosen[k])
	return result


func _baseline_validation_failure_output() -> Dictionary:
	var failure := super._baseline_validation_failure_output()
	failure.optimizer_version = "3.0"
	failure.baseline_validation["deployment_quotes"] = _quotes.values()
	failure.baseline_validation["reason"] = _baseline_warning
	print("BASELINE VALIDATION FAILED: ", JSON.stringify(failure.baseline_validation))
	return failure


func _support_choices_from(formation: Array) -> Dictionary:
	var choices: Dictionary = {} if formation.is_empty() else formation[0].get("support_loadouts", {}).duplicate(true)
	for ship in _support_ship_types:
		for group in formation:
			if str(group.ship) == ship:
				choices[ship] = {"id": _slot_loadout_id(group.get("primary_mod"), group.get("secondary_mod")),
					"primary_mod": group.get("primary_mod"), "secondary_mod": group.get("secondary_mod"),
					"tertiary_mods": group.get("tertiary_mods", [])}
	return choices


func _decorate_support(formation: Array, choices: Dictionary) -> void:
	if _support_ship_types.is_empty():
		return
	var selected := {}
	for ship in _support_ship_types:
		selected[ship] = choices.get(ship, {"id": "none", "primary_mod": null, "secondary_mod": null, "tertiary_mods": []}).duplicate(true)
	for group in formation:
		group["support_loadouts"] = selected.duplicate(true)


func _formation_from_candidate(candidate: Dictionary) -> Array:
	var formation := super._formation_from_candidate(candidate)
	var choices := {}
	for ship in _support_ship_types:
		var selected: Dictionary = candidate.get("loadouts", {}).get(ship, {})
		choices[ship] = {"id": _slot_loadout_id(selected.get("primary"), selected.get("secondary")),
			"primary_mod": selected.get("primary"), "secondary_mod": selected.get("secondary"),
			"tertiary_mods": selected.get("tertiary", [])}
	_decorate_support(formation, choices)
	return formation


func _formation_key(formation: Array) -> String:
	var key := super._formation_key(formation)
	var parts: Array[String] = []
	var choices := _support_choices_from(formation)
	for ship in _support_ship_types:
		var deployed := false
		for group in formation:
			deployed = deployed or str(group.ship) == ship
		if not deployed:
			var group: Dictionary = choices.get(ship, {}).duplicate(true)
			group["ship"] = ship
			parts.append(_group_signature(group))
	parts.sort()
	return key if parts.is_empty() else key + "|support:" + "|".join(parts)


func _run_worker_wave(configs: Array) -> Array:
	var results: Array = []
	if not _workers_ready_reported:
		var deadline := Time.get_ticks_msec() + int(minf(60.0, maxf(0.0, float(_settings.max_wall_seconds) - _elapsed_seconds() - 5.0)) * 1000)
		while Time.get_ticks_msec() < deadline:
			var ready := true
			for worker in _workers:
				ready = ready and FileAccess.file_exists(str(worker.dir).path_join("ready.json"))
			if ready:
				_workers_ready_reported = true
				break
			OS.delay_msec(5)
			await get_tree().process_frame
		if not _workers_ready_reported:
			_worker_warning = "Worker startup exceeded remaining budget; single-process fallback"
			for worker in _workers:
				OS.kill(int(worker.pid))
			_workers.clear()
		else:
			for worker in _workers:
				var metadata := _read_worker_json(str(worker.dir).path_join("ready.json"))
				worker["user_data_dir"] = metadata.get("user_data_dir", "")
				_worker_startup.append(metadata)
	if _workers.is_empty():
		for config in configs:
			var result: Dictionary = await _probe.run_battle(config)
			var cleanup: Dictionary = await _probe.cleanup_battle()
			result.performance_breakdown["cleanup_ms"] = cleanup.get("cleanup_ms", 0.0)
			results.append(result)
		return results
	var request_id := str(Time.get_ticks_usec())
	var started := Time.get_ticks_usec()
	for index in range(configs.size()):
		_write_worker_json(str(_workers[index].dir).path_join("request.json"), {
			"id": request_id, "items": [{"index": index, "config": configs[index]}]})
	_ipc_ms += (Time.get_ticks_usec() - started) / 1000.0
	var response_deadline := Time.get_ticks_msec() + 140000
	for index in range(configs.size()):
		var worker: Dictionary = _workers[index]
		var path := str(worker.dir).path_join("response_%s.json" % request_id)
		while not FileAccess.file_exists(path) and OS.is_process_running(int(worker.pid)) and Time.get_ticks_msec() < response_deadline:
			OS.delay_msec(2)
			await get_tree().process_frame
		if FileAccess.file_exists(path):
			started = Time.get_ticks_usec()
			var response := _read_worker_json(path)
			DirAccess.remove_absolute(path)
			_ipc_ms += (Time.get_ticks_usec() - started) / 1000.0
			results.append(response.results[0].result)
		else:
			results.append({"error": "Worker failed or timed out", "battle_config": configs[index]})
	return results


func _group_signature(item: Dictionary) -> String:
	# Conservatively retain tertiary application order and any explicit difficulty.
	# Similar-looking loadouts/positions are never a combat-equivalence proof.
	return JSON.stringify([str(item.ship),
		"" if item.get("primary_mod") == null else str(item.primary_mod),
		"" if item.get("secondary_mod") == null else str(item.secondary_mod),
		item.get("tertiary_mods", []), item.get("difficulty_override", -1.0)], "", true, true)


func _battle_environment_key(config: Dictionary) -> String:
	var environment := config.duplicate(true)
	for metadata in ["formation", "optimizer", "resolver", "simulation_detail"]:
		environment.erase(metadata)
	return JSON.stringify(environment, "", true, true).sha256_text()



func _improvement(candidate: Dictionary, baseline: Dictionary) -> Dictionary:
	if candidate.is_empty() or baseline.is_empty():
		return {"available": false}
	if objective == "boss" and boss_priority == "efficiency" and (
		candidate.get("boss_damage_per_fr_is_infinite", false) or baseline.get("boss_damage_per_fr_is_infinite", false)):
		return {"available": true, "strictly_better": _objective_improved(candidate, baseline),
			"same_as_baseline": candidate.candidate_hash == baseline.candidate_hash,
			"damage_per_fr_gain": "INF" if _objective_improved(candidate, baseline) else 0.0,
			"percent": null, "note": "infinite efficiency has no finite percentage gain"}
	var result := super._improvement(candidate, baseline)
	result.strictly_better = _objective_improved(candidate, baseline)
	return result
