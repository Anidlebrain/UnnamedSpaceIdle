extends Node
## Small deterministic search checks. No battle, network, or saved-game writes.
var checks: Array = []


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
	var passed := true
	for item in checks:
		passed = passed and item.passed
	return {"passed": passed, "checks": checks}
