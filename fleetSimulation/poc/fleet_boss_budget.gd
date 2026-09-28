extends RefCounted
## Scheduling estimates never replace native battles or the native FR ledger.


static func estimate(candidate: Dictionary, wallet: float, hp: float, limit: int) -> Dictionary:
	var committed := float(candidate.get("deployment_quote_committed_fr", candidate.get("fleet_resources_committed", 0.0)))
	var used := maxf(0.0, float(candidate.get("fleet_resources_used", 0.0)))
	var damage := maxf(0.0, float(candidate.get("boss_damage", 0.0)))
	var battles := 0
	var remaining := wallet
	var spent := 0.0
	# Fleet.battle_complete debits floor(Used FR). Check deployment separately:
	# a refund after a fight cannot finance that fight's initial deployment.
	while battles < limit and damage > 0.0 and NumberUtils.fleet_less_or_equal(committed, remaining):
		if not NumberUtils.fleet_less_or_equal(spent + used, wallet):
			break
		battles += 1
		spent += used
		remaining -= floorf(used)
		if damage * battles >= hp:
			break
	return {"battles": battles, "damage": minf(hp, damage * battles), "spent": spent}


static func before(a: Dictionary, b: Dictionary) -> bool:
	if b.is_empty():
		return not a.is_empty()
	if a.is_empty():
		return false
	var ak: bool = a.get("killable_with_current_fr", false) == true
	var bk: bool = b.get("killable_with_current_fr", false) == true
	if ak != bk:
		return ak
	if not ak and float(a.campaign_boss_damage) != float(b.campaign_boss_damage):
		return float(a.campaign_boss_damage) > float(b.campaign_boss_damage)
	if float(a.refined_fr_spent) != float(b.refined_fr_spent):
		return float(a.refined_fr_spent) < float(b.refined_fr_spent)
	if a.kill_sequence.size() != b.kill_sequence.size():
		return a.kill_sequence.size() < b.kill_sequence.size()
	return str(a.get("campaign_key", a.formation_key)) < str(b.get("campaign_key", b.formation_key))


static func finish(candidate: Dictionary, hp: float, remaining: float, spent: float, sequence: Array, reason: String, starting_hp: float) -> void:
	var killed := hp <= 0.0
	candidate.kill_cost_resource_policy = "current_resources"
	candidate.killable_with_current_fr = killed
	candidate.killable_with_per_battle_fr = killed
	candidate.kill_sequence = sequence
	candidate.kill_sequence_stop_reason = reason
	candidate.kill_refined = reason in ["boss_killed", "insufficient_committed_fr", "boss_damage_not_positive", "total_fr_exceeds_current_fr"]
	candidate.boss_final_hp = hp
	candidate.campaign_boss_damage = maxf(0.0, starting_hp - hp)
	candidate.campaign_battles = sequence.size()
	candidate.campaign_remaining_fr = remaining
	candidate.refined_fr_spent = spent
	candidate.refined_total_kill_fr = spent if killed else null
	candidate.total_kill_fr = candidate.refined_total_kill_fr
	candidate.refined_battles_to_kill = sequence.size() if killed else null
	candidate.battles_to_kill = candidate.refined_battles_to_kill
	candidate.remaining_fr_after_kill = remaining if killed else null
	candidate.failed_before_battle = null if killed else sequence.size() + 1
	var keys: Array[String] = []
	for battle in sequence:
		keys.append(str(battle.get("formation_key", candidate.formation_key)))
	candidate.campaign_key = "|".join(keys).sha256_text()
