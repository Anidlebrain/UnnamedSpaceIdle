extends Node


func analyze(config: Dictionary, allowed_loadouts: Dictionary) -> Dictionary:
	var enemies: Array = []
	var totals := {"shield": 0.0, "armor": 0.0, "hull": 0.0}
	var incoming := {"shield": 0.0, "armor": 0.0, "hull": 0.0}
	var enemy_count := 0
	var shield_enemies := 0
	var armor_enemies := 0
	var boss := false
	for entry in config.get("enemy_fleet", []):
		var ship_id := str(entry.get("ship", ""))
		if ship_id not in db.fleet_ships:
			continue
		var stats: Dictionary = Fleet.get_fleet_ship(ship_id)
		var enemy_mods := Array(entry.get("mods", [])).duplicate()
		for mod_id in _active_tertiary_mods(ship_id, str(config.get("galaxy_id", ""))):
			if mod_id not in enemy_mods:
				enemy_mods.append(mod_id)
		stats = Fleet.apply_ship_mods(stats, enemy_mods)
		var difficulty := float(entry.get("difficulty_override", -1.0))
		if difficulty < 0.0:
			difficulty = float(config.get("enemy_difficulty", 1.0))
		stats = Fleet.get_ship_stats_based_on_galaxy(stats, difficulty, str(config.get("galaxy_id", "")))
		var ship: Dictionary = stats.ship
		var count := int(stats.get("deployment_columns", 1)) * int(stats.get("deployment_rows", 1))
		var health := float(ship.get("health_scale", 0.0))
		var shield := health * float(ship.get("shield_ratio", 0.0))
		var physical := maxf(0.0, health - shield)
		var armor := physical if bool(ship.get("armored", false)) else 0.0
		var hull := 0.0 if armor > 0.0 else physical
		enemy_count += count
		totals.shield += shield * count
		totals.armor += armor * count
		totals.hull += hull * count
		if shield > 0.0:
			shield_enemies += count
		if armor > 0.0:
			armor_enemies += count
		var weapons: Array = []
		for mount in ship.get("weapons", []):
			var weapon: Dictionary = mount.weapon
			weapons.append(_weapon_summary(weapon, float(ship.get("damage_scale", 1.0))))
			var weapon_weight := float(weapon.get("damage", 0.0)) * float(ship.get("damage_scale", 1.0)) * float(weapon.get("fire_rate", 1.0)) * count
			incoming.shield += float(weapon.get("shield_damage", 1.0)) * weapon_weight
			incoming.armor += float(weapon.get("armor_damage", 1.0)) * weapon_weight
			incoming.hull += float(weapon.get("hull_damage", 1.0)) * weapon_weight
		var is_command := str(stats.get("class", "")) == "command"
		boss = boss or is_command
		enemies.append({
			"ship_id": ship_id,
			"name": stats.get("name", ship_id),
			"count": count,
			"difficulty": difficulty,
			"position": entry.get("grid_position", []),
			"mods": Array(entry.get("mods", [])).duplicate(),
			"shield": shield,
			"armor": armor,
			"hull": hull,
			"weapons": weapons,
			"command_ship": is_command,
		})

	var hazard_types: Array[String] = []
	var hazard_tags: Array[String] = []
	var hazard_mechanics: Array = []
	var reinforcement := false
	var hazard_details: Array = config.get("resolver", {}).get("hazard_details", [])
	for detail in hazard_details:
		for definition in detail.get("definition", []):
			var hazard_type := str(definition.get("type", "unknown"))
			if hazard_type not in hazard_types:
				hazard_types.append(hazard_type)
			var tags := _hazard_tags(definition)
			for tag in tags:
				if tag not in hazard_tags:
					hazard_tags.append(tag)
			hazard_mechanics.append({"type": hazard_type, "tags": tags, "definition": definition.duplicate(true)})
			reinforcement = reinforcement or hazard_type == "reinforcements" or definition.has("reinforcement_details")

	var support_tags: Array[String] = []
	var support_mechanics: Array = []
	var support_details: Array = config.get("resolver", {}).get("support_details", [])
	for detail in support_details:
		for definition in detail.get("definition", []):
			var support_type := str(definition.get("type", "unknown"))
			var tags := _hazard_tags(definition)
			for tag in tags:
				if tag not in support_tags:
					support_tags.append(tag)
			support_mechanics.append({
				"node": detail.get("node", ""),
				"fleet_event_id": detail.get("fleet_event_id", ""),
				"type": support_type,
				"tags": tags,
				"definition": definition.duplicate(true),
			})
			reinforcement = reinforcement or support_type == "reinforcements" or definition.has("reinforcement_details")

	var loadout_analysis := {}
	for ship_type in allowed_loadouts:
		loadout_analysis[ship_type] = []
		for loadout in allowed_loadouts[ship_type]:
			loadout_analysis[ship_type].append(_analyze_loadout(ship_type, loadout, totals, enemy_count, str(config.get("galaxy_id", ""))))
		loadout_analysis[ship_type].sort_custom(func(a, b): return float(a.counter_score) > float(b.counter_score))

	return {
		"source": "original runtime DB via Fleet.get_fleet_ship/apply_ship_mods/get_ship_stats_based_on_galaxy",
		"enemy_count": enemy_count,
		"enemy_deployment_groups": enemies.size(),
		"enemy_ship_types": enemies.map(func(item): return item.ship_id),
		"shield_enemies": shield_enemies,
		"armor_enemies": armor_enemies,
		"defense_totals": totals,
		"enemy_weapon_characteristics": incoming,
		"enemy_details": enemies,
		"boss": boss,
		"reinforcement": reinforcement,
		"active_hazard_types": hazard_types,
		"hazard_tags": hazard_tags,
		"hazard_mechanics": hazard_mechanics,
		"support_details": support_details.duplicate(true),
		"support_tags": support_tags,
		"support_mechanics": support_mechanics,
		"grid": config.get("grid_size", [2, 5]),
		"preferred_offense_tags": _descending_tags(totals),
		"preferred_defense_tags": _descending_tags(incoming),
		"loadout_counter_analysis": loadout_analysis,
	}


func counter_score(ship_type: String, loadout_id: String, analysis: Dictionary) -> float:
	for item in analysis.get("loadout_counter_analysis", {}).get(ship_type, []):
		if str(item.loadout_id) == loadout_id:
			return float(item.counter_score)
	return 0.0


func _analyze_loadout(
	ship_type: String,
	loadout: Dictionary,
	enemy_defense: Dictionary,
	enemy_count: int,
	galaxy_id: String,
) -> Dictionary:
	var mods: Array = []
	for key in ["primary_mod", "secondary_mod"]:
		var mod_id = loadout.get(key)
		if mod_id != null and str(mod_id) != "":
			mods.append(str(mod_id))
	for mod_id in _active_tertiary_mods(ship_type, galaxy_id):
		if mod_id not in mods:
			mods.append(mod_id)
	var stats: Dictionary = Fleet.get_fleet_ship(ship_type)
	stats = Fleet.apply_ship_mods(stats, mods)
	var ship: Dictionary = stats.ship
	var score := 0.0
	var weapons: Array = []
	var total_defense := maxf(1.0, float(enemy_defense.shield) + float(enemy_defense.armor) + float(enemy_defense.hull))
	for mount in ship.get("weapons", []):
		var weapon: Dictionary = mount.weapon
		weapons.append(_weapon_summary(weapon, float(ship.get("damage_scale", 1.0))))
		var weighted := (
			float(enemy_defense.shield) * float(weapon.get("shield_damage", 1.0))
			+ float(enemy_defense.armor) * float(weapon.get("armor_damage", 1.0))
			+ float(enemy_defense.hull) * float(weapon.get("hull_damage", 1.0))
		) / total_defense
		var targets := mini(maxi(1, int(weapon.get("max_targets", 1))), maxi(1, enemy_count))
		score += weighted * targets * float(weapon.get("damage", 0.0)) * float(weapon.get("fire_rate", 1.0))
	return {
		"loadout_id": str(loadout.get("id", "none")),
		"mods": mods,
		"counter_score": score,
		"weapons": weapons,
		"durability": {
			"health_scale": ship.get("health_scale", 0.0),
			"shield_ratio": ship.get("shield_ratio", 0.0),
			"armored": ship.get("armored", false),
			"damage_block_health_percent": ship.get("damage_block_health_percent", 0.0),
		},
	}


func _weapon_summary(weapon: Dictionary, damage_scale: float) -> Dictionary:
	return {
		"id": weapon.get("id", ""),
		"damage": float(weapon.get("damage", 0.0)) * damage_scale,
		"fire_rate": weapon.get("fire_rate", 0.0),
		"range": weapon.get("max_range", 0.0),
		"max_targets": weapon.get("max_targets", 1),
		"hull_multiplier": weapon.get("hull_damage", 1.0),
		"armor_multiplier": weapon.get("armor_damage", 1.0),
		"shield_multiplier": weapon.get("shield_damage", 1.0),
		"burst_fire": weapon.get("burst_fire", 1),
		"tick_rate": weapon.get("tick_rate", 0.0),
		"num_ticks": weapon.get("num_ticks", 0),
	}


func _descending_tags(values: Dictionary) -> Array[String]:
	var tags: Array[String] = ["shield", "armor", "hull"]
	tags.sort_custom(func(a, b): return float(values[a]) > float(values[b]))
	return tags


func _hazard_tags(definition: Dictionary) -> Array[String]:
	# These are the exact type branches implemented by recovered HazardManager.gd.
	match str(definition.get("type", "")):
		"damage_per_second":
			return ["periodic", "direct_damage", "all_targets"]
		"laser_volley":
			return ["periodic", "projectile", "positional_targeting", "nearest_targets"]
		"damage_wave":
			return ["periodic", "projectile", "positional_wave"]
		"reinforcements":
			return ["timed_event", "reinforcement"]
		"grid_buff":
			return ["grid_buff", "positional"]
	return ["other"]


func _active_tertiary_mods(ship_id: String, galaxy_id: String) -> Array:
	var result: Array = []
	var ship_state: Dictionary = Fleet.get_fleet_ship_dict(ship_id)
	for mod_id in ship_state.get("mods", {}):
		if mod_id in db.fleet_mods and int(db.fleet_mods[mod_id].slot) == Fleet.ModSlot.TERTIARY:
			var scope := str(ship_state.mods[mod_id])
			if scope == "all" or scope == galaxy_id:
				result.append(str(mod_id))
	return result
