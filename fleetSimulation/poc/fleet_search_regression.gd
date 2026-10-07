extends Node
## Small deterministic search checks. No battle, network, or saved-game writes.
var checks: Array = []


class FlakyIpc extends "res://fleet_worker_ipc.gd":
	var read_failures := 0
	var publish_failures := 0
	var reads := 0
	var publishes := 0

	func _open_read(path: String) -> FileAccess:
		reads += 1
		if reads <= read_failures:
			return null
		return super._open_read(path)

	func _publish(source: String, destination: String) -> int:
		publishes += 1
		if publishes <= publish_failures:
			return ERR_FILE_CANT_WRITE
		return super._publish(source, destination)


func check(label: String, passed: bool) -> void:
	checks.append({"label": label, "passed": passed})
	print("SEARCH_REGRESSION %s %s" % [label, "PASS" if passed else "FAIL"])


func run(friendly: Dictionary, common: Dictionary, settings: Dictionary) -> Dictionary:
	var resolver := preload("res://friendly_config_resolver.gd").new()
	add_child(resolver)
	var resolved := resolver.resolve(friendly, common, settings.get("allowed_mod_slots", {}))
	check("fixture resolves", resolved.ok)
	if not resolved.ok:
		return {"passed": false, "checks": checks, "error": resolved}
	var optimizer := preload("res://fleet_optimizer_search.gd").new()
	add_child(optimizer)
	optimizer._base_config = resolved.config
	optimizer._settings = settings.duplicate(true)
	optimizer._normalize_settings()
	optimizer._rng.seed = 42
	# Three distinct groups: 5*4*3, 10*9*8 and 15*14*13 layouts.
	var seed_formation: Array = []
	for ship in ["Fighter", "Cruiser", "HeavyCruiser"]:
		seed_formation.append(optimizer._formation_group(ship, optimizer._settings.allowed_loadouts[ship][0], [0, seed_formation.size()]))
	for columns in [1, 2, 3]:
		optimizer._configure_grid([columns, 5])
		optimizer._advisor_streams.clear()
		optimizer._add_layout_stream(seed_formation, optimizer._advisor_streams)
		var count: int = columns * 5 * (columns * 5 - 1) * (columns * 5 - 2)
		var seen := {}
		var valid := true
		for i in range(count):
			var formation: Array = optimizer._next_layout(true)
			valid = valid and optimizer._has_unique_positions(formation)
			seen[optimizer._formation_key(formation)] = true
		check("%d-column sweep covers each layout once" % columns, valid and seen.size() == count and optimizer._advisor_streams[0].remaining == 0)
		optimizer._add_layout_stream(optimizer._random_layout(seed_formation), optimizer._advisor_streams)
		check("%d-column reposition does not restart completed fleet" % columns, optimizer._advisor_streams.size() == 1 and optimizer._advisor_streams[0].remaining == 0)
	optimizer._configure_grid([2, 5])
	var parent := {"formation": seed_formation, "formation_key": optimizer._formation_key(seed_formation)}
	optimizer._prepare_layout_neighborhood(parent)
	check("reduced fleets survive without a winning initial layout", optimizer._layout_streams.size() == 4)
	optimizer._mutation_streams[parent.formation_key] = {"cursor": 0, "buckets": [[], [], [], [seed_formation], [], []]}
	check("empty bucket does not skip remaining mutations", optimizer._next_mutation(parent) == seed_formation)
	var joint_valid := true
	var joint_changed := false
	for i in range(100):
		var variant: Array = optimizer._joint_mutation(parent)
		if variant.is_empty():
			continue
		joint_valid = joint_valid and optimizer._has_unique_positions(variant) and optimizer._within_ranges(variant)
		var signatures := {}
		for group in variant:
			var signature: String = optimizer._group_signature(group)
			joint_valid = joint_valid and signatures.get(group.ship, signature) == signature
			signatures[group.ship] = signature
		joint_changed = joint_changed or optimizer._layout_family_key(variant) != optimizer._layout_family_key(seed_formation)
	check("joint changes keep legal positions and ship-wide mods", joint_valid and joint_changed)
	var proposed := friendly.duplicate(true)
	proposed.search.strategy = "advisor_seeded"
	var advisor := resolver.resolve(proposed, common, settings.allowed_mod_slots)
	check("advisor seed uses normal numeric normalization", advisor.ok and advisor.config.optimizer.search.advisor_seeds.size() == 1)
	proposed.baseline.formation = {"Z9": 1}
	check("invalid advisor cell rejected", not resolver.resolve(proposed, common, settings.allowed_mod_slots).ok)
	proposed.baseline.formation = {}
	check("missing advisor seed rejected", not resolver.resolve(proposed, common, settings.allowed_mod_slots).ok)
	optimizer.objective = "normal"
	optimizer._verified_baseline = {"outcome": "lose"}
	check("losing seed is never a fallback recommendation", optimizer._select_recommendation([]).is_empty())
	optimizer._advisor_elites = [parent]
	optimizer._attempts = 1
	var neighbor: Array = optimizer._next_advisor_position()
	check("guided advisor moves preserve fleet and mods", optimizer._has_unique_positions(neighbor) and optimizer._layout_family_key(neighbor) == optimizer._layout_family_key(seed_formation))
	optimizer._settings.search = {"target_used_fr": 27.3}
	optimizer._progress_best = {"outcome": "lose", "fleet_resources_used": 0}
	check("losing low cost never reaches target", not optimizer._target_reached())
	optimizer._progress_best = {"outcome": "victory", "fleet_resources_used": 31.81}
	check("victory above target continues", not optimizer._target_reached())
	optimizer._progress_best.fleet_resources_used = 27.3
	check("victory at target stops search", optimizer._target_reached() and not optimizer._can_expand() and optimizer._stop_reason == "TARGET USED FR REACHED")
	proposed = friendly.duplicate(true)
	proposed.search.target_used_fr = -1
	check("negative target rejected", not resolver.resolve(proposed, common, settings.allowed_mod_slots).ok)
	await _check_worker_ipc(optimizer)
	var passed := true
	for item in checks:
		passed = passed and item.passed
	return {"passed": passed, "checks": checks}


func _check_worker_ipc(optimizer: Node) -> void:
	var ipc := FlakyIpc.new()
	var path := "user://ipc_regression_%s.json" % Time.get_ticks_usec()
	var payload := {"id": "test", "items": [{"index": 0, "config": {"formation": []}}]}
	ipc.publish_failures = 2
	var written := await ipc.write_message(path, payload, get_tree())
	check("worker publish retries transient rename failures", written.ok and ipc.publishes == 3)
	ipc.read_failures = 2
	var message := await ipc.read_message(path, get_tree())
	check("worker read retries transient open failures", message.ok and message.value.id == payload.id and message.value.items.size() == 1 and message.value.items[0].index == 0 and message.value.items[0].config.formation == [] and ipc.reads == 3)
	ipc.read_failures = 100000
	var started := Time.get_ticks_msec()
	message = await ipc.read_message(path, get_tree(), 30)
	check("permanent worker read failure returns bounded error", not message.ok and Time.get_ticks_msec() - started < 1000)
	DirAccess.remove_absolute(path)
	ipc.publish_failures = 100000
	written = await ipc.write_message(path, payload, get_tree(), 30)
	check("permanent worker publish failure cleans temporary message", not written.ok and not FileAccess.file_exists(path) and not FileAccess.file_exists(path + ".tmp"))
	check("worker response validates item index and result", optimizer._valid_worker_response({"results": [{"index": 1, "result": {}}]}, 1) and not optimizer._valid_worker_response({"results": [{"index": 0, "result": {}}]}, 1) and not optimizer._valid_worker_response({"results": []}, 0))
	optimizer._settings.max_wall_seconds = optimizer._elapsed_seconds() + 20.0
	optimizer._max_battle_seconds = 4.0
	check("worker deadline reserves native replay time", optimizer._worker_wait_budget_ms() <= 10000 and optimizer._worker_wait_budget_ms() > 9000)
	optimizer._settings.max_wall_seconds = optimizer._elapsed_seconds() - 1.0
	check("expired budget does not start a new 140 second wait", optimizer._worker_wait_budget_ms() == 0)
	var failures: Array = optimizer._fail_worker_wave([{}, {}], "injected worker failure")
	check("worker failure stops exploration with explicit candidate errors", failures.size() == 2 and failures[0].error == "injected worker failure" and not optimizer._can_expand() and not optimizer._can_simulate() and optimizer._stop_reason == "WORKER IPC FAILED")
	check("unfinished worker job never becomes a scored battle error", optimizer._store_worker_result({}, [], "interrupted", failures[0]).is_empty() and not optimizer._cache.has("interrupted") and optimizer._worker_interrupted_candidates == 1)
