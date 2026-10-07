extends RefCounted
## Atomic JSON messages with bounded retries for transient filesystem failures.
## A script assertion must never strand an otherwise live worker process.


func _open_read(path: String) -> FileAccess:
	return FileAccess.open(path, FileAccess.READ)


func _publish(source: String, destination: String) -> int:
	return DirAccess.rename_absolute(source, destination)


func read_message(path: String, tree: SceneTree, timeout_ms: int = 2000) -> Dictionary:
	var deadline := Time.get_ticks_msec() + maxi(0, timeout_ms)
	while true:
		var file := _open_read(path)
		if file != null:
			var value = JSON.parse_string(file.get_as_text())
			file.close()
			if value is Dictionary:
				return {"ok": true, "value": value}
			return {"ok": false, "error": "Invalid worker JSON object: %s" % path}
		if Time.get_ticks_msec() >= deadline:
			return {"ok": false, "error": "Unable to open worker message after bounded retries: %s" % path}
		OS.delay_msec(10)
		await tree.process_frame
	return {}


func write_message(path: String, value: Dictionary, tree: SceneTree, timeout_ms: int = 2000) -> Dictionary:
	var temporary_path := path + ".tmp"
	var deadline := Time.get_ticks_msec() + maxi(0, timeout_ms)
	var prepared := false
	while true:
		if not prepared:
			var file := FileAccess.open(temporary_path, FileAccess.WRITE)
			if file != null:
				file.store_string(JSON.stringify(value, "", true, true))
				file.flush()
				prepared = file.get_error() == OK
				file.close()
		if prepared and _publish(temporary_path, path) == OK:
			return {"ok": true}
		if Time.get_ticks_msec() >= deadline:
			DirAccess.remove_absolute(temporary_path)
			return {"ok": false, "error": "Unable to publish worker message after bounded retries: %s" % path}
		OS.delay_msec(10)
		await tree.process_frame
	return {}
