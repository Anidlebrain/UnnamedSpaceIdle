extends Node

const Budget = preload("res://fleet_boss_budget.gd")
var checks: Array = []

# Deterministic test battle responses exercise the scheduler, not the game's
# combat rules. Native combat and settlement have separate integration tests.
class TestProbe extends Node:
	var native: Node
	func native_fr_settlement(galaxy: String, available: float, used: float) -> Dictionary:
		return native.native_fr_settlement(galaxy, available, used)
	func run_battle(config: Dictionary) -> Dictionary:
		var ship: String = config.formation[0].ship
		var hp := float(config.boss_health)
		var damage := 65.0 if ship == "Cruiser" else (30.0 if ship == "Frigate" else (35.0 if hp <= 35 else 10.0))
		var committed := 70.0 if ship == "Cruiser" else (25.0 if ship == "Frigate" else 30.0)
		return {"outcome": "victory" if hp <= damage else "lose", "boss_damage": minf(hp, damage),
			"fleet_resources_committed": committed, "fleet_resources_used": committed - 10.0 if hp <= damage else committed,
			"performance_breakdown": {}}
	func cleanup_battle() -> Dictionary:
		return {}


func check(label: String, passed: bool, evidence = null) -> void:
	checks.append({"label": label, "passed": passed, "evidence": evidence})
	print("BUDGET_REGRESSION %s %s" % [label, "PASS" if passed else "FAIL"])


func candidate(key: String, committed: float, damage: float, ship: String = "Cruiser") -> Dictionary:
	return {"formation_key": key, "candidate_hash": key, "formation": [{"ship": ship, "position": "A1", "grid_position": [0, 0]}],
		"ship_loadouts": {}, "deployment_quote_committed_fr": committed, "fleet_resources_committed": committed,
		"fleet_resources_used": committed, "boss_damage": damage, "outcome": "lose", "error": ""}


func setup(probe: Node) -> Node:
	var optimizer := preload("res://fleet_optimizer_search.gd").new()
	add_child(optimizer)
	optimizer._probe = probe
	optimizer._requested_boss_priority = "affordable_kill_cost"
	optimizer.objective = "boss"
	optimizer.boss_priority = "kill_cost"
	optimizer.boss_remaining_hp = 100.0
	optimizer._base_config = {"fleet_resources": 100.0, "galaxy_id": "galaxy5"}
	optimizer._settings = {"max_simulations": 1000, "max_wall_seconds": 3600.0,
		"kill_sequence_max_battles": 10, "simulation_detail": "summary"}
	optimizer._started_msec = Time.get_ticks_msec()
	optimizer._pruning_stats = {"simulated": 0}
	optimizer._finalizing = true
	return optimizer


func run(native: Node) -> Dictionary:
	var expensive := candidate("heavy", 70, 65)
	var stronger := candidate("strong", 95, 90)
	var cheap := candidate("cheap", 30, 38)
	check("70 percent deployment allows only one identical fight", Budget.estimate(expensive, 100, 100, 100).battles == 1)
	var refunded := expensive.duplicate(true)
	refunded.fleet_resources_used = 40.0
	check("deployment blocks second fight despite affordable Used FR", Budget.estimate(refunded, 100, 100, 100).battles == 1)
	check("cheap formation explores three fights", Budget.estimate(cheap, 100, 200, 100).battles == 3)
	var free := cheap.duplicate(true)
	free.fleet_resources_used = 0.0
	check("zero debit has bounded exploration", Budget.estimate(free, 100, 100000, 7).battles == 7)
	var fractional := candidate("fractional", 10.9, 1)
	check("raw cumulative FR is checked in addition to rounded ledger", Budget.estimate(fractional, 100, 1000, 100).battles == 9)
	var probe := TestProbe.new()
	probe.native = native
	add_child(probe)
	var optimizer := setup(probe)
	check("stronger one-shot beats stranded efficiency", optimizer._schedule_before(stronger, expensive))
	check("multiple affordable hits can outrank a one-shot", optimizer._schedule_before(cheap, stronger))
	var first: Dictionary = optimizer._extend_campaign({}, expensive, expensive)
	var better: Dictionary = optimizer._extend_campaign({}, stronger, stronger)
	check("no-kill recommendation prefers verified damage", Budget.before(better, first))
	expensive.current_fr_result = first
	optimizer._budget_parents = {"heavy": expensive}
	check("stranded wallets keep time for one-shot search", not optimizer._campaign_may_continue())
	var finisher := candidate("finisher", 30, 10, "Fighter")
	optimizer._damage_best = expensive
	optimizer._budget_parents = {"cheap": finisher, "heavy": expensive}
	check("an affordable different finisher enables sequence reserve", optimizer._campaign_may_continue())
	await optimizer._search_affordable_campaigns([expensive, finisher])
	var best: Dictionary = optimizer._campaign_best
	check("mixed affordable formation sequence kills", best.get("killable_with_current_fr") == true and best.kill_sequence.size() == 2, best)
	check("last battle refund sets native total cost", is_equal_approx(float(best.get("refined_fr_spent", 0)), 90.0) and best.campaign_remaining_fr == 10.0)
	check("each battle retains its executable formation", best.kill_sequence[0].formation[0].ship == "Cruiser" and best.kill_sequence[1].formation[0].ship == "Fighter")
	expensive.current_fr_result = best
	check("completed sequence preserves first-prefix branching opportunities", optimizer._campaign_may_continue())
	var expensive_kill := best.duplicate(true)
	expensive_kill.refined_fr_spent = 99.0
	check("verified kills prefer lower actual cumulative cost", Budget.before(best, expensive_kill) and Budget.before(expensive_kill, better))
	var repeated := candidate("repeated", 25, 30, "Frigate")
	var repeated_optimizer := setup(probe)
	await repeated_optimizer._refine_affordable_candidate(repeated)
	check("N identical fights preserve HP and resources", repeated.current_fr_result.killable_with_current_fr == true and repeated.current_fr_result.campaign_battles == 4 and repeated.current_fr_result.refined_fr_spent == 90.0, repeated.current_fr_result)
	var short_optimizer := setup(probe)
	short_optimizer._settings.max_simulations = 0
	expensive.erase("current_fr_result")
	await short_optimizer._refine_affordable_candidate(expensive)
	check("exhausted simulation budget retains verified first hit", short_optimizer._campaign_best.campaign_boss_damage == 65 and short_optimizer._simulations == 0)
	var overrun := finisher.duplicate(true)
	overrun.fleet_resources_used = 30.5
	check("cumulative raw cost cannot exceed initial resources", optimizer._extend_campaign(first, finisher, overrun).is_empty())
	var before: int = optimizer._simulations
	await optimizer._search_affordable_campaigns([expensive, finisher])
	check("same HP/wallet/formation reuses battle cache", optimizer._simulations == before)
	return {"passed": checks.all(func(item): return item.passed), "checks": checks}
