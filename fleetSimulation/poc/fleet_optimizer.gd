extends Node

var _grid_size := [2, 5]
var _cells := [
	[0, 0], [0, 1], [0, 2], [0, 3], [0, 4],
	[1, 0], [1, 1], [1, 2], [1, 3], [1, 4],
]

var objective := "normal"
var boss_priority := "legacy"
var boss_remaining_hp := 0.0


func _configure_grid(grid: Array) -> void:
	assert(grid.size() == 2 and int(grid[0]) > 0 and int(grid[0]) <= 26 and int(grid[1]) > 0, "Invalid deployment grid")
	_grid_size = [int(grid[0]), int(grid[1])]
	_cells = []
	for x in range(_grid_size[0]):
		for y in range(_grid_size[1]):
			_cells.append([x, y])


func _valid_grid_positions(formation: Array) -> bool:
	var occupied := {}
	for group in formation:
		var position = group.get("grid_position", [])
		if not position is Array or position.size() != 2:
			return false
		for axis in range(2):
			if typeof(position[axis]) not in [TYPE_INT, TYPE_FLOAT] or float(position[axis]) != float(int(position[axis])) or int(position[axis]) < 0 or int(position[axis]) >= int(_grid_size[axis]):
				return false
		var key := _position_name(position)
		if occupied.has(key):
			return false
		occupied[key] = true
	return true


func optimize(probe: Node, base_config: Dictionary, requested_objective: String = "normal", top_n: int = 10) -> Dictionary:
	assert(requested_objective in ["normal", "boss"], "Objective must be normal or boss")
	_configure_grid(base_config.get("grid_size", [2, 5]))
	objective = requested_objective
	var formations := generate_unique_formations(base_config.formation)
	if _grid_size == [2, 5]:
		_self_check()
	assert(_unique_count(formations) == formations.size(), "Candidate generator produced duplicates")

	var search_started := Time.get_ticks_msec()
	var ranked: Array = []
	var victories := 0
	var losses := 0
	var errors := 0
	var simulation_time_total := 0.0
	for candidate_index in range(formations.size()):
		var config := base_config.duplicate(true)
		config["formation"] = formations[candidate_index]
		var result: Dictionary = await probe.run_battle(config)
		var summary := _summarize_result(candidate_index + 1, result)
		ranked.append(summary)
		simulation_time_total += float(result.get("simulation_time", 0.0))
		if result.has("error"):
			errors += 1
		elif result.get("outcome") == "victory":
			victories += 1
		else:
			losses += 1
		await probe.cleanup_battle()
		if (candidate_index + 1) % 5 == 0 or candidate_index + 1 == formations.size():
			print("OPTIMIZER_PROGRESS=%d/%d victories=%d losses=%d errors=%d" % [
				candidate_index + 1, formations.size(), victories, losses, errors,
			])

	var search_elapsed := (Time.get_ticks_msec() - search_started) / 1000.0
	ranked.sort_custom(_rank_before)
	for rank_index in range(ranked.size()):
		ranked[rank_index]["rank"] = rank_index + 1

	var original_key := _formation_key(base_config.formation)
	var original_result: Dictionary
	for item in ranked:
		if item.formation_key == original_key:
			original_result = item
			break
	assert(not original_result.is_empty(), "Original formation was not generated")

	var replay_started := Time.get_ticks_msec()
	var replay_validation := await _replay_validation(probe, base_config, ranked, original_result)
	var replay_elapsed := (Time.get_ticks_msec() - replay_started) / 1000.0
	var best: Dictionary = ranked[0]
	var top_count := mini(top_n, ranked.size())
	return {
		"optimizer_version": 1,
		"objective": objective,
		"base_config": base_config,
		"search_space": {
			"cells": _cells,
			"deployment_groups": base_config.formation.size(),
			"equivalence_classes": _equivalence_class_summary(base_config.formation),
		},
		"total_candidates": formations.size(),
		"simulated": ranked.size(),
		"victories": victories,
		"losses": losses,
		"errors": errors,
		"has_victory": victories > 0,
		"search_elapsed_time_seconds": search_elapsed,
		"average_wall_time_per_simulation_seconds": search_elapsed / ranked.size(),
		"simulation_time_total": simulation_time_total,
		"replay_elapsed_time_seconds": replay_elapsed,
		"replay_validation": replay_validation,
		"original_result": original_result,
		"best_result": best,
		"improvement_over_original": {
			"original_rank": original_result.rank,
			"boss_damage_delta": float(best.boss_damage) - float(original_result.boss_damage),
			"fleet_resources_used_reduction": float(original_result.fleet_resources_used) - float(best.fleet_resources_used),
			"player_remaining_health_delta": float(best.player_remaining_health) - float(original_result.player_remaining_health),
		},
		"top": ranked.slice(0, top_count),
		"ranked_candidates": ranked,
	}


func generate_unique_formations(formation: Array) -> Array:
	assert(formation.size() <= _cells.size(), "Too many deployment groups for the standard grid")
	var classes := _equivalence_classes(formation)
	var results: Array = []
	_append_class_placements(formation, classes, 0, _cells.duplicate(true), [], results)
	return results


func _append_class_placements(
	formation: Array,
	classes: Array,
	class_index: int,
	available_cells: Array,
	placements: Array,
	results: Array,
) -> void:
	if class_index == classes.size():
		var candidate := formation.duplicate(true)
		for placement_index in range(classes.size()):
			for member_index in range(classes[placement_index].indices.size()):
				var formation_index: int = classes[placement_index].indices[member_index]
				candidate[formation_index]["grid_position"] = placements[placement_index][member_index].duplicate()
		results.append(candidate)
		return

	var count: int = classes[class_index].indices.size()
	for chosen_cells in _combinations(available_cells, count):
		var remaining_cells := available_cells.duplicate(true)
		for cell in chosen_cells:
			remaining_cells.erase(cell)
		placements.append(chosen_cells)
		_append_class_placements(formation, classes, class_index + 1, remaining_cells, placements, results)
		placements.pop_back()


func _combinations(cells: Array, count: int) -> Array:
	var results: Array = []
	_append_combinations(cells, count, 0, [], results)
	return results


func _append_combinations(cells: Array, count: int, start: int, current: Array, results: Array) -> void:
	if current.size() == count:
		results.append(current.duplicate(true))
		return
	var needed := count - current.size()
	for cell_index in range(start, cells.size() - needed + 1):
		current.append(cells[cell_index])
		_append_combinations(cells, count, cell_index + 1, current, results)
		current.pop_back()


func _equivalence_classes(formation: Array) -> Array:
	var classes: Array = []
	var class_by_signature := {}
	for formation_index in range(formation.size()):
		var signature := _group_signature(formation[formation_index])
		if not class_by_signature.has(signature):
			class_by_signature[signature] = classes.size()
			classes.append({"signature": signature, "indices": []})
		classes[class_by_signature[signature]].indices.append(formation_index)
	return classes


func _equivalence_class_summary(formation: Array) -> Array:
	var result: Array = []
	for item in _equivalence_classes(formation):
		result.append({"signature": item.signature, "count": item.indices.size()})
	return result


func _group_signature(item: Dictionary) -> String:
	var tertiary := Array(item.get("tertiary_mods", [])).duplicate()
	tertiary.sort()
	return JSON.stringify([
		str(item.ship),
		"" if item.get("primary_mod") == null else str(item.get("primary_mod", "")),
		"" if item.get("secondary_mod") == null else str(item.get("secondary_mod", "")),
		tertiary,
	])


func _formation_key(formation: Array) -> String:
	var grouped: Dictionary = {}
	for item in formation:
		var signature := _group_signature(item)
		if not grouped.has(signature):
			grouped[signature] = []
		grouped[signature].append(_position_name(item.grid_position))
	var signatures := grouped.keys()
	signatures.sort()
	var parts: Array[String] = []
	for signature in signatures:
		grouped[signature].sort()
		parts.append("%s:%s" % [signature, ",".join(PackedStringArray(grouped[signature]))])
	return "|".join(PackedStringArray(parts))


func _position_name(position: Array) -> String:
	return String.chr(65 + int(position[0])) + str(int(position[1]) + 1)


func _summarize_result(candidate_index: int, result: Dictionary) -> Dictionary:
	var survivors := 0
	var remaining_health := 0.0
	for ship in result.get("player_ships", []):
		if ship.get("alive", false):
			survivors += 1
		remaining_health += float(ship.get("hull", 0.0))
		remaining_health += float(ship.get("shields", 0.0))
		remaining_health += float(ship.get("barrier", 0.0))
	var enemy_destroyed := 0
	var enemy_remaining := 0
	for ship in result.get("enemy_ships", []):
		if ship.get("alive", false):
			enemy_remaining += 1
		else:
			enemy_destroyed += 1
	var formation := Array(result.get("battle_config", {}).get("formation", [])).duplicate(true)
	for item in formation:
		item["position"] = _position_name(item.grid_position)
	var canonical := _canonical_result(result)
	var used := float(result.get("fleet_resources_used", 0.0))
	var damage := float(result.get("boss_damage", 0.0))
	var efficiency := 0.0
	var efficiency_infinite := used == 0.0 and damage > 0.0
	if used > 0.0:
		efficiency = damage / used
	var summary := {
		"candidate_index": candidate_index,
		"rank": 0,
		"formation_key": _formation_key(formation),
		"formation": formation,
		"outcome": result.get("outcome", "error"),
		"fleet_resources_committed": result.get("fleet_resources_committed", 0.0),
		"fleet_resources_used": used,
		"boss_damage": damage,
		"boss_damage_per_fr": "INF" if efficiency_infinite else efficiency,
		"boss_damage_per_fr_is_infinite": efficiency_infinite,
		"player_survivors": survivors,
		"player_remaining_health": remaining_health,
		"enemy_destroyed": enemy_destroyed,
		"enemy_remaining": enemy_remaining,
		"simulation_time": result.get("simulation_time", 0.0),
		"simulation_clock": result.get("simulation_clock", {}).duplicate(true),
		"performance_breakdown": result.get("performance_breakdown", {}).duplicate(true),
		"canonical_sha256": JSON.stringify(canonical).sha256_text(),
		"error": result.get("error", ""),
	}
	_add_projected_boss_metrics(summary)
	return summary


func _add_projected_boss_metrics(summary: Dictionary) -> void:
	var damage := float(summary.get("boss_damage", 0.0))
	var used := float(summary.get("fleet_resources_used", 0.0))
	var projected_battles = null
	var projected_fr = null
	if boss_remaining_hp > 0.0 and damage > 0.0:
		projected_battles = ceili(boss_remaining_hp / damage)
		projected_fr = float(projected_battles) * used
	summary["boss_damage_per_battle"] = damage
	summary["fleet_resources_used_per_battle"] = used
	summary["boss_starting_hp"] = boss_remaining_hp if boss_remaining_hp > 0.0 else null
	summary["projected_battles_to_kill"] = projected_battles
	summary["projected_kill_fr"] = projected_fr
	summary["kill_refined"] = false
	summary["refined_battles_to_kill"] = null
	summary["refined_total_kill_fr"] = null
	summary["battles_to_kill"] = null
	summary["total_kill_fr"] = null
	summary["refined_fr_spent"] = null
	summary["boss_final_hp"] = null
	summary["killable_with_current_fr"] = null
	summary["remaining_fr_after_kill"] = null
	summary["kill_sequence"] = []
	summary["failed_before_battle"] = null


func _rank_before(a: Dictionary, b: Dictionary) -> bool:
	var a_error := str(a.error) != ""
	var b_error := str(b.error) != ""
	if a_error != b_error:
		return not a_error
	var a_win: bool = a.outcome == "victory"
	var b_win: bool = b.outcome == "victory"
	if objective == "boss" and boss_priority in ["efficiency", "kill_cost"]:
		return _boss_rank_before(a, b)
	if a_win != b_win:
		return a_win
	if objective == "boss":
		if not a_win:
			if a.boss_damage_per_fr_is_infinite != b.boss_damage_per_fr_is_infinite:
				return a.boss_damage_per_fr_is_infinite
			if not a.boss_damage_per_fr_is_infinite and a.boss_damage_per_fr != b.boss_damage_per_fr:
				return a.boss_damage_per_fr > b.boss_damage_per_fr
			if a.boss_damage != b.boss_damage:
				return a.boss_damage > b.boss_damage
		if a.fleet_resources_used != b.fleet_resources_used:
			return a.fleet_resources_used < b.fleet_resources_used
	else:
		if not a_win:
			if a.enemy_destroyed != b.enemy_destroyed:
				return a.enemy_destroyed > b.enemy_destroyed
			if a.player_remaining_health != b.player_remaining_health:
				return a.player_remaining_health > b.player_remaining_health
		if a.fleet_resources_used != b.fleet_resources_used:
			return a.fleet_resources_used < b.fleet_resources_used
	if a.fleet_resources_committed != b.fleet_resources_committed:
		return a.fleet_resources_committed < b.fleet_resources_committed
	if a.player_remaining_health != b.player_remaining_health:
		return a.player_remaining_health > b.player_remaining_health
	if objective == "normal" and a.simulation_time != b.simulation_time:
		return a.simulation_time < b.simulation_time
	return a.formation_key < b.formation_key


func _boss_rank_before(a: Dictionary, b: Dictionary) -> bool:
	if boss_priority == "efficiency":
		var efficiency_order := _compare_efficiency(a, b)
		if efficiency_order != 0:
			return efficiency_order < 0
		var a_total := _kill_fr_for_ranking(a)
		var b_total := _kill_fr_for_ranking(b)
		if a_total != b_total:
			return a_total < b_total
		if float(a.boss_damage) != float(b.boss_damage):
			return float(a.boss_damage) > float(b.boss_damage)
		if float(a.fleet_resources_used) != float(b.fleet_resources_used):
			return float(a.fleet_resources_used) < float(b.fleet_resources_used)
		if float(a.fleet_resources_committed) != float(b.fleet_resources_committed):
			return float(a.fleet_resources_committed) < float(b.fleet_resources_committed)
		return str(a.formation_key) < str(b.formation_key)

	var a_refined := bool(a.get("kill_refined", false))
	var b_refined := bool(b.get("kill_refined", false))
	var both_refined := a_refined and b_refined
	if both_refined:
		var a_killable := bool(a.get("killable_with_current_fr", false))
		var b_killable := bool(b.get("killable_with_current_fr", false))
		if a_killable != b_killable:
			return a_killable
		var a_total := _kill_fr_for_ranking(a)
		var b_total := _kill_fr_for_ranking(b)
		if a_total != b_total:
			return a_total < b_total
		var a_battles := _battles_for_ranking(a)
		var b_battles := _battles_for_ranking(b)
		if a_battles != b_battles:
			return a_battles < b_battles
	else:
		var a_projected := _nullable_number(a.get("projected_kill_fr"))
		var b_projected := _nullable_number(b.get("projected_kill_fr"))
		if a_projected != b_projected:
			return a_projected < b_projected
		var a_projected_battles := _nullable_number(a.get("projected_battles_to_kill"))
		var b_projected_battles := _nullable_number(b.get("projected_battles_to_kill"))
		if a_projected_battles != b_projected_battles:
			return a_projected_battles < b_projected_battles
	var efficiency_order := _compare_efficiency(a, b)
	if efficiency_order != 0:
		return efficiency_order < 0
	if float(a.fleet_resources_used) != float(b.fleet_resources_used):
		return float(a.fleet_resources_used) < float(b.fleet_resources_used)
	return str(a.formation_key) < str(b.formation_key)


func _compare_efficiency(a: Dictionary, b: Dictionary) -> int:
	var a_infinite := bool(a.get("boss_damage_per_fr_is_infinite", false))
	var b_infinite := bool(b.get("boss_damage_per_fr_is_infinite", false))
	if a_infinite != b_infinite:
		return -1 if a_infinite else 1
	var a_value := INF if a_infinite else float(a.get("boss_damage_per_fr", 0.0))
	var b_value := INF if b_infinite else float(b.get("boss_damage_per_fr", 0.0))
	if a_value == b_value:
		return 0
	return -1 if a_value > b_value else 1


func _kill_fr_for_ranking(item: Dictionary) -> float:
	if bool(item.get("kill_refined", false)):
		return _nullable_number(item.get("refined_total_kill_fr"))
	return _nullable_number(item.get("projected_kill_fr"))


func _battles_for_ranking(item: Dictionary) -> float:
	if bool(item.get("kill_refined", false)):
		return _nullable_number(item.get("refined_battles_to_kill"))
	return _nullable_number(item.get("projected_battles_to_kill"))


func _nullable_number(value) -> float:
	return INF if value == null else float(value)


func run_boss_ranking_unit_test() -> Dictionary:
	var saved_objective := objective
	var saved_priority := boss_priority
	var saved_hp := boss_remaining_hp
	objective = "boss"
	boss_remaining_hp = 2000.0
	var a := _fake_boss_summary("A", 50.0, 650.0)
	var b := _fake_boss_summary("B", 60.0, 670.0)
	boss_priority = "efficiency"
	var efficiency_first := "A" if _rank_before(a, b) else "B"
	boss_priority = "kill_cost"
	var kill_cost_first := "A" if _rank_before(a, b) else "B"
	objective = saved_objective
	boss_priority = saved_priority
	boss_remaining_hp = saved_hp
	return {
		"passed": efficiency_first == "A" and kill_cost_first == "B"
			and int(a.projected_battles_to_kill) == 4 and is_equal_approx(float(a.projected_kill_fr), 200.0)
			and int(b.projected_battles_to_kill) == 3 and is_equal_approx(float(b.projected_kill_fr), 180.0),
		"efficiency_first": efficiency_first,
		"kill_cost_first": kill_cost_first,
		"candidate_a": a,
		"candidate_b": b,
	}


func _fake_boss_summary(key: String, used: float, damage: float) -> Dictionary:
	var summary := {
		"formation_key": key, "outcome": "lose", "fleet_resources_committed": used,
		"fleet_resources_used": used, "boss_damage": damage, "boss_damage_per_fr": damage / used,
		"boss_damage_per_fr_is_infinite": false, "error": "",
	}
	_add_projected_boss_metrics(summary)
	return summary


func _canonical_result(result: Dictionary) -> Dictionary:
	var battle_log: Array = []
	for item in result.get("raw_battle_log", []):
		var event: Dictionary = item.duplicate(true)
		event.erase("time")
		battle_log.append(event)
	return {
		"outcome": result.get("outcome"),
		"fleet_resources_committed": result.get("fleet_resources_committed"),
		"fleet_resources_used": result.get("fleet_resources_used"),
		"boss_damage": result.get("boss_damage"),
		"player_ships": result.get("player_ships", []),
		"enemy_ships": result.get("enemy_ships", []),
		"raw_battle_log": battle_log,
		"copy_battle_log_text": result.get("copy_battle_log_text", ""),
		"runtime_effect_events": result.get("runtime_effect_events", []),
	}


func _replay_validation(
	probe: Node,
	base_config: Dictionary,
	ranked: Array,
	original_result: Dictionary,
) -> Dictionary:
	var selected := [
		{"label": "best", "expected": ranked[0]},
		{"label": "middle", "expected": ranked[floori(ranked.size() / 2.0)]},
		{"label": "original", "expected": original_result},
	]
	var runs: Array = []
	var all_identical := true
	for selection in selected:
		var config := base_config.duplicate(true)
		config["formation"] = selection.expected.formation
		var replay: Dictionary = await probe.run_battle(config)
		var actual := _summarize_result(selection.expected.candidate_index, replay)
		var identical := (
			str(actual.canonical_sha256) == str(selection.expected.canonical_sha256)
			and is_equal_approx(float(actual.simulation_time), float(selection.expected.simulation_time))
		)
		all_identical = all_identical and identical
		runs.append({
			"label": selection.label,
			"rank": selection.expected.rank,
			"formation": selection.expected.formation,
			"identical": identical,
			"expected_canonical_sha256": selection.expected.canonical_sha256,
			"actual_canonical_sha256": actual.canonical_sha256,
			"expected_simulation_time": selection.expected.simulation_time,
			"actual_simulation_time": actual.simulation_time,
			"error": replay.get("error", ""),
		})
		await probe.cleanup_battle()
	return {"all_identical": all_identical, "runs": runs}


func _self_check() -> void:
	var identical := []
	for row in range(5):
		identical.append({
			"ship": "Cruiser",
			"primary_mod": null,
			"secondary_mod": "M",
			"tertiary_mods": [],
			"grid_position": [0, row],
		})
	var identical_generated := generate_unique_formations(identical)
	assert(identical_generated.size() == 252, "Expected C(10,5)=252 identical candidates")
	assert(_unique_count(identical_generated) == identical_generated.size(), "Identical generator produced duplicates")
	var mixed := [
		{"ship": "Cruiser", "primary_mod": null, "secondary_mod": "M", "tertiary_mods": [], "grid_position": [0, 0]},
		{"ship": "Cruiser", "primary_mod": null, "secondary_mod": "M", "tertiary_mods": [], "grid_position": [0, 1]},
		{"ship": "Frigate", "primary_mod": null, "secondary_mod": null, "tertiary_mods": [], "grid_position": [0, 2]},
		{"ship": "Corvette", "primary_mod": null, "secondary_mod": null, "tertiary_mods": [], "grid_position": [0, 3]},
	]
	var mixed_generated := generate_unique_formations(mixed)
	assert(mixed_generated.size() == 2520, "Expected C(10,2)*C(8,1)*C(7,1)=2520 mixed candidates")
	assert(_unique_count(mixed_generated) == mixed_generated.size(), "Mixed generator produced duplicates")


func _unique_count(formations: Array) -> int:
	var keys := {}
	for formation in formations:
		keys[_formation_key(formation)] = true
	return keys.size()
