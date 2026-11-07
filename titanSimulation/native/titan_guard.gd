extends Node

var blocked_http_nodes := 0
var isolated := false
var seeded := false
var case_seed := 0
var rng_calls: Dictionary = {}
var frame_origin := 0

func begin_case(input: Dictionary) -> void:
	seeded = input.has("seed")
	case_seed = int(input.get("seed", 0))
	rng_calls.clear()
	frame_origin = Engine.get_process_frames()
	if seeded:
		seed(case_seed)

func seed_rng(rng: RandomNumberGenerator, site: String) -> void:
	if not seeded:
		rng.randomize()
		return
	var ordinal: int = rng_calls.get(site, 0)
	rng_calls[site] = ordinal + 1
	rng.seed = case_seed ^ int(site.hash()) ^ ((ordinal + 1) * 1000003)

func process_frame() -> int:
	if seeded:
		return Engine.get_process_frames() - frame_origin
	return Engine.get_process_frames()

func _enter_tree() -> void:
	var expected := str(ProjectSettings.get_setting("titan_research/user_dir"))
	if OS.get_user_data_dir().replace("\\", "/").simplify_path() != expected:
		push_error("Titan user directory is not isolated: " + OS.get_user_data_dir())
		get_tree().quit(40)
		return
	get_tree().node_added.connect(_on_node_added)
	isolated = true
	print("TITAN_ISOLATED_USER_DIR: " + OS.get_user_data_dir())

func _on_node_added(node: Node) -> void:
	if node is HTTPRequest:
		node.set_http_proxy("127.0.0.1", 9)
		node.set_https_proxy("127.0.0.1", 9)
		blocked_http_nodes += 1
