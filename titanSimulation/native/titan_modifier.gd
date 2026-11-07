extends Node

# Aggregate player input at the same modifier boundary used by PlayerInfo.
var stats: Dictionary
var amount_have := 1
var specific_core := -1
var fake := false
var has_changed := false

func configure(target: String, kind: String, amount: float, hook: String = "") -> void:
	stats = {"name": "Titan research aggregate", "effect": [{
		"target": target, "modifier_type": kind, "total_effect": amount,
		"global_hook": hook, "base_effect": amount, "direct_connection": "",
		"direct_connection2": "", "expression": "", "self_multiplicative": false,
	}]}
	add_to_group(target)
	add_to_group(target + "_" + kind)

func calc_total_effect(effect: Dictionary) -> float:
	return float(effect.total_effect)

func get_name_prefix() -> String:
	return "Research "
