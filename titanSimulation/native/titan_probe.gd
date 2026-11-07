extends Node

func _ready() -> void:
	call_deferred("_run")

func _run() -> void:
	if not TitanGuard.isolated:
		get_tree().quit(40)
		return
	print("TITAN_PROBE_BOOTSTRAP_READY")
	SaveLoad.pause_auto_save = true
	var started := Time.get_ticks_msec()
	var scene = load("res://Game.tscn")
	var loaded := Time.get_ticks_msec()
	var game = scene.instantiate()
	var instantiated := Time.get_ticks_msec()
	add_child(game)
	var attached := Time.get_ticks_msec()
	await get_tree().process_frame
	get_tree().paused = false
	var result := {
		"status": "NATIVE_INITIALIZATION_ONLY",
		"native_game_loaded": true,
		"version": PlayerInfo.version,
		"user_dir": OS.get_user_data_dir(),
		"battle_area": is_instance_valid(PlayerInfo.battle_area.Normal),
		"titan_array": is_instance_valid(PlayerInfo.titan_array),
		"core_controller": is_instance_valid(PlayerInfo.core_controller),
		"nodes": get_tree().get_node_count(),
		"elapsed_ms": Time.get_ticks_msec(),
		"startup_phases_ms": {"autoload": started, "load": loaded - started,
			"instantiate": instantiated - loaded, "ready": attached - instantiated},
	}
	if FileAccess.file_exists("res://native_input.json"):
		var input = JSON.parse_string(FileAccess.get_file_as_string("res://native_input.json"))
		if input.get("server", false):
			await _serve(game, result)
			get_tree().quit(0)
			return
		var cases: Array = input.get("cases", [input])
		var battles: Array = []
		for case in cases:
			var probe = preload("res://titan_battle_probe.gd").new()
			add_child(probe)
			var battle_result = await probe.run(case, game)
			battles.append(battle_result)
			get_tree().paused = true
			probe.queue_free()
			await get_tree().process_frame
			print("TITAN_CASE_COMPLETE: " + str(battles.size()))
			if battle_result.status != "NATIVE_SMOKE_ONLY":
				break
		if input.has("cases"):
			result["battles"] = battles
			result["expected_cases"] = cases.size()
		else:
			result["battle"] = battles[0]
	var output := FileAccess.open("user://probe.json", FileAccess.WRITE)
	output.store_string(JSON.stringify(result, "\t"))
	output.close()
	print("TITAN_PROBE_COMPLETE: " + JSON.stringify(result))
	get_tree().quit(0)

func _write_json(path: String, value: Dictionary) -> void:
	var file = FileAccess.open(path + ".tmp", FileAccess.WRITE)
	file.store_string(JSON.stringify(value))
	file.close()
	DirAccess.rename_absolute(path + ".tmp", path)

func _serve(game: Node, startup: Dictionary) -> void:
	get_tree().paused = true
	_write_json("user://ready.json", startup)
	var index := 1
	while true:
		var path := "user://requests/%06d.json" % index
		while not FileAccess.file_exists(path):
			OS.delay_msec(10)
			await get_tree().process_frame
		var request = JSON.parse_string(FileAccess.get_file_as_string(path))
		if request.get("stop", false):
			return
		var probe = preload("res://titan_battle_probe.gd").new()
		add_child(probe)
		var battle = await probe.run(request.input, game)
		get_tree().paused = true
		probe.queue_free()
		await get_tree().process_frame
		_write_json("user://responses/%06d.json" % index, {"id": index, "battle": battle})
		index += 1
