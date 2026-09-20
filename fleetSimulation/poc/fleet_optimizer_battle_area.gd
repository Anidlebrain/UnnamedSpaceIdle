extends Node


var pool: Pool


func _ready() -> void:
	pool = Pool.new()
	pool.name = "OptimizerProjectilePool"
	pool.scene = self
	add_child(pool)
	PlayerInfo.battle_area["Normal"] = self


func set_active(_active: bool) -> void:
	pass


func _exit_tree() -> void:
	if PlayerInfo.battle_area.get("Normal") == self:
		PlayerInfo.battle_area.erase("Normal")
