extends Node

const WAIT_MSEC := 60000
const LOOPBACK_PROXY_HOST := "127.0.0.1"
const LOOPBACK_PROXY_PORT := 9
const RESULT_PATH := "user://fleet_test_result.json"
const DETERMINISM_RESULT_PATH := "user://determinism_test.json"
const OPTIMIZER_RESULT_PATH := "user://fleet_optimizer_result.json"
const OPTIMIZER_V2_RESULT_PATH := "user://fleet_optimizer_v2_result.json"
const FRIENDLY_REGRESSION_RESULT_PATH := "user://friendly_config_regression.json"
const PERFORMANCE_RESULT_PATH := "user://performance_benchmark.json"
const V22_UNIT_RESULT_PATH := "user://optimizer_v22_unit_tests.json"
const CONFIG_PATH := "res://battle_config.json"
const DAILY_CONFIG_PATH := "res://config.json"
const DAILY_COMMON_PATH := "res://common.json"
const DAILY_SETTINGS_PATH := "res://optimizer_v2_daily.json"

var blocked_http_nodes := 0
var _output_profile := {"serialization_ms": 0.0, "file_write_ms": 0.0, "files": 0, "text_format_ms": 0.0, "text_write_ms": 0.0}


func _enter_tree() -> void:
	var worker_id := _argument_value("--worker-id=")
	if worker_id != "":
		ProjectSettings.set_setting("application/config/use_custom_user_dir", true)
		ProjectSettings.set_setting("application/config/custom_user_dir_name", "Unnamed Space Idle Fleet Worker %s" % worker_id)
	DirAccess.make_dir_recursive_absolute(OS.get_user_data_dir())
	get_tree().node_added.connect(_on_node_added)


func _ready() -> void:
	call_deferred("_run")


func _on_node_added(node: Node) -> void:
	if node is HTTPRequest:
		node.set_http_proxy(LOOPBACK_PROXY_HOST, LOOPBACK_PROXY_PORT)
		node.set_https_proxy(LOOPBACK_PROXY_HOST, LOOPBACK_PROXY_PORT)
		blocked_http_nodes += 1


func _run() -> void:
	var worker_dir := _argument_value("--fleet-worker-dir=")
	var daily_optimizer := _has_argument("--daily-optimizer")
	var friendly_path := _requested_friendly_config_path()
	var run_friendly_regression := _has_argument("--friendly-regression")
	var friendly := _load_json(friendly_path) if friendly_path != "" else {}
	var common := _load_json(DAILY_COMMON_PATH) if daily_optimizer else {}
	if daily_optimizer:
		_print_daily_input(friendly, common)
	var config := {} if friendly_path != "" or run_friendly_regression else _load_config()
	var expected_galaxy := _argument_value("--optimizer-galaxy=") if worker_dir != "" else ("galaxy5" if run_friendly_regression else (
		"galaxy%d" % int(friendly.get("galaxy", 0)) if friendly_path != "" else str(config.galaxy_id)
	))
	var deadline := Time.get_ticks_msec() + WAIT_MSEC
	while Time.get_ticks_msec() < deadline:
		if (
			expected_galaxy in Fleet.galaxy_nodes
			and (worker_dir != "" or friendly_path != "" or run_friendly_regression or str(config.fleet_event_id) in Fleet.fleet_event_refs)
			and Fleet.http_save_battle_details != null
		):
			await get_tree().create_timer(0.05).timeout
			Engine.time_scale = 1.0
			get_tree().paused = false
			var probe := preload("res://fleet_test.gd").new()
			add_child(probe)
			if worker_dir != "":
				await _run_fleet_worker(probe, worker_dir)
				return
			if _has_argument("--v3-regression"):
				var tests := preload("res://fleet_optimizer_regression.gd").new()
				add_child(tests)
				var regression: Dictionary = await tests.run(probe)
				_finish(regression, 0 if regression.passed else 11, "user://optimizer_v3_regression.json")
				return
			if _has_argument("--v22-unit-regression"):
				var unit_optimizer := preload("res://fleet_optimizer_v2.gd").new()
				add_child(unit_optimizer)
				var unit_result: Dictionary = unit_optimizer.run_v22_logic_unit_tests()
				var formation_text := _build_text_summary(_formation_text_fixture())
				unit_result["formation_text"] = {
					"passed": "A      Fr   Fr   Cr   Cr    .\nB       .    .    .    .    ." in formation_text,
					"text": formation_text,
				}
				unit_result.passed = bool(unit_result.passed) and bool(unit_result.formation_text.passed)
				_finish(unit_result, 0 if bool(unit_result.passed) else 9, V22_UNIT_RESULT_PATH)
				return
			if run_friendly_regression:
				var regression_resolver := preload("res://friendly_config_resolver.gd").new()
				add_child(regression_resolver)
				var friendly_regression: Dictionary = await regression_resolver.run_regression(probe)
				_add_runtime_metadata(friendly_regression)
				_finish(friendly_regression, 0 if bool(friendly_regression.passed) else 6, FRIENDLY_REGRESSION_RESULT_PATH)
				return
			if _has_argument("--clock-regression"):
				var clock_regression := await _run_clock_regression(probe)
				var clock_mode := str(clock_regression.get("simulation_clock", {}).get("mode", "unknown"))
				_finish(clock_regression, 0 if int(clock_regression.get("errors", 0)) == 0 else 10, "user://clock_regression_%s.json" % clock_mode)
				return
			if friendly_path != "":
				var resolver := preload("res://friendly_config_resolver.gd").new()
				add_child(resolver)
				var resolver_started := Time.get_ticks_usec()
				var resolution: Dictionary = resolver.resolve(friendly, common)
				if not bool(resolution.get("ok", false)):
					if daily_optimizer:
						_print_daily_error(str(resolution.get("error", "Friendly Config validation failed")))
					_finish(resolution, 7, "user://friendly_config_error.json")
					return
				config = resolution.config
				config.resolver["resolver_ms"] = (Time.get_ticks_usec() - resolver_started) / 1000.0
				var resolved_path := "user://resolved_g%d_%s_config.json" % [int(friendly.galaxy), str(friendly.node).to_lower()]
				_write_result(resolved_path, config)
				if daily_optimizer:
					_print_daily_resolved(config)
					_write_daily_resolved_config(config)
			var optimizer_v2_settings_path := _requested_optimizer_v2_settings_path()
			if optimizer_v2_settings_path != "":
				var optimizer_v2 := preload("res://fleet_optimizer_search.gd").new()
				add_child(optimizer_v2)
				var optimizer_settings := _load_json(optimizer_v2_settings_path)
				if config.has("optimizer"):
					optimizer_settings.objective = config.optimizer.objective
					optimizer_settings.boss_priority = config.optimizer.boss_priority
					optimizer_settings.boss_remaining_hp = config.optimizer.boss_remaining_hp
					optimizer_settings.search = config.optimizer.get("search", {}).duplicate(true)
					optimizer_settings.baseline = config.optimizer.get("baseline", {}).duplicate(true)
					optimizer_settings.diagnostic = config.optimizer.get("diagnostic", {}).duplicate(true)
					optimizer_settings.player_state = {
						"fleet_resources": config.fleet_resources,
						"ships": config.ships_available.duplicate(true),
					}
				if daily_optimizer:
					_print_daily_search_budget(optimizer_settings)
				var optimizer_v2_summary: Dictionary = await optimizer_v2.optimize_v2(
					probe,
					config,
					optimizer_settings,
				)
				_add_runtime_metadata(optimizer_v2_summary)
				var regression: Dictionary = optimizer_v2_summary.get("v1_regression", {"enabled": false})
				var optimizer_v2_ok: bool = (
					int(optimizer_v2_summary.errors) == 0
					and bool(optimizer_v2_summary.cache_validation.all_identical)
					and bool(optimizer_v2_summary.cache_validation.used_cache_only)
					and (not bool(regression.enabled) or bool(regression.passed))
					and bool(optimizer_v2_summary.boss_ranking_unit_test.passed)
				)
				if daily_optimizer:
					if optimizer_v2_ok:
						var daily_result_path := _write_daily_optimizer_result(optimizer_v2_summary, config)
						_print_daily_finished(optimizer_v2_summary, daily_result_path)
					else:
						var failure_message := str(optimizer_v2_summary.get(
							"baseline_warning",
							optimizer_v2_summary.get("result_claim", "Optimizer validation failed"),
						))
						_print_daily_error(failure_message + "; existing daily results were not changed")
				_finish(optimizer_v2_summary, 0 if optimizer_v2_ok else 5, OPTIMIZER_V2_RESULT_PATH)
				return
			if friendly_path != "":
				_add_runtime_metadata(config)
				_finish(config, 0, "user://resolved_g%d_%s_config.json" % [int(friendly.galaxy), str(friendly.node).to_lower()])
				return
			var optimizer_objective := _requested_optimizer_objective()
			if optimizer_objective != "":
				var optimizer := preload("res://fleet_optimizer.gd").new()
				add_child(optimizer)
				var summary: Dictionary = await optimizer.optimize(
					probe,
					config,
					optimizer_objective,
					_requested_top_n(),
				)
				_add_runtime_metadata(summary)
				var optimizer_ok: bool = (
					int(summary.errors) == 0
					and bool(summary.replay_validation.all_identical)
				)
				_finish(summary, 0 if optimizer_ok else 4, OPTIMIZER_RESULT_PATH)
				return
			var performance_runs := _requested_performance_runs()
			if performance_runs > 0:
				var benchmark := await _run_performance_benchmark(probe, config, performance_runs)
				_add_runtime_metadata(benchmark)
				_finish(benchmark, 0 if bool(benchmark.get("core_results_identical", false)) else 8, PERFORMANCE_RESULT_PATH)
				return
			var run_count := _requested_run_count()
			if run_count == 1:
				var result: Dictionary = await probe.run_battle(config)
				_add_runtime_metadata(result)
				_finish(result, 1 if result.has("error") else 0, RESULT_PATH)
				return

			var results: Array[Dictionary] = []
			for run_index in range(run_count):
				var result: Dictionary = await probe.run_battle(config)
				results.append(result)
				print("DETERMINISM_RUN=%d/%d" % [run_index + 1, run_count])
				await probe.cleanup_battle()
			var summary := _build_determinism_summary(config, results)
			_add_runtime_metadata(summary)
			_write_result(RESULT_PATH, results[0])
			_finish(
				summary,
				0 if summary["all_identical"] else 3,
				DETERMINISM_RESULT_PATH,
			)
			return
		await get_tree().create_timer(0.05).timeout

	_finish({
		"error": "Timed out waiting for Fleet Galaxy initialization",
		"user_data_dir": OS.get_user_data_dir(),
		"http_nodes_proxied": blocked_http_nodes,
	}, 2, RESULT_PATH)


func _requested_run_count() -> int:
	const PREFIX := "--determinism-runs="
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with(PREFIX):
			return maxi(1, argument.substr(PREFIX.length()).to_int())
	return 1


func _requested_performance_runs() -> int:
	const PREFIX := "--performance-runs="
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with(PREFIX):
			return maxi(2, argument.substr(PREFIX.length()).to_int())
	return 0


func _run_clock_regression(probe: Node) -> Dictionary:
	var cases := [
		{"label": "g1_b1", "config": _load_json("res://ui_ab_test_01_config.json")},
		{"label": "g5_b30_hazard", "config": _load_json("res://ui_ab_test_02_config.json")},
		{"label": "g5_bb3_boss_hazard", "config": _load_json("res://ui_ab_test_03_config.json")},
	]
	var resolver := preload("res://friendly_config_resolver.gd").new()
	add_child(resolver)
	var support_resolution: Dictionary = resolver.resolve({
		"galaxy": 6,
		"node": "B8",
		"boss": {"alive": false, "remaining_hp": 0},
		"hazards": ["B10"],
		"supports": ["F2"],
		"search": {"profile": "fast", "simulation_clock": _argument_value("--simulation-clock=")},
		"player_state": {
			"fleet_resources": 2627.3,
			"damage_scale": 1.0,
			"health_scale": 1.0,
			"ships": {"Fighter": 1, "Corvette": 1, "Frigate": 1, "Cruiser": 1},
		},
	})
	assert(bool(support_resolution.get("ok", false)), str(support_resolution.get("error", "Support regression resolution failed")))
	var support_config: Dictionary = support_resolution.config
	for column in range(5):
		support_config.formation.append({
			"ship": "Cruiser",
			"grid_position": [0, column],
			"primary_mod": null,
			"secondary_mod": "CruiserSingleArmorTank",
			"tertiary_mods": [],
		})
	cases.append({"label": "g6_b8_hazard_support", "config": support_config})
	resolver.queue_free()

	var results: Array = []
	var errors := 0
	var clock := {}
	for case in cases:
		var config: Dictionary = case.config.duplicate(true)
		config["simulation_clock"] = _argument_value("--simulation-clock=")
		config["simulation_detail"] = "full"
		var result: Dictionary = await probe.run_battle(config)
		var core := _canonical_result(result)
		if result.has("error"):
			errors += 1
		if clock.is_empty():
			clock = result.get("simulation_clock", {}).duplicate(true)
		results.append({
			"label": case.label,
			"canonical_sha256": JSON.stringify(core).sha256_text(),
			"core": core,
			"simulation_clock": result.get("simulation_clock", {}),
			"simulation_time": result.get("simulation_time"),
			"runtime_effect_events": result.get("runtime_effect_events", []),
			"result": result,
		})
		print("CLOCK_REGRESSION=%s mode=%s sim=%.3f wall=%.3f" % [
			case.label,
			result.get("simulation_clock", {}).get("mode", "unknown"),
			float(result.get("simulation_time", 0.0)),
			float(result.get("simulation_clock", {}).get("wall_seconds", 0.0)),
		])
		await probe.cleanup_battle()
	return {
		"simulation_clock": clock,
		"errors": errors,
		"comparison_fields": [
			"formation", "outcome", "fleet_resources_committed", "fleet_resources_used",
			"player_ships", "enemy_ships", "boss_damage", "raw_battle_log ordering",
			"runtime_effect_events",
		],
		"cases": results,
	}


func _run_performance_benchmark(probe: Node, config: Dictionary, runs: int) -> Dictionary:
	var samples: Array = []
	var canonical = null
	var identical := true
	for index in range(runs):
		var run_config := config.duplicate(true)
		run_config.simulation_detail = "full" if index < runs / 2 else "minimal"
		var started := Time.get_ticks_usec()
		var result: Dictionary = await probe.run_battle(run_config)
		var cleanup: Dictionary = await probe.cleanup_battle()
		var wall_ms := (Time.get_ticks_usec() - started) / 1000.0
		var core := _canonical_core_result(result)
		if canonical == null:
			canonical = core
		else:
			identical = identical and JSON.stringify(core) == JSON.stringify(canonical)
		samples.append({
			"run": index + 1,
			"detail": run_config.simulation_detail,
			"wall_ms": wall_ms,
			"cleanup_ms": cleanup.get("cleanup_ms", 0.0),
			"performance_breakdown": result.get("performance_breakdown", {}),
			"simulation_clock": result.get("simulation_clock", {}),
			"core_sha256": JSON.stringify(core).sha256_text(),
		})
		print("PERFORMANCE_RUN=%d/%d detail=%s wall_ms=%.1f" % [index + 1, runs, run_config.simulation_detail, wall_ms])
	return {
		"runs": runs,
		"simulation_clock": samples[0].get("simulation_clock", {}) if not samples.is_empty() else {},
		"core_results_identical": identical,
		"full": _performance_group(samples, "full"),
		"minimal": _performance_group(samples, "minimal"),
		"samples": samples,
	}


func _canonical_core_result(result: Dictionary) -> Dictionary:
	return {
		"outcome": result.get("outcome"),
		"fleet_resources_committed": result.get("fleet_resources_committed"),
		"fleet_resources_used": result.get("fleet_resources_used"),
		"boss_damage": result.get("boss_damage"),
		"player_ships": result.get("player_ships", []),
		"enemy_ships": result.get("enemy_ships", []),
		"runtime_effect_events": result.get("runtime_effect_events", []),
	}


func _performance_group(samples: Array, detail: String) -> Dictionary:
	var values: Array[float] = []
	var battle_values: Array[float] = []
	var simulated_values: Array[float] = []
	var speedups: Array[float] = []
	for sample in samples:
		if sample.detail == detail:
			values.append(float(sample.wall_ms))
			battle_values.append(float(sample.performance_breakdown.get("battle_wall_ms", 0.0)))
			simulated_values.append(float(sample.simulation_clock.get("simulated_seconds", 0.0)))
			speedups.append(float(sample.simulation_clock.get("wall_speedup", 0.0)))
	values.sort()
	battle_values.sort()
	simulated_values.sort()
	speedups.sort()
	var total := 0.0
	for value in values:
		total += value
	return {
		"count": values.size(),
		"average_wall_ms": total / maxf(1.0, float(values.size())),
		"median_wall_ms": _median(values),
		"median_battle_wall_ms": _median(battle_values),
		"median_simulated_seconds": _median(simulated_values),
		"median_wall_speedup": _median(speedups),
	}


func _median(values: Array[float]) -> float:
	if values.is_empty():
		return 0.0
	var middle := values.size() / 2
	return values[middle] if values.size() % 2 == 1 else (values[middle - 1] + values[middle]) / 2.0


func _requested_optimizer_objective() -> String:
	const PREFIX := "--optimize="
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with(PREFIX):
			var value := argument.substr(PREFIX.length())
			assert(value in ["normal", "boss"], "Optimizer objective must be normal or boss")
			return value
	return ""


func _requested_optimizer_v2_settings_path() -> String:
	const PREFIX := "--optimizer-v2="
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with(PREFIX):
			return argument.substr(PREFIX.length())
	if _has_argument("--daily-optimizer"):
		return DAILY_SETTINGS_PATH
	return ""


func _requested_friendly_config_path() -> String:
	const PREFIX := "--friendly-config="
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with(PREFIX):
			return argument.substr(PREFIX.length())
	if _has_argument("--daily-optimizer"):
		return DAILY_CONFIG_PATH
	return ""


func _requested_daily_output_dir() -> String:
	const PREFIX := "--daily-output-dir="
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with(PREFIX):
			return argument.substr(PREFIX.length())
	return ProjectSettings.globalize_path("res://../../results")


func _requested_node_result_path() -> String:
	return _argument_value("--node-result=")


func _has_argument(expected: String) -> bool:
	return expected in OS.get_cmdline_user_args()


func _argument_value(prefix: String) -> String:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with(prefix):
			return argument.substr(prefix.length())
	return ""


func _run_fleet_worker(probe: Node, worker_dir: String) -> void:
	DirAccess.make_dir_recursive_absolute(worker_dir)
	_write_worker_message(worker_dir.path_join("ready.json"), {
		"pid": OS.get_process_id(),
		"user_data_dir": OS.get_user_data_dir(),
		"startup_ms": Time.get_ticks_msec(),
	})
	while not FileAccess.file_exists(worker_dir.path_join("stop")):
		var request_path := worker_dir.path_join("request.json")
		if not FileAccess.file_exists(request_path):
			OS.delay_msec(5)
			await get_tree().process_frame
			continue
		var request := _load_json(request_path)
		DirAccess.remove_absolute(request_path)
		var results: Array = []
		for item in request.get("items", []):
			var result: Dictionary = await probe.run_battle(item.config)
			var cleanup: Dictionary = await probe.cleanup_battle()
			if not result.has("performance_breakdown"):
				result["performance_breakdown"] = {}
			result.performance_breakdown["cleanup_ms"] = cleanup.get("cleanup_ms", 0.0)
			results.append({"index": item.index, "result": result})
		_write_worker_message(worker_dir.path_join("response_%s.json" % request.id), {"results": results})
	probe.queue_free()
	if get_tree().current_scene != null:
		get_tree().current_scene.queue_free()
	await get_tree().process_frame
	await get_tree().process_frame
	get_tree().quit(0)


func _write_worker_message(path: String, value: Dictionary) -> void:
	var temporary_path := path + ".tmp"
	var file := FileAccess.open(temporary_path, FileAccess.WRITE)
	assert(file != null, "Unable to write worker message %s" % path)
	file.store_string(JSON.stringify(value, "", true, true))
	file.close()
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(path)
	assert(DirAccess.rename_absolute(temporary_path, path) == OK, "Unable to publish worker message %s" % path)


func _requested_top_n() -> int:
	const PREFIX := "--top-n="
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with(PREFIX):
			return maxi(1, argument.substr(PREFIX.length()).to_int())
	return 10


func _add_runtime_metadata(result: Dictionary) -> void:
	result["engine_version"] = Engine.get_version_info().string
	result["physics_ticks_per_second"] = Engine.physics_ticks_per_second
	result["engine_time_scale"] = Engine.time_scale
	result["scene_tree_paused"] = get_tree().paused
	result["user_data_dir"] = OS.get_user_data_dir()
	result["http_nodes_proxied"] = blocked_http_nodes
	result["network_protection"] = "HTTP/HTTPS proxied to 127.0.0.1:9; Steam singleton unavailable"


func _canonical_result(result: Dictionary) -> Dictionary:
	var battle_log: Array[Dictionary] = []
	for item in result.get("raw_battle_log", []):
		var event: Dictionary = item.duplicate(true)
		event.erase("time")
		battle_log.append(event)
	return {
		"outcome": result.get("outcome"),
		"fleet_resources_used": result.get("fleet_resources_used"),
		"boss_damage": result.get("boss_damage"),
		"player_ships": result.get("player_ships", []),
		"enemy_ships": result.get("enemy_ships", []),
		"runtime_effect_events": result.get("runtime_effect_events", []),
		"raw_battle_log": battle_log,
		"copy_battle_log_text": result.get("copy_battle_log_text", ""),
	}


func _different_fields(baseline: Dictionary, candidate: Dictionary) -> Array[String]:
	var differences: Array[String] = []
	for field in baseline:
		if JSON.stringify(baseline[field]) != JSON.stringify(candidate.get(field)):
			differences.append(field)
	return differences


func _build_determinism_summary(config: Dictionary, results: Array[Dictionary]) -> Dictionary:
	var baseline := _canonical_result(results[0])
	var runs: Array[Dictionary] = []
	var identical_count := 0
	var error_count := 0
	for run_index in range(results.size()):
		var result := results[run_index]
		var canonical := _canonical_result(result)
		var differences := _different_fields(baseline, canonical)
		var identical := differences.is_empty() and not result.has("error")
		if identical:
			identical_count += 1
		if result.has("error"):
			error_count += 1
		runs.append({
			"run": run_index + 1,
			"identical": identical,
			"different_fields": differences,
			"canonical_sha256": JSON.stringify(canonical).sha256_text(),
			"error": result.get("error", ""),
		})
	return {
		"config": config,
		"runs_requested": results.size(),
		"runs_completed": results.size(),
		"identical_count": identical_count,
		"error_count": error_count,
		"all_identical": identical_count == results.size() and error_count == 0,
		"comparison_ignored_fields": [
			"simulation_time",
			"raw_battle_log[].time",
		],
		"baseline": baseline,
		"runs": runs,
	}


func _load_config() -> Dictionary:
	var requested := _argument_value("--battle-config=")
	return _load_json(CONFIG_PATH if requested == "" else requested)


func _load_json(path: String) -> Dictionary:
	var file := FileAccess.open(path, FileAccess.READ)
	assert(file != null, "Unable to open %s" % path)
	var parsed = JSON.parse_string(file.get_as_text())
	file.close()
	assert(parsed is Dictionary, "%s must contain a JSON object" % path)
	return parsed


func _write_result(path: String, result: Dictionary) -> String:
	var started := Time.get_ticks_usec()
	var json := JSON.stringify(result, "  ", true, true)
	_output_profile.serialization_ms += (Time.get_ticks_usec() - started) / 1000.0
	started = Time.get_ticks_usec()
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file != null:
		file.store_string(json)
		file.close()
	_output_profile.file_write_ms += (Time.get_ticks_usec() - started) / 1000.0
	_output_profile.files += 1
	return json


func _print_daily_input(friendly: Dictionary, common: Dictionary) -> void:
	var boss: Dictionary = friendly.get("boss", {}) if friendly.get("boss", {}) is Dictionary else {}
	var player: Dictionary = friendly.get("player_state", {}) if friendly.get("player_state", {}) is Dictionary else {}
	var ships: Dictionary = player.get("ships", {}) if player.get("ships", {}) is Dictionary else {}
	var hazards: Array = friendly.get("hazards", []) if friendly.get("hazards", []) is Array else []
	var supports: Array = friendly.get("supports", []) if friendly.get("supports", []) is Array else []
	print("========================================")
	print("Unnamed Space Idle Fleet Optimizer")
	print("========================================")
	print("Galaxy: %s" % (int(friendly.galaxy) if friendly.has("galaxy") else "missing"))
	print("Node: %s" % friendly.get("node", "missing"))
	print("")
	print("Boss:")
	print("  Alive: %s" % boss.get("alive", "missing"))
	print("  Remaining HP: %s" % boss.get("remaining_hp", "missing"))
	print("  Priority: %s" % boss.get("priority", "missing"))
	print("")
	print("Hazards:")
	print("  %s" % ("none" if hazards.is_empty() else ", ".join(hazards)))
	print("")
	print("Supports:")
	print("  %s" % ("none" if supports.is_empty() else ", ".join(supports)))
	print("")
	print("Player:")
	print("  Fleet Resources: %s" % player.get("fleet_resources", "missing"))
	print("  Permanent Scales: %s" % common.get("permanent", "missing"))
	print("  Temporary Scales: %s" % common.get("temporary", "missing"))
	print("")
	print("Ships Available:")
	for ship_type in ["Fighter", "Corvette", "Frigate", "Cruiser"]:
		print("  %s: %d" % [ship_type, int(ships.get(ship_type, 0))])


func _print_daily_resolved(config: Dictionary) -> void:
	var enemies: Array[String] = []
	for enemy in config.get("enemy_fleet", []):
		var grid: Array = Array(enemy.get("grid_position", []))
		var position := "?"
		if grid.size() >= 2:
			var rows := ["A", "B"]
			var row_index := int(grid[0])
			position = "%s%d" % [rows[row_index] if row_index >= 0 and row_index < rows.size() else "?", int(grid[1]) + 1]
		enemies.append("%s@%s" % [enemy.get("ship", "unknown"), position])
	var boss: Dictionary = config.resolver.boss
	print("")
	print("Resolved Battle:")
	print("  Fleet Event: %s" % config.fleet_event_id)
	print("  Battle ID: %s" % config.battle_id)
	print("  Enemy Fleet: %s" % ("none" if enemies.is_empty() else ", ".join(enemies)))
	print("  Boss: %s" % ("none" if not bool(boss.alive) else "%s (%s), HP %s / %s" % [boss.command_ship_name, boss.command_ship_id, boss.remaining_hp, boss.max_hp]))
	print("  Hazards: %s" % ("none" if config.hazards.is_empty() else ", ".join(config.hazards)))
	print("  Supports: %s" % ("none" if config.supports.is_empty() else ", ".join(config.supports)))
	print("  Scales: %s" % config.get("scales", {}))
	print("  Simulation Clock: %s" % config.get("simulation_clock", "realtime"))


func _print_daily_search_budget(settings: Dictionary) -> void:
	var search: Dictionary = settings.get("search", {}) if settings.get("search", {}) is Dictionary else {}
	var max_simulations = search.get("max_simulations", settings.get("max_simulations", "missing"))
	var max_wall_seconds = search.get("max_wall_seconds", settings.get("max_wall_seconds", "missing"))
	print("")
	print("Search Budget:")
	print("  Estimated Candidates: up to %s scored simulations; exact fleet candidate count follows after original deployment-cost pruning" % max_simulations)
	print("  Max Simulations: %s" % max_simulations)
	print("  Max Wall Time: %s seconds" % max_wall_seconds)
	print("")


func _write_daily_resolved_config(config: Dictionary) -> void:
	var output_dir := _requested_daily_output_dir()
	DirAccess.make_dir_recursive_absolute(output_dir)
	var path := output_dir.path_join("resolved_g%s_%s_config.json" % [
		str(int(config.resolver.friendly_input.galaxy)),
		str(config.resolver.node).to_lower(),
	])
	_write_result(path, config)


func _write_daily_optimizer_result(summary: Dictionary, config: Dictionary) -> String:
	var output_dir := _requested_daily_output_dir()
	DirAccess.make_dir_recursive_absolute(output_dir)
	var now := Time.get_datetime_dict_from_system()
	var timestamp := "%04d%02d%02d_%02d%02d%02d" % [now.year, now.month, now.day, now.hour, now.minute, now.second]
	var base_name := "g%s_%s_%s" % [
		str(int(config.resolver.friendly_input.galaxy)),
		str(config.resolver.node).to_lower(),
		timestamp,
	]
	var result_path := output_dir.path_join(base_name + ".json")
	var suffix := 2
	while FileAccess.file_exists(result_path):
		result_path = output_dir.path_join("%s_%d.json" % [base_name, suffix])
		suffix += 1
	var latest_path := output_dir.path_join("latest.json")
	var compact_path := output_dir.path_join("latest_summary.json")
	var text_path := output_dir.path_join("latest.txt")
	var node_result_path := _requested_node_result_path()
	var node_text_path := node_result_path.trim_suffix(".json") + ".txt" if node_result_path != "" else ""
	summary["scales"] = config.get("scales", {}).duplicate(true)
	summary["daily_result_path"] = result_path
	summary["latest_result_path"] = latest_path
	summary["latest_summary_path"] = compact_path
	summary["latest_text_path"] = text_path
	summary["node_result_path"] = node_result_path
	summary["node_text_path"] = node_text_path
	var serialization_started := Time.get_ticks_usec()
	JSON.stringify(summary, "  ")
	if not summary.has("performance_breakdown"):
		summary["performance_breakdown"] = {}
	summary.performance_breakdown["resolver_ms"] = float(config.get("resolver", {}).get("resolver_ms", 0.0))
	summary.performance_breakdown["json_serialization_ms"] = (Time.get_ticks_usec() - serialization_started) / 1000.0
	_write_result(result_path, summary)
	_write_result(latest_path, summary)
	var compact := _build_compact_summary(summary, config)
	_write_result(compact_path, compact)
	var format_started := Time.get_ticks_usec()
	var readable_summary := _build_text_summary(compact)
	_output_profile.text_format_ms += (Time.get_ticks_usec() - format_started) / 1000.0
	_write_text(text_path, readable_summary)
	if node_result_path != "":
		DirAccess.make_dir_recursive_absolute(node_result_path.get_base_dir())
		var node_result := summary.duplicate(true)
		if str(summary.get("objective", "normal")) == "normal":
			for candidate_list in ["top", "refined_finalists", "ranked_candidates"]:
				node_result.erase(candidate_list)
		_write_result(node_result_path, node_result)
		_write_text(node_text_path, readable_summary)
		_write_result(output_dir.path_join("output_performance.json"), _output_profile.duplicate())
		return node_result_path
	_write_result(output_dir.path_join("output_performance.json"), _output_profile.duplicate())
	return result_path


func _build_compact_summary(summary: Dictionary, config: Dictionary) -> Dictionary:
	var best: Dictionary = summary.get("best_result", {})
	var baseline: Dictionary = summary.get("verified_baseline", {})
	var friendly: Dictionary = config.get("resolver", {}).get("friendly_input", {})
	return {
		"status": summary.get("recommendation_status", summary.get("result_claim", "SEARCHED BEST")),
		"galaxy": friendly.get("galaxy"),
		"node": friendly.get("node"),
		"objective": summary.get("objective"),
		"priority": summary.get("boss_priority"),
		"search": {
			"profile": summary.get("search_profile"),
			"wall_seconds": summary.get("wall_time_seconds"),
			"simulations": summary.get("simulations_used"),
			"hard_pruned": _sum_numeric(summary.get("pruning_stats", {}).get("hard_pruned", {})),
			"smart_pruned": _sum_numeric(summary.get("pruning_stats", {}).get("smart_pruned", {})),
			"workers_requested": summary.get("workers_requested"),
			"workers_effective": summary.get("workers_effective"),
			"finalization": summary.get("finalization_status"),
		},
		"simulation_clock": summary.get("simulation_clock", {}),
		"scales": config.get("scales", {}),
		"active_hazards": config.get("resolver", {}).get("hazard_details", []),
		"active_supports": config.get("resolver", {}).get("support_details", []),
		"enemy_summary": {
			"enemy_count": summary.get("battle_analysis", {}).get("enemy_count"),
			"shield_enemies": summary.get("battle_analysis", {}).get("shield_enemies"),
			"armor_enemies": summary.get("battle_analysis", {}).get("armor_enemies"),
			"boss": summary.get("battle_analysis", {}).get("boss"),
			"reinforcement": summary.get("battle_analysis", {}).get("reinforcement"),
			"hazards": summary.get("battle_analysis", {}).get("active_hazard_types", []),
		},
		"baseline": _compact_candidate(baseline),
		"best": _compact_candidate(best),
		"improvement_vs_baseline": summary.get("improvement_vs_baseline", {}),
		"notes": [
			"SEARCHED BEST",
			"Interleaved exploration; unvisited candidates are not proven inferior",
			str(summary.get("search_termination", "")),
			"Not mathematically global exact" if summary.get("search_profile") != "exhaustive" else "Exact only where an exact subspace is explicitly reported",
		],
	}


func _compact_candidate(candidate: Dictionary) -> Dictionary:
	if candidate.is_empty():
		return {}
	var formation := {}
	for group in candidate.get("formation", []):
		formation[str(group.get("position", _position_name(Array(group.get("grid_position", [0, 0])))))] = group.get("ship")
	return {
		"composition": candidate.get("composition_counts", {}),
		"loadouts": candidate.get("ship_loadouts", {}),
		"formation": formation,
		"outcome": candidate.get("outcome"),
		"committed_fr": candidate.get("fleet_resources_committed"),
		"used_fr": candidate.get("fleet_resources_used"),
		"boss_damage": candidate.get("boss_damage"),
		"damage_per_fr": candidate.get("boss_damage_per_fr"),
		"refined_battles_to_kill": candidate.get("refined_battles_to_kill"),
		"refined_total_kill_fr": candidate.get("refined_total_kill_fr"),
		"killable_with_current_fr": candidate.get("killable_with_current_fr"),
		"remaining_fr_after_kill": candidate.get("remaining_fr_after_kill"),
		"kill_sequence": candidate.get("kill_sequence", []),
	}


func _build_text_summary(compact: Dictionary) -> String:
	var lines: Array[String] = []
	lines.append("Galaxy %s / %s" % [compact.get("galaxy", "?"), compact.get("node", "?")])
	lines.append("Status: %s" % compact.get("status", "SEARCHED BEST"))
	lines.append("Objective: %s / %s" % [compact.get("objective", "?"), compact.get("priority", "n/a")])
	lines.append("Search Time: %.1fs" % float(compact.search.get("wall_seconds", 0.0)))
	lines.append("Simulations: %s" % compact.search.get("simulations", 0))
	var clock: Dictionary = compact.get("simulation_clock", {})
	lines.append("")
	lines.append("Simulation:")
	lines.append("  Clock: %s" % str(clock.get("mode", "unknown")).replace("_", " ").capitalize())
	lines.append("  Physics: %s Hz" % clock.get("physics_hz", 60))
	lines.append("  Simulated Time: %.3fs" % float(clock.get("simulated_seconds", 0.0)))
	lines.append("  Wall Time: %.3fs" % float(clock.get("wall_seconds", 0.0)))
	lines.append("  Speedup: %.2fx" % float(clock.get("wall_speedup", 0.0)))
	if str(clock.get("fallback_warning", "")) != "":
		lines.append("  Warning: %s" % clock.fallback_warning)
	lines.append("")
	lines.append("Active Hazards:")
	if compact.get("active_hazards", []).is_empty():
		lines.append("  none")
	else:
		for detail in compact.active_hazards:
			lines.append("  %s" % _effect_detail_text(detail))
	lines.append("")
	lines.append("Active Supports:")
	if compact.get("active_supports", []).is_empty():
		lines.append("  none")
	else:
		for detail in compact.active_supports:
			lines.append("  %s" % _effect_detail_text(detail))
	lines.append("")
	lines.append("Enemy Summary:")
	lines.append("  Count: %s; Shield: %s; Armor: %s; Boss: %s; Reinforcement: %s" % [
		compact.enemy_summary.get("enemy_count", 0), compact.enemy_summary.get("shield_enemies", 0),
		compact.enemy_summary.get("armor_enemies", 0), compact.enemy_summary.get("boss", false),
		compact.enemy_summary.get("reinforcement", false),
	])
	var best: Dictionary = compact.get("best", {})
	if best.is_empty():
		lines.append("")
		lines.append("No valid candidate completed.")
		return "\n".join(lines) + "\n"
	lines.append("")
	lines.append("Recommended Fleet:")
	lines.append("  Outcome: %s" % str(best.get("outcome", "unknown")).capitalize())
	for ship_type in ["Fighter", "Corvette", "Frigate", "Cruiser"]:
		var count := int(best.get("composition", {}).get(ship_type, 0))
		if count > 0:
			lines.append("  %s x%d" % [ship_type, count])
	lines.append("")
	lines.append("Mods:")
	for ship_type in best.get("loadouts", {}):
		var loadout: Dictionary = best.loadouts[ship_type]
		lines.append("  %s: Primary=%s; Secondary=%s" % [
			ship_type, _mod_text(loadout.get("primary")), _mod_text(loadout.get("secondary")),
		])
	lines.append("")
	lines.append("Formation:")
	lines.append("        1    2    3    4    5")
	for row in ["A", "B"]:
		var cells: Array[String] = []
		for column in range(1, 6):
			var ship_type := str(best.get("formation", {}).get("%s%d" % [row, column], ""))
			cells.append(_ship_abbreviation(ship_type))
		lines.append("%s    %4s %4s %4s %4s %4s" % [row, cells[0], cells[1], cells[2], cells[3], cells[4]])
	lines.append("  Fi=Fighter  Co=Corvette  Fr=Frigate  Cr=Cruiser")
	lines.append("")
	lines.append("FR: Committed/Battle=%s; Used/Battle=%s" % [best.get("committed_fr", "n/a"), best.get("used_fr", "n/a")])
	if compact.get("objective") == "boss":
		lines.append("Boss: Damage/Battle=%s; Damage/FR=%s" % [best.get("boss_damage", "n/a"), best.get("damage_per_fr", "n/a")])
		lines.append("Kill: Battles=%s; Total FR=%s; Remaining FR=%s" % [best.get("refined_battles_to_kill", "n/a"), best.get("refined_total_kill_fr", "n/a"), best.get("remaining_fr_after_kill", "n/a")])
		for battle in best.get("kill_sequence", []):
			lines.append("  Battle %s: HP %s -> %s; Damage=%s; Committed=%s; Used=%s; FR left=%s" % [battle.battle, battle.boss_hp_before, battle.boss_hp_after, battle.boss_damage, battle.committed_fr, battle.used_fr, battle.fr_remaining])
	lines.append("")
	lines.append("Search Notes:")
	for note in compact.get("notes", []):
		lines.append("  %s" % note)
	return "\n".join(lines) + "\n"


func _effect_detail_text(detail: Dictionary) -> String:
	var types: Array = detail.get("type", [])
	if types.is_empty():
		for definition in detail.get("definition", []):
			var effect_type := str(definition.get("type", "unknown"))
			if effect_type not in types:
				types.append(effect_type)
	return "%s - %s (%s)" % [
		detail.get("node", "?"),
		", ".join(types) if not types.is_empty() else "unknown",
		detail.get("fleet_event_id", "unknown"),
	]


func _ship_abbreviation(ship_type: String) -> String:
	return {"Fighter": "Fi", "Corvette": "Co", "Frigate": "Fr", "Cruiser": "Cr"}.get(ship_type, ".")


func _mod_text(value) -> String:
	return "none" if value == null or str(value) == "" else str(value)


func _formation_text_fixture() -> Dictionary:
	return {
		"galaxy": 5, "node": "B35", "status": "SEARCHED BEST", "objective": "boss", "priority": "efficiency",
		"search": {"wall_seconds": 1.0, "simulations": 1},
		"simulation_clock": {"mode": "offline_fixed_step", "physics_hz": 60, "simulated_seconds": 1.0, "wall_seconds": 0.2, "wall_speedup": 5.0},
		"active_hazards": [], "active_supports": [],
		"enemy_summary": {}, "notes": [],
		"best": {
			"composition": {"Frigate": 2, "Cruiser": 2}, "loadouts": {},
			"formation": {"A1": "Frigate", "A2": "Frigate", "A3": "Cruiser", "A4": "Cruiser"},
			"committed_fr": 1, "used_fr": 1, "boss_damage": 1, "damage_per_fr": 1,
		},
	}


func _position_name(position: Array) -> String:
	return "AB".substr(int(position[0]), 1) + str(int(position[1]) + 1)


func _sum_numeric(values: Dictionary) -> int:
	var total := 0
	for value in values.values():
		total += int(value)
	return total


func _write_text(path: String, value: String) -> void:
	var started := Time.get_ticks_usec()
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file != null:
		file.store_string(value)
		file.close()
	_output_profile.text_write_ms += (Time.get_ticks_usec() - started) / 1000.0


func _print_daily_finished(summary: Dictionary, result_path: String) -> void:
	var best: Dictionary = summary.get("best_result", {})
	print("")
	print("========================================")
	print("Optimizer Finished")
	print("========================================")
	print("Result: %s" % summary.get("result_claim", "SEARCHED BEST"))
	if best.is_empty():
		print("Outcome: no valid candidate")
	else:
		print("Outcome: %s" % best.get("outcome", "unknown"))
		print("Composition:")
		for ship_type in best.get("composition", {}):
			var deployment: Dictionary = best.composition[ship_type]
			print("  %s: %s deployed (%s overdeployed)" % [ship_type, deployment.get("deployed", 0), deployment.get("overdeployed_groups", 0)])
		print("Loadouts:")
		for ship_type in best.get("ship_loadouts", {}):
			var loadout: Dictionary = best.ship_loadouts[ship_type]
			print("  %s: primary=%s, secondary=%s" % [ship_type, loadout.get("primary", null), loadout.get("secondary", null)])
		var formation: Array[String] = []
		for group in best.get("formation", []):
			formation.append("%s@%s" % [group.get("ship", "unknown"), group.get("position", "?")])
		print("Formation: %s" % ", ".join(formation))
		print("FR Committed: %s" % best.get("fleet_resources_committed", "n/a"))
		print("FR Used: %s" % best.get("fleet_resources_used", "n/a"))
		if str(summary.get("objective", "normal")) == "boss":
			print("Boss Damage: %s" % best.get("boss_damage_per_battle", best.get("boss_damage", "n/a")))
			print("Damage / FR: %s" % best.get("boss_damage_per_fr", "n/a"))
			print("Battles To Kill: %s" % best.get("refined_battles_to_kill", best.get("projected_battles_to_kill", "n/a")))
			print("Total Kill FR: %s" % best.get("refined_total_kill_fr", best.get("projected_kill_fr", "n/a")))
			print("Killable With Current FR: %s" % best.get("killable_with_current_fr", "n/a"))
			print("Remaining FR After Kill: %s" % best.get("remaining_fr_after_kill", "n/a"))
	print("Simulations: %s" % summary.get("simulations_used", 0))
	print("Cache Hits: %s" % summary.get("cache_hits", 0))
	print("Wall Time: %s seconds" % summary.get("wall_time_seconds", 0))
	print("Full result: %s" % result_path)
	if str(summary.get("node_text_path", "")) != "":
		print("Readable result: %s" % summary.node_text_path)
	print("========================================")


func _print_daily_error(message: String) -> void:
	print("")
	print("========================================")
	print("ERROR: %s" % message)
	print("========================================")


func _finish(result: Dictionary, exit_code: int, result_path: String) -> void:
	var json := _write_result(result_path, result)
	if _has_argument("--verbose") or not _has_argument("--daily-optimizer"):
		print("FLEET_TEST_RESULT=", json)
	call_deferred("_quit_after_cleanup", exit_code)


func _quit_after_cleanup(exit_code: int) -> void:
	for child in get_children():
		child.queue_free()
	if get_tree().current_scene != null:
		get_tree().current_scene.queue_free()
	await get_tree().process_frame
	await get_tree().process_frame
	await get_tree().process_frame
	get_tree().quit(exit_code)
