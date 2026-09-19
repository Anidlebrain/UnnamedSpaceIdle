extends Node

signal finished(result: Dictionary)

const BATTLE_TIMEOUT_MSEC := 120000
const POST_BATTLE_SETTLE_TIMEOUT_MSEC := 6000
const DEFAULT_SIMULATION_SEED := 20260919

var _native_ship_mod_scopes := {}
var _last_setup_breakdown := {}
var _scaled_player_groups := {}
var _prepared_config := {}


# Hold the PackedScene for native Fleet.load_battle's resource cache. Each run
# still instantiates and frees a fresh original FleetBattle scene.
var _battle_scene_resource = preload("res://fleet/FleetBattle.tscn")

class SettlementSink extends Node:
	var battle_done := false
	func set_battle_complete(_details, _manual, _auto) -> void:
		pass


func native_fr_settlement(galaxy_id: String, available: float, used: float) -> Dictionary:
	# Invoke original debit logic; isolate the campaign progression receiver.
	var resource := galaxy_id + "FleetResources"
	var had_resource: bool = PlayerInfo.resources.has(resource)
	var saved_resource = PlayerInfo.resources.get(resource)
	var saved_origin = Fleet.battle_started_from
	var saved_galaxy: String = Fleet.galaxy_exploring
	var saved_auto: bool = Fleet.full_auto_battle
	var saved_practice: bool = Fleet.battle_practice_mode
	var saved_on: String = Fleet.battle_on
	var sink := SettlementSink.new()
	add_child(sink)
	Fleet.battle_started_from = sink
	Fleet.galaxy_exploring = galaxy_id
	Fleet.full_auto_battle = false
	PlayerInfo.resources[resource] = available
	var details := BattleCompletionDetails.new()
	details.resources_used = used
	Fleet.battle_complete(true, details)
	var after := float(PlayerInfo.resources[resource])
	if had_resource:
		PlayerInfo.resources[resource] = saved_resource
	else:
		PlayerInfo.resources.erase(resource)
	Fleet.battle_started_from = saved_origin
	Fleet.galaxy_exploring = saved_galaxy
	Fleet.full_auto_battle = saved_auto
	Fleet.battle_practice_mode = saved_practice
	Fleet.battle_on = saved_on
	sink.free()
	return {"resources_after": after, "resource_debit": available - after,
		"source": "Fleet.battle_complete -> PlayerInfo.gain_resource"}


func run_demo() -> Dictionary:
	return await run_battle({
		"galaxy_id": "galaxy1",
		"fleet_event_id": "g1_1_b1",
		"battle_id": "galaxy1_battle1",
		"grid_size": [2, 5],
		"player_damage_scale": 1.0,
		"player_health_scale": 1.0,
		"fleet_resources": 100.0,
		"fleet_resources_retention": 0.5,
		"ships_available": {"Corvette": 1},
		"formation": [{
			"ship": "Corvette",
			"grid_position": [0, 2],
			"primary_mod": null,
			"secondary_mod": null,
			"tertiary_mods": [],
		}],
		"enemy_fleet": [{
			"ship": "EnemyBasic",
			"grid_position": [0, 2],
			"mods": [],
			"difficulty_override": 1.0,
		}],
		"hazards": [],
		"supports": [],
		"temporary_events": [],
		"fight_enemy_command_ship": false,
		"boss_health": null,
	})


func run_battle(config: Dictionary) -> Dictionary:
	var total_started := Time.get_ticks_usec()
	var battle: FleetBattle
	if not _prepared_config.is_empty() and _prepared_config == config and is_instance_valid(Fleet.fleet_battle):
		battle = Fleet.fleet_battle
		_prepared_config = {}
		_last_setup_breakdown = {}
	else:
		if not _prepared_config.is_empty():
			await cleanup_battle()
		battle = await _setup_battle(config)
	var start_started := Time.get_ticks_usec()
	# The original start handler awaits a physics frame; clear tutorial pause first.
	Engine.time_scale = 1.0
	get_tree().paused = false
	await battle._on_btnStart_pressed()

	for _frame in range(10):
		if FleetController.fleet_controller_enabled:
			break
		await get_tree().create_timer(0.05).timeout
	assert(FleetController.fleet_controller_enabled, "Fleet controller did not start")
	var battle_started := Time.get_ticks_usec()

	# A fresh profile opens the first-battle tutorial at time_scale 0.0001.
	Engine.time_scale = 1.0
	get_tree().paused = false
	var ship_snapshots := _snapshot_ships()
	var effect_state := _runtime_effect_state(battle)
	var runtime_effect_events := _runtime_effect_start_events(effect_state)
	var deadline := Time.get_ticks_msec() + BATTLE_TIMEOUT_MSEC
	while battle.battle_state == FleetBattle.BattleState.IN_PROGRESS and Time.get_ticks_msec() < deadline:
		await get_tree().physics_frame
		_apply_player_scales(battle, float(config.player_damage_scale), float(config.player_health_scale))
		_snapshot_new_ships(
			ship_snapshots,
			float(config.player_damage_scale),
			float(config.player_health_scale),
		)
		_track_runtime_effects(battle, effect_state, runtime_effect_events)
	if battle.battle_state != FleetBattle.BattleState.IN_PROGRESS:
		await _wait_for_pending_projectiles()

	var battle_wall_ms := (Time.get_ticks_usec() - battle_started) / 1000.0
	var extraction_started := Time.get_ticks_usec()
	var result := _collect_result(battle, ship_snapshots, config, runtime_effect_events)
	result["simulation_clock"] = simulation_clock_metadata(
		config,
		float(result.get("simulation_time", 0.0)),
		battle_wall_ms / 1000.0,
	)
	var log_report_ms := float(result.get("_log_report_ms", 0.0))
	result.erase("_log_report_ms")
	var extraction_ms := (Time.get_ticks_usec() - extraction_started) / 1000.0
	if battle.battle_state == FleetBattle.BattleState.IN_PROGRESS:
		result["error"] = "Fleet simulation timed out"
	elif _has_pending_projectiles():
		result["error"] = "Pending projectiles did not settle before adapter timeout"
	_clear_battle_submission_queue()
	result["performance_breakdown"] = {
		"scene_creation_ms": float(_last_setup_breakdown.get("scene_creation_ms", 0.0)),
		"scene_setup_ms": float(_last_setup_breakdown.get("scene_setup_ms", 0.0)),
		"battle_start_ms": (battle_started - start_started) / 1000.0,
		"battle_wall_ms": battle_wall_ms,
		"result_extract_ms": extraction_ms,
		"log_report_ms": log_report_ms,
		"run_battle_total_ms_before_cleanup": (Time.get_ticks_usec() - total_started) / 1000.0,
	}
	finished.emit(result)
	return result


func quote_player_deployment(config: Dictionary, keep_prepared: bool = false) -> Dictionary:
	var disabled_ships: Array = []
	for item in config.get("formation", []):
		var ship_id := str(item.ship)
		if ship_id not in disabled_ships and not _config_ship_enabled(config, ship_id):
			disabled_ships.append(ship_id)
	if not disabled_ships.is_empty():
		return {
			"deployable": false,
			"reason": "ship_disabled_or_zero_available",
			"disabled_ships": disabled_ships,
			"fleet_resources_committed": 0.0,
			"within_budget": false,
			"deployment": _deployment_breakdown(config),
		}
	var battle: FleetBattle = await _setup_battle(config)
	var committed := float(battle.fleet_resources)
	var native_costs := {}
	for group in get_tree().get_nodes_in_group("deployment_group"):
		if group.team == Fleet.Team.LEFT and not group.removing:
			native_costs[str(group.fleet_ship_info.id)] = group.fleet_ship_info.fleet_resources_cost
	var result := {
		"deployable": true,
		"reason": "",
		"fleet_resources_committed": committed,
		"native_modded_costs": native_costs,
		"within_budget": NumberUtils.fleet_less_or_equal(committed, float(config.fleet_resources)),
		"deployment": _deployment_breakdown(config),
		"source": "FleetBattle.calc_total_deployment",
	}
	if keep_prepared and bool(result.within_budget):
		_prepared_config = config.duplicate(true)
	else:
		await cleanup_battle()
	return result


func _setup_battle(config: Dictionary) -> FleetBattle:
	var setup_started := Time.get_ticks_usec()
	_validate_config(config)
	_prepare_runtime(config)
	var fleet_event = Fleet.fleet_event_refs[str(config.fleet_event_id)]
	var player_ship_list := _build_player_ship_list(config)

	# An empty current galaxy selects the native Practice path without reading a save.
	Fleet.galaxy_exploring = ""
	Fleet.galaxy_viewing = str(config.galaxy_id)
	var scene_started := Time.get_ticks_usec()
	Fleet.start_battle(str(config.battle_id), player_ship_list, fleet_event)
	await get_tree().process_frame
	var scene_creation_ms := (Time.get_ticks_usec() - scene_started) / 1000.0

	var battle: FleetBattle = Fleet.fleet_battle
	assert(is_instance_valid(battle))
	assert(Fleet.battle_practice_mode)
	_disable_battle_submission()

	battle.clear_grid()
	battle.clear_all_ships()
	battle.clear_all_projectiles()
	battle.hazard_manager.reset()
	battle.update_battle_state(FleetBattle.BattleState.SETUP)
	await get_tree().process_frame

	Fleet.grid_size = _to_vector2(config.grid_size)
	Fleet.sandbox_mode_player_stats = 1.0
	Fleet.fleet_ships_available_this_battle = player_ship_list.duplicate(true)
	_configure_ship_mods(config)
	_configure_retention(str(config.galaxy_id), float(config.fleet_resources_retention))

	battle.fleet_resources_max = float(config.fleet_resources)
	battle.fleet1 = _build_fleet_entries(config.formation, true)
	battle.fleet2 = _build_fleet_entries(config.enemy_fleet, false)
	battle.completed_temp_events = _nodes_from_ids(config.temporary_events)
	var hazard_nodes := _nodes_from_ids(config.hazards)
	hazard_nodes.append_array(_nodes_from_ids(config.supports))
	battle.hazard_manager.setup_hazards(hazard_nodes)

	battle.battle_practice_settings.fight_enemy_command_ship = bool(config.fight_enemy_command_ship)
	if config.boss_health != null:
		fleet_event.command_ship_health_left = float(config.boss_health)
		fleet_event.command_ship_health_pre_battle = float(config.boss_health)

	battle.setup_battle()
	battle.update_grid_buffs()
	_apply_player_scales(battle, float(config.player_damage_scale), float(config.player_health_scale))
	battle.calc_total_deployment()
	_last_setup_breakdown = {
		"scene_creation_ms": scene_creation_ms,
		"scene_setup_ms": (Time.get_ticks_usec() - setup_started) / 1000.0 - scene_creation_ms,
	}
	return battle


func _wait_for_pending_projectiles() -> void:
	var deadline := Time.get_ticks_msec() + POST_BATTLE_SETTLE_TIMEOUT_MSEC
	while _has_pending_projectiles() and Time.get_ticks_msec() < deadline:
		await get_tree().physics_frame
		await get_tree().process_frame


func _has_pending_projectiles() -> bool:
	for projectile in FleetController.projectiles:
		if (
			is_instance_valid(projectile)
			and projectile.is_inside_tree()
			and projectile.is_physics_processing()
			and not projectile.is_queued_for_deletion()
		):
			return true
	return false


func cleanup_battle() -> Dictionary:
	_prepared_config = {}
	var started := Time.get_ticks_usec()
	FleetController.fleet_controller_enabled = false
	FleetController.reset()
	FleetController.battle_timer = 0.0
	if is_instance_valid(Fleet.fleet_battle):
		Fleet.fleet_battle.hazard_manager.reset()
		Fleet.fleet_battle.queue_free()
	await get_tree().process_frame
	await get_tree().process_frame
	Fleet.fleet_battle = null
	Fleet.battle_log = []
	Fleet.reset()
	return {"cleanup_ms": (Time.get_ticks_usec() - started) / 1000.0}


func _prepare_runtime(config: Dictionary) -> void:
	FleetController.fleet_controller_enabled = false
	FleetController.reset()
	FleetController.battle_timer = 0.0
	_scaled_player_groups.clear()
	# The original battle code uses the process-global RNG for combat-affecting
	# checks such as fighter evasion. Workers otherwise start with unrelated RNG
	# state, so a candidate can win in a worker and fail its main-process replay.
	# Reset it before every battle so identical configs have identical combat RNG.
	seed(int(config.get("simulation_seed", DEFAULT_SIMULATION_SEED)))
	Engine.time_scale = 1.0
	get_tree().paused = false
	# Tutorial popups and their pause state are unrelated to combat inputs.
	# Marking them viewed only mutates this isolated test process.
	for dialogue in Dialogue.dialogues.values():
		dialogue.viewed = true


func _validate_config(config: Dictionary) -> void:
	for key in [
		"galaxy_id", "fleet_event_id", "battle_id", "grid_size",
		"player_damage_scale", "player_health_scale", "fleet_resources",
		"fleet_resources_retention", "ships_available", "formation",
		"enemy_fleet", "hazards", "supports", "temporary_events",
		"fight_enemy_command_ship", "boss_health",
	]:
		assert(config.has(key), "Missing Battle Config field: %s" % key)
	assert(str(config.fleet_event_id) in Fleet.fleet_event_refs)
	assert(str(config.galaxy_id) in Fleet.galaxy_nodes)
	assert(str(config.battle_id) in Fleet.fleet_battles)
	var fleet_event = Fleet.fleet_event_refs[str(config.fleet_event_id)]
	assert(fleet_event.galaxy_id == str(config.galaxy_id))
	assert(fleet_event.stats.battle_requirement == str(config.battle_id))
	assert(float(config.player_damage_scale) > 0.0)
	assert(float(config.player_health_scale) > 0.0)
	assert(float(config.fleet_resources) >= 0.0)
	assert(float(config.fleet_resources_retention) >= 0.0 and float(config.fleet_resources_retention) <= 100.0)
	assert(config.formation.size() > 0)
	assert(config.enemy_fleet.size() > 0)
	assert(not fleet_event.has_command_ship or config.fight_enemy_command_ship or config.boss_health != null, "Boss battle needs fight_enemy_command_ship or boss_health")
	assert(not config.fight_enemy_command_ship or config.boss_health == null, "Full-health boss mode and exact boss_health are mutually exclusive")
	assert(_requested_simulation_clock(config) in ["realtime", "offline_fixed_step"], "simulation_clock must be realtime or offline_fixed_step")

	var mods_by_ship := {}
	for item in config.formation:
		var ship_id := str(item.ship)
		assert(ship_id in db.fleet_ships)
		assert(ship_id in config.ships_available)
		assert(_config_ship_enabled(config, ship_id), "Ship is disabled or has zero availability: %s" % ship_id)
		var mod_signature := JSON.stringify(_player_mods_from_entry(item))
		assert(not mods_by_ship.has(ship_id) or mods_by_ship[ship_id] == mod_signature, "All deployments of one ship type share the same original mod slots")
		mods_by_ship[ship_id] = mod_signature
	for item in config.enemy_fleet:
		assert(str(item.ship) in db.fleet_ships)
		for mod_id in item.get("mods", []):
			_validate_mod(str(mod_id), -1)
	for event_list in [config.hazards, config.supports, config.temporary_events]:
		for event_id in event_list:
			assert(str(event_id) in Fleet.fleet_event_refs, "Unknown Fleet event: %s" % event_id)


func _build_player_ship_list(config: Dictionary) -> Dictionary:
	var result := {}
	for ship_id in config.ships_available:
		assert(str(ship_id) in db.fleet_ships)
		result[str(ship_id)] = {
			"amount": _available_amount(config.ships_available[ship_id]),
			"mods": [],
		}
	for item in config.formation:
		for mod_id in _player_mods_from_entry(item):
			if mod_id != "" and mod_id not in result[str(item.ship)].mods:
				result[str(item.ship)].mods.append(mod_id)
	return result


func _available_amount(value) -> int:
	if value is Dictionary:
		return int(value.get("available", value.get("amount", 0)))
	return int(value)


func _config_ship_enabled(config: Dictionary, ship_id: String) -> bool:
	if ship_id not in config.ships_available:
		return false
	var value = config.ships_available[ship_id]
	var enabled := bool(value.get("enabled", true)) if value is Dictionary else true
	return enabled and _available_amount(value) > 0


func _deployment_breakdown(config: Dictionary) -> Dictionary:
	var deployed := {}
	for item in config.formation:
		var ship_id := str(item.ship)
		deployed[ship_id] = int(deployed.get(ship_id, 0)) + 1
	var result := {}
	for ship_id in deployed:
		var available := _available_amount(config.ships_available.get(ship_id, 0))
		result[ship_id] = {
			"deployed": deployed[ship_id],
			"available": available,
			"normal_groups": mini(deployed[ship_id], available),
			"overdeployed_groups": maxi(0, deployed[ship_id] - available),
		}
	return result


func _build_fleet_entries(items: Array, player: bool) -> Array:
	var entries: Array = []
	for item in items:
		var mods: Array = _player_mods_from_entry(item) if player else Array(item.get("mods", [])).duplicate()
		entries.append(FleetEntry.new(
			str(item.ship),
			_to_vector2(item.grid_position),
			mods,
			float(item.get("difficulty_override", -1.0)),
		))
	return entries


func _to_vector2(value) -> Vector2:
	assert(value is Array and value.size() == 2, "Grid positions and grid_size must be [x, y] arrays")
	return Vector2(float(value[0]), float(value[1]))


func _player_mods_from_entry(item: Dictionary) -> Array:
	var primary := "" if item.get("primary_mod") == null else str(item.get("primary_mod", ""))
	var secondary := "" if item.get("secondary_mod") == null else str(item.get("secondary_mod", ""))
	_validate_mod(primary, Fleet.ModSlot.PRIMARY)
	_validate_mod(secondary, Fleet.ModSlot.SECONDARY)
	var mods: Array = [primary, secondary]
	for mod_id in item.get("tertiary_mods", []):
		_validate_mod(str(mod_id), Fleet.ModSlot.TERTIARY)
		mods.append(str(mod_id))
	return mods


func _validate_mod(mod_id: String, expected_slot: int) -> void:
	if mod_id == "":
		return
	assert(mod_id in db.fleet_mods, "Unknown Fleet mod: %s" % mod_id)
	assert(expected_slot == -1 or int(db.fleet_mods[mod_id].slot) == expected_slot, "Fleet mod is in the wrong slot: %s" % mod_id)


func _configure_ship_mods(config: Dictionary) -> void:
	if _native_ship_mod_scopes.is_empty():
		for ship_id in Fleet.get_fleet_ship_dict():
			_native_ship_mod_scopes[ship_id] = Fleet.get_fleet_ship_dict(ship_id).mods.duplicate(true)
	for ship_id in Fleet.get_fleet_ship_dict():
		var ship_state: Dictionary = Fleet.get_fleet_ship_dict(ship_id)
		ship_state.selected_mods = ["", ""]
		ship_state.mods = _native_ship_mod_scopes.get(ship_id, {}).duplicate(true)
	for ship_id in config.get("fleet_mod_loadouts", {}):
		_apply_mod_list(str(ship_id), _player_mods_from_entry(config.fleet_mod_loadouts[ship_id]))
	for item in config.formation:
		_apply_mod_list(str(item.ship), _player_mods_from_entry(item))
	for item in config.enemy_fleet:
		_apply_mod_list(str(item.ship), Array(item.get("mods", [])))


func _apply_mod_list(ship_id: String, mods: Array) -> void:
	var ship_state: Dictionary = Fleet.get_fleet_ship_dict(ship_id)
	for mod_id_value in mods:
		var mod_id := str(mod_id_value)
		if mod_id == "":
			continue
		var slot := int(db.fleet_mods[mod_id].slot)
		if slot == Fleet.ModSlot.TERTIARY:
			ship_state.mods[mod_id] = "all"
		else:
			ship_state.selected_mods[slot] = mod_id


func _configure_retention(galaxy_id: String, retention: float) -> void:
	# New configs use 0..1; values above 1 replay legacy percent-based results.
	PlayerInfo.stats["fleet_resources_retention"] = retention * 100.0 if retention <= 1.0 else retention
	var galaxy_stat := "fleet_%s_resources_retention" % galaxy_id
	if galaxy_stat in PlayerInfo.stats:
		PlayerInfo.stats[galaxy_stat] = 0.0


func _nodes_from_ids(ids: Array) -> Array:
	var nodes: Array = []
	for event_id in ids:
		nodes.append(Fleet.fleet_event_refs[str(event_id)])
	return nodes


func _apply_player_scales(battle: FleetBattle, damage_scale: float, health_scale: float) -> void:
	for deployment_group in get_tree().get_nodes_in_group("deployment_group"):
		if deployment_group.team != Fleet.Team.LEFT:
			continue
		_scale_player_group(deployment_group, damage_scale, health_scale)


func _scale_player_group(deployment_group, damage_scale: float, health_scale: float) -> void:
	var instance_id: int = deployment_group.get_instance_id()
	if _scaled_player_groups.has(instance_id):
		return
	_scaled_player_groups[instance_id] = true
	deployment_group.fleet_ship_info.ship.damage_scale *= damage_scale
	deployment_group.fleet_ship_info.ship.health_scale *= health_scale
	for ship in deployment_group.ships.get_children():
		ship.stats = deployment_group.fleet_ship_info.ship
		ship.update_stats()


func _scale_new_player_group(ship, damage_scale: float, health_scale: float) -> void:
	if ship.ship_record.team != Fleet.Team.LEFT:
		return
	var group_ships: Array = ship.friendly_group_ships
	var first_ship = ship if group_ships.is_empty() else group_ships[0]
	var instance_id: int = first_ship.get_instance_id()
	if _scaled_player_groups.has(instance_id):
		return
	_scaled_player_groups[instance_id] = true
	ship.stats.damage_scale *= damage_scale
	ship.stats.health_scale *= health_scale
	for group_ship in group_ships:
		if is_instance_valid(group_ship):
			group_ship.stats = ship.stats
			group_ship.update_stats()


func _disable_battle_submission() -> void:
	assert(Fleet.http_save_battle_details != null)
	Fleet.http_save_battle_details.available = false
	Fleet.http_save_battle_details.queue.clear()
	if Fleet.http_validate_battle_details != null:
		Fleet.http_validate_battle_details.available = false
		Fleet.http_validate_battle_details.queue.clear()


func _clear_battle_submission_queue() -> void:
	if Fleet.http_save_battle_details != null:
		Fleet.http_save_battle_details.queue.clear()
	if Fleet.http_validate_battle_details != null:
		Fleet.http_validate_battle_details.queue.clear()


func _snapshot_ships() -> Array[Dictionary]:
	var snapshots: Array[Dictionary] = []
	for ship in FleetController.ships:
		snapshots.append(_snapshot_ship(ship, false))
	return snapshots


func _snapshot_new_ships(
	snapshots: Array[Dictionary],
	damage_scale: float,
	health_scale: float,
) -> void:
	var known := {}
	for snapshot in snapshots:
		known[int(snapshot.instance_id)] = true
	for ship in FleetController.ships:
		if is_instance_valid(ship) and not known.has(ship.get_instance_id()):
			_scale_new_player_group(ship, damage_scale, health_scale)
			snapshots.append(_snapshot_ship(ship, true))


func _snapshot_ship(ship, spawned_during_battle: bool) -> Dictionary:
	return {
		"node": weakref(ship),
		"instance_id": ship.get_instance_id(),
		"record": ship.ship_record,
		"mods": Fleet.get_ship_mods(ship.fleet_ship_id).duplicate(),
		"max_hull": ship.max_hull,
		"max_shields": ship.max_shields,
		"max_barrier": ship.max_barrier,
		"spawned_during_battle": spawned_during_battle,
	}


func _collect_result(
	battle: FleetBattle,
	snapshots: Array[Dictionary],
	config: Dictionary,
	runtime_effect_events: Array,
) -> Dictionary:
	var ships := {"player": [], "enemy": []}
	for snapshot in snapshots:
		var record: ShipRecord = snapshot.record
		var ship = snapshot.node.get_ref()
		var alive: bool = is_instance_valid(ship) and not ship.dead
		var state := {
			"id": record.fleet_ship_id,
			"name": record.text_name,
			"team": record.team,
			"grid_position": [record.deployment_position.x, record.deployment_position.y],
			"alive": alive,
			"hull": ship.hull if alive else 0.0,
			"max_hull": snapshot.max_hull,
			"shields": ship.shields if alive else 0.0,
			"max_shields": snapshot.max_shields,
			"barrier": ship.barrier if alive else 0.0,
			"max_barrier": snapshot.max_barrier,
			"mods": snapshot.mods,
			"spawned_during_battle": snapshot.spawned_during_battle,
		}
		if record.team == Fleet.Team.LEFT:
			ships.player.append(state)
		else:
			ships.enemy.append(state)

	var outcome := "in_progress"
	if battle.battle_state == FleetBattle.BattleState.COMPLETE_WIN:
		outcome = "victory"
	elif battle.battle_state == FleetBattle.BattleState.COMPLETE_LOSE:
		outcome = "lose"
	var log_started := Time.get_ticks_usec()
	var raw_log: Array = []
	var copy_log := ""
	if str(config.get("simulation_detail", "full")) == "full":
		raw_log = _serialize_battle_log()
		copy_log = _build_copy_battle_log()
	var log_report_ms := (Time.get_ticks_usec() - log_started) / 1000.0
	return {
		"outcome": outcome,
		"simulation_time": FleetController.battle_timer,
		"fleet_resources_committed": battle.fleet_resources_committed,
		"fleet_resources_used": battle.fleet_resources_committed - battle.fleet_resources,
		"boss_damage": battle.bcd.boss_damage if battle.bcd != null else 0.0,
		"player_ships": ships.player,
		"enemy_ships": ships.enemy,
		"raw_battle_log": raw_log,
		"copy_battle_log_text": copy_log,
		"runtime_effect_events": runtime_effect_events,
		"battle_config": config.duplicate(true),
		"_log_report_ms": log_report_ms,
	}


func simulation_clock_metadata(
	config: Dictionary,
	simulated_seconds: float = 0.0,
	wall_seconds: float = 0.0,
) -> Dictionary:
	var requested := _requested_simulation_clock(config)
	var fixed_fps := _fixed_fps()
	var effective := "offline_fixed_step" if fixed_fps == Engine.physics_ticks_per_second else "realtime"
	var warning := ""
	if requested != effective:
		warning = (
			"offline_fixed_step requested without --fixed-fps 60; realtime fallback used"
			if requested == "offline_fixed_step"
			else "realtime requested in a --fixed-fps 60 process; offline_fixed_step remained active"
		)
	return {
		"mode": effective,
		"requested_mode": requested,
		"physics_hz": Engine.physics_ticks_per_second,
		"step_seconds": 1.0 / float(Engine.physics_ticks_per_second),
		"simulated_seconds": simulated_seconds,
		"wall_seconds": wall_seconds,
		"wall_speedup": simulated_seconds / wall_seconds if wall_seconds > 0.0 else 0.0,
		"engine_fixed_fps": fixed_fps,
		"random_seed": int(config.get("simulation_seed", DEFAULT_SIMULATION_SEED)),
		"fallback_warning": warning,
	}


func _requested_simulation_clock(config: Dictionary) -> String:
	if config.has("simulation_clock"):
		return str(config.simulation_clock)
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--simulation-clock="):
			return argument.trim_prefix("--simulation-clock=")
	return "realtime"


func _fixed_fps() -> int:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--fixed-fps-active="):
			return int(argument.trim_prefix("--fixed-fps-active="))
	var arguments := OS.get_cmdline_args()
	for index in range(arguments.size()):
		var argument := str(arguments[index])
		if argument == "--fixed-fps" and index + 1 < arguments.size():
			return int(arguments[index + 1])
		if argument.begins_with("--fixed-fps="):
			return int(argument.trim_prefix("--fixed-fps="))
	return 0


func _runtime_effect_state(battle: FleetBattle) -> Array:
	var result: Array = []
	for index in range(battle.hazard_manager.hazards.size()):
		var effect: Dictionary = battle.hazard_manager.hazards[index]
		result.append({
			"index": index,
			"originator_node": str(effect.get("originator_node", "")),
			"type": str(effect.get("type", "unknown")),
			"team": int(effect.get("team", -1)),
			"enabled": bool(effect.get("enabled", false)),
			"timer": float(effect.get("timer", 0.0)),
		})
	return result


func _runtime_effect_start_events(effect_state: Array) -> Array:
	var result: Array = []
	for state in effect_state:
		var event: Dictionary = state.duplicate(true)
		event.erase("timer")
		event["event"] = "active"
		event["simulated_seconds"] = 0.0
		result.append(event)
	return result


func _track_runtime_effects(battle: FleetBattle, effect_state: Array, events: Array) -> void:
	for state in effect_state:
		var index := int(state.index)
		if index >= battle.hazard_manager.hazards.size():
			continue
		var effect: Dictionary = battle.hazard_manager.hazards[index]
		var enabled := bool(effect.get("enabled", false))
		var timer := float(effect.get("timer", 0.0))
		if bool(state.enabled) and (not enabled or timer < float(state.timer)):
			events.append({
				"event": "triggered",
				"originator_node": state.originator_node,
				"type": state.type,
				"team": state.team,
				"simulated_seconds": FleetController.battle_timer,
			})
		state.enabled = enabled
		state.timer = timer


func _serialize_battle_log() -> Array[Dictionary]:
	var events: Array[Dictionary] = []
	for event in Fleet.battle_log:
		events.append({
			"actor": event.actor.unique_id,
			"action": event.action,
			"target": event.target.unique_id,
			"amount": event.amount,
			"time": event.time,
		})
	return events


func _build_copy_battle_log() -> String:
	var battle_log_text := ""
	for event in Fleet.battle_log:
		var text := ""
		if event.action == ShipRecord.BattleAction.DAMAGE_DEALT:
			text = Translations.do_tr("%s did %s damage to %s") % [
				event.actor.text_name,
				NumberUtils.format_number(event.amount, 2, 2),
				event.target.text_name,
			]
		elif event.action == ShipRecord.BattleAction.KILL:
			text = Translations.do_tr("%s destroyed %s") % [event.actor.text_name, event.target.text_name]
		else:
			continue
		battle_log_text += "\n" + text
	# This is intentionally identical to BattleReport.build_log(), including its
	# one-newline + substr(2) first-character truncation in game version 0.85.1.0.
	return battle_log_text.substr(2) if battle_log_text.length() > 0 else ""
