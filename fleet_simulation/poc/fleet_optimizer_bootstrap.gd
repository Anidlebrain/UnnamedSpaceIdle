extends Node


func _ready() -> void:
	var galaxy_id := _argument_value("--optimizer-galaxy=")
	assert(galaxy_id in db.fleet_galaxies, "Unknown optimizer galaxy: %s" % galaxy_id)
	EventHelper.set_process(false)

	var battle_area := preload("res://fleet_optimizer_battle_area.gd").new()
	add_child(battle_area)

	var galaxy := preload("res://fleet/interface/FleetGalaxy.tscn").instantiate()
	galaxy.galaxy_id = galaxy_id
	galaxy.visible = false
	add_child(galaxy)

	Fleet.hidden_fleet_battle_holder = self
	_add_http_guard(preload("res://fleet/interface/HTTPSaveBattleDetails.gd"))
	_add_http_guard(preload("res://fleet/interface/HTTPValidateBattleDetails.gd"))


func _add_http_guard(script: Script) -> void:
	var request := HTTPRequest.new()
	request.set_script(script)
	add_child(request)


func _argument_value(prefix: String) -> String:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with(prefix):
			return argument.substr(prefix.length())
	return ""
