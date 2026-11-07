extends Node

var elapsed := 0.0
var deaths := 0
var colossal_kills := 0
var boss_killed := false
var initial_core_stats: Array = []
var minimum_shield_fraction := 1.0
var processed_frames := 0
var trace: Array = []
var kill_times: Array = []
var cycle_shield_fractions: Array = []

func _process(delta: float) -> void:
	elapsed += delta
	processed_frames += 1

func run(input: Dictionary, game: Node) -> Dictionary:
	var setup_start := Time.get_ticks_msec()
	get_tree().paused = true
	# Set before yielding: the current frame's delta may still carry tutorial speed.
	Engine.time_scale = 1.0
	set_process(true)
	var battle = PlayerInfo.battle_area.Normal
	_freeze_ui(game, battle)
	# Research runs have no manual resource-click actions; keep their wall-clock
	# spawner from advancing or consuming randomness between cases.
	_freeze_ui(battle.get_node("ClickableSpawner"), battle)
	battle.clear_clickables()
	SaveLoad.pause_auto_save = true
	SaveLoad.loading = true
	for dialogue in Dialogue.dialogues.values():
		dialogue.viewed = true
	battle.wave_spawner.reset()
	battle.wave_spawner.get_node("WaveTimer").stop()
	battle.clear_enemies_and_projectiles()
	# A dying colossal awaits this persistent animation before spawning the next
	# wave. Hiding/stopping it leaves that coroutine subscribed: the next case's
	# appearance animation would resume it. Recreate only this scene between
	# trials, retaining the original animation and respawn path within a trial.
	var old_veil = battle.veil_shader
	var new_veil = preload("res://battle/VeilShader.tscn").instantiate()
	new_veil.transform = old_veil.transform
	new_veil.visible = false
	var veil_parent = old_veil.get_parent()
	old_veil.name = "RetiredVeilShader"
	old_veil.queue_free()
	new_veil.name = "VeilShader"
	veil_parent.add_child(new_veil)
	battle.veil_shader = new_veil
	await get_tree().process_frame
	battle.colossal_enemy = null
	for pool_items in battle.pool.objects.values():
		for item in pool_items:
			if is_instance_valid(item):
				item.queue_free()
	battle.pool.objects.clear()
	for ability in PlayerInfo.ability_area.ability_nodes.values():
		ability.reset()
	CPUHelper.throttle_nodes.clear()
	CPUHelper.throttle_nodes_max.clear()
	PlayerInfo.ship = "Titan"
	PlayerInfo.ships.Titan.locked = false
	PlayerInfo.misc_stats.highest_sector_total = input.get("highest_surface", 170)
	PlayerInfo.misc_stats.highest_sector_this_reinforce = input.get("highest_surface", 170)
	if input.has("highest_sectors"):
		VeilController.highest_sector_this_reinforce = input.highest_sectors.duplicate()
		VeilController.highest_sector = input.highest_sectors.duplicate()
	PlayerInfo.cores = []
	var entries: Array = input.candidate.weapons.duplicate(true)
	entries.append(input.candidate.array_core)
	entries.append(input.candidate.shield)
	for entry in entries:
		PlayerInfo.cores.append({"core_id": entry.id, "node": null, "tier": 1})
		PlayerInfo.cores_info[entry.id].locked = false
	PlayerInfo.setup_cores()
	PlayerInfo.core_controller.setup()
	await get_tree().process_frame
	for i in range(entries.size()):
		var core = PlayerInfo.cores[i].node
		core.core_milestones.load_loadout(entries[i].milestones)
		core.do_upgrade(int(entries[i].level))
		if entries[i].has("targeting"):
			core.target_type = entries[i].targeting.type
			core.target_priority = entries[i].targeting.priority
			core.target_swapping = entries[i].targeting.swapping
			core.target_overlap = entries[i].targeting.overlap
	SaveLoad.loading = false
	# Remove baseline progression contributions; the input already contains them.
	for stat in ["titan_damage", "titan_max_shields", "array_capacity", "array_charge_rate"]:
		for node in get_tree().get_nodes_in_group(stat):
			if "specific_core" in node and node.specific_core >= 0:
				continue
			for group in [stat, stat + "_Flat", stat + "_Additive", stat + "_Multiplicative"]:
				if node.is_in_group(group):
					node.remove_from_group(group)
	var profile: Dictionary = input.profile
	var multipliers: Dictionary = profile.layer_multipliers[input.layer]
	_modifier("titan_damage", "Multiplicative", profile.external_combat_multipliers.titan_damage * multipliers.combat)
	_modifier("titan_max_shields", "Multiplicative", profile.external_combat_multipliers.titan_max_shields * multipliers.combat)
	_modifier("titan_damage", "Multiplicative", profile.array_calibration.array_only_multiplier, "array")
	_modifier("array_capacity", "Flat", profile.capacity_before_array_core_milestones_and_layer - db.stat_data.array_capacity.base)
	_modifier("array_capacity", "Multiplicative", multipliers.capacity)
	_modifier("array_charge_rate", "Multiplicative", multipliers.charge_rate)
	UpgradeHelper.calc_all_upgrades()
	for i in range(entries.size()):
		var selected = PlayerInfo.cores[i].node.core_milestones.selected_nodes
		for level in entries[i].milestones:
			if selected.get(str(float(level))) != entries[i].milestones[level]:
				return {"status": "INVALID_SETUP", "reason": "Native milestone selection differs from input"}
	if not is_equal_approx(PlayerInfo.stats.array_capacity, float(input.candidate.array_capacity)):
		return {"status": "INVALID_SETUP", "reason": "Native capacity differs from input"}
	if input.has("expected_array_damage") and not is_equal_approx(PlayerInfo.cores[3].stats[0].damage, float(input.expected_array_damage)):
		return {"status": "INVALID_SETUP", "reason": "Native array damage differs from calibrated input"}
	for core in PlayerInfo.cores:
		initial_core_stats.append({"id": core.core_id, "stats": core.stats[0].duplicate(true),
			"milestones": core.node.core_milestones.selected_nodes.duplicate(true)})
	battle.set_player_ship()
	await get_tree().process_frame
	battle.player_ship.player_died.connect(func(): deaths += 1)
	battle.player_ship.stop()
	battle.player_ship.fill_shields()
	PlayerInfo.titan_array.update_titan_element_list()
	PlayerInfo.titan_array.active_titan_element_list.remove_all_elements()
	for element in input.candidate.sequence:
		PlayerInfo.titan_array.active_titan_element_list.add_titan_element(TitanElement.new(element.id, element.targets), false)
	var array_elements: Array = []
	for element in PlayerInfo.titan_array.active_titan_element_list.get_titan_element_list():
		var saved = element.get_save_data()
		array_elements.append({"id": saved.id, "targets": saved.tpl,
			"on_hit": element.weapon_data.get("on_hit", {}).duplicate(true)})
	if array_elements.size() != input.candidate.sequence.size():
		return {"status": "INVALID_SETUP", "reason": "Native array omitted an element"}
	for i in range(array_elements.size()):
		if array_elements[i].id != input.candidate.sequence[i].id or array_elements[i].targets != input.candidate.sequence[i].targets:
			return {"status": "INVALID_SETUP", "reason": "Native array order or targets differ from input"}
	PlayerInfo.titan_array.reset_charge()
	VeilController.current_layer = int(input.layer_id)
	if input.profile.get("alignment_model", "player_multiplier") == "enemy_reduction":
		# 0.90 calibration reduces native enemy scaling; it no longer buffs the player.
		VeilController.alignment = [0.0, float(profile.alignment.antumbra), float(profile.alignment.penumbra), 0.0]
	# The fixture supplies explicit progression. This is not inferred from sector.
	VeilController.umbra_sector_number = int(input.umbra_sector_number)
	PlayerInfo.upgrades.R156Reintegration.amount_have = int(input.reintegration)
	if "R164Galaxy12" in PlayerInfo.upgrades:
		PlayerInfo.upgrades.R164Galaxy12.amount_have = int(input.get("galaxy12_unlocked", false))
	for upgrade in ["R1Basic", "R2Basic", "R3Basic"]:
		PlayerInfo.upgrades[upgrade].amount_have = 0
	for upgrade in input.prior_reinforcements:
		PlayerInfo.upgrades[upgrade].amount_have = 1
	battle.sector_id = input.sector_id
	battle.sector_number = int(input.sector)
	battle.distance = float(input.distance)
	battle.sector_start_distance = db.sector_data[input.sector_id].distance_starts
	battle.sector_end_distance = db.sector_data[input.sector_id].distance_ends
	PlayerInfo.on_boss = input.mode == "boss_once"
	battle.wave_spawner.current_enemies = 0
	battle.wave_spawner.starting_sector_mults = {"extra_scaling": [0], "capital_scaling": [0], "titan_scaling": [0]}
	battle.wave_spawner.get_node("WaveTimer").stop()
	get_tree().node_added.connect(_on_node_added)
	Engine.time_scale = 1.0
	# Core milestone UI may have changed the time scale during setup.
	# Let the next frame compute its delta at normal speed before starting combat.
	await get_tree().process_frame
	TitanGuard.begin_case(input)
	OS.low_processor_usage_mode = false
	# Do not advance to another sector after a successful research encounter.
	# The native wave path also spawns the small enemies that charge the array.
	# Spawning only the boss model would leave the array permanently empty.
	battle.wave_spawner.start_wave()
	var enemy_scaling: Dictionary = {}
	if input.profile.get("alignment_model", "player_multiplier") == "enemy_reduction":
		enemy_scaling = {
			"effective": battle.wave_spawner.calc_sector_distance_multiplier_specific(input.sector_id, input.distance, false, "titan_scaling", int(input.layer_id), true),
			"before_alignment": battle.wave_spawner.calc_sector_distance_multiplier_specific(input.sector_id, input.distance, false, "titan_scaling", int(input.layer_id), false)}
		if is_instance_valid(battle.colossal_enemy):
			enemy_scaling["initial_disruption_multiplier"] = battle.colossal_enemy.get_disruption_field_multiplier()
	Engine.max_fps = 60
	Engine.time_scale = 1.0
	get_tree().paused = false
	elapsed = 0.0
	processed_frames = 0
	var wall_start := Time.get_ticks_msec()
	var setup_ms := wall_start - setup_start
	var array_shots_start: float = PlayerInfo.misc_stats.get("titan_array_shots", 0)
	var distance_min: float = battle.distance
	var distance_max: float = battle.distance
	var observation_complete := false
	print("TITAN_NATIVE_BATTLE_STARTED: " + str(wall_start))
	while elapsed < float(input.simulation_seconds) and deaths == 0 and not boss_killed and Time.get_ticks_msec() - wall_start < float(input.simulation_seconds) * 2000:
		await get_tree().process_frame
		distance_min = min(distance_min, battle.distance)
		distance_max = max(distance_max, battle.distance)
		for shield in PlayerInfo.shields:
			minimum_shield_fraction = min(minimum_shield_fraction, shield.shields / shield.core.stats[0].max_shields)
		if processed_frames % 60 == 0:
			trace.append({"frame": processed_frames, "charge": PlayerInfo.titan_array.charge,
				"shield": PlayerInfo.shields[0].shields, "kills": colossal_kills,
				"enemies": get_tree().get_nodes_in_group("enemiesNormal").size()})
		if input.has("minimum_seconds") and elapsed >= float(input.minimum_seconds) and colossal_kills >= int(input.minimum_cycles):
			observation_complete = true
			break
	var parts: Array = []
	if is_instance_valid(battle.colossal_enemy):
		for part in battle.colossal_enemy.parts:
			var sections: Array = []
			for section in part.sections:
				sections.append({"type": section.type, "health": section.health, "max_health": section.max_health})
			parts.append({"system": part.system_type, "dead": part.is_dead(), "sections": sections})
	var status := "NATIVE_SMOKE_ONLY"
	var active_abilities: Dictionary = {}
	for ability in PlayerInfo.abilities:
		if PlayerInfo.abilities[ability].active:
			active_abilities[ability] = PlayerInfo.abilities[ability].active_time_left
	if elapsed < float(input.simulation_seconds) and deaths == 0 and not boss_killed and not observation_complete:
		status = "TIMING_STALLED"
	return {"status": status, "mode": input.mode, "seconds": elapsed,
		"enemy_scaling": enemy_scaling,
		"array_elements": array_elements,
		"setup_ms": setup_ms, "seed": input.get("seed"), "rng_calls": TitanGuard.rng_calls.duplicate(),
		"trace": trace,
		"active_abilities_end": active_abilities,
		"processed_frames": processed_frames, "tree_paused": get_tree().paused,
		"battle_wall_seconds": (Time.get_ticks_msec() - wall_start) / 1000.0,
		# Several collisions may emit death twice in one frame. A trial ends at
		# its first death; retain raw signal count separately for diagnostics.
		"deaths": min(deaths, 1), "death_signals": deaths,
		"colossal_kills": colossal_kills, "boss_killed": boss_killed,
		"observation_complete": observation_complete, "kill_times": kill_times,
		"cycle_shield_fractions": cycle_shield_fractions,
		"distance_min": distance_min, "distance_max": distance_max,
		"parts": parts, "minimum_shield_fraction": minimum_shield_fraction,
		"cores": initial_core_stats, "distance": battle.distance,
		"array_capacity": PlayerInfo.stats.array_capacity,
		"array_charge": PlayerInfo.titan_array.charge,
		# Native statistic increments when scheduling a sequence, before impacts.
		"array_shots_scheduled": PlayerInfo.misc_stats.get("titan_array_shots", 0) - array_shots_start,
		"small_enemy_count": get_tree().get_nodes_in_group("enemiesNormal").size(),
		"battle_validated_against_game": false, "determinism_validated": false}

func _modifier(stat: String, kind: String, amount: float, hook: String = "") -> void:
	var node = preload("res://titan_modifier.gd").new()
	add_child(node)
	node.configure(stat, kind, amount, hook)

func _freeze_ui(node: Node, battle: Node) -> void:
	if node == battle or node == PlayerInfo.ability_area:
		return
	node.set_process(false)
	node.set_physics_process(false)
	if node is Timer:
		node.stop()
	for child in node.get_children():
		_freeze_ui(child, battle)

func _on_node_added(node: Node) -> void:
	if node is ColossalEnemy:
		if node.is_boss and node.death.is_connected(PlayerInfo.battle_area.Normal._on_boss_death):
			node.death.disconnect(PlayerInfo.battle_area.Normal._on_boss_death)
		node.death.connect(func():
			colossal_kills += 1
			kill_times.append(elapsed)
			var fraction := 1.0
			for shield in PlayerInfo.shields:
				fraction = min(fraction, shield.shields / shield.core.stats[0].max_shields)
			cycle_shield_fractions.append(fraction)
			if node.is_boss:
				boss_killed = true)
