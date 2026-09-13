"""Summarize completed isolated benchmark runs without modifying raw evidence."""
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNS = ROOT / "results/optimizer_v3"
LABELS = ["before_b12", "final_b12", "before_b13", "final_b13",
          "before_boss_efficiency", "final_boss_efficiency", "before_boss_kill", "final_boss_kill",
          "worker_compare_1", "worker_compare_4", "after_boss_support", "final_b13_workers4", "g1_exhaustive", "g1_exhaustive_realtime"]
BEST_FIELDS = ["outcome", "fleet_resources_used", "fleet_resources_committed", "boss_damage",
               "boss_damage_per_fr", "boss_damage_per_fr_is_infinite", "refined_total_kill_fr",
               "refined_battles_to_kill", "killable_with_current_fr", "kill_sequence",
               "kill_sequence_stop_reason", "formation", "ship_loadouts", "candidate_hash"]


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))



def historical_equal(a, b, key=""):
    # Historical JSON used 14 significant digits and rounded Used FR to cents.
    # This is only for old-file compatibility; fresh clock/worker comparisons are exact.
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(historical_equal(a[k], b[k], k) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(historical_equal(x, y, key) for x, y in zip(a, b))
    if isinstance(a, (float, int)) and isinstance(b, (float, int)):
        return math.isclose(a, b, rel_tol=1e-12, abs_tol=0.005000001 if key == "fleet_resources_used" else 1e-10)
    return a == b


def main():
    rows = []
    for label in LABELS:
        folder = RUNS / label
        if not (folder / "process.json").exists():
            continue
        process = read(folder / "process.json")
        paths = [folder / "fleet_optimizer_v2_result.json", folder / "node.result.json"]
        data = read(next(p for p in paths if p.exists()))
        best = data.get("best_result", {})
        ranked = data.get("ranked_candidates", [])
        measured = max((float(c.get("boss_damage_per_fr", 0)) for c in ranked
                        if isinstance(c.get("boss_damage_per_fr"), (int, float))), default=None)
        row = {"label": label, "status": data.get("result_claim"), "recommendation_status": data.get("recommendation_status"),
               "best": {k: best.get(k) for k in BEST_FIELDS},
               "best_measured_efficiency": measured,
               "best_measured_verified_kill_fr": min((c["refined_total_kill_fr"] for c in ranked if c.get("killable_with_current_fr") and c.get("refined_total_kill_fr") is not None), default=None),
               "simulations": data.get("simulations_used"), "unique_candidates": data.get("unique_results"),
               "cache_hits": data.get("cache_hits"), "deployment_quote_cache_hits": data.get("deployment_quote_cache_hits"),
               "process_wall_seconds": process["process_wall_seconds"], "optimizer_wall_seconds": data.get("wall_time_seconds"),
               "time_to_first_improvement_seconds": data.get("time_to_first_improvement_seconds"),
               "time_to_best_seconds": data.get("time_to_best_seconds"),
               "sampled_old_search_updates": process.get("sampled_search_updates", []),
               "cpu_percent_one_core": None if label == "before_b13" else (process.get("parent_cpu_percent_one_core") if label == "before_boss_efficiency" else process.get("total_cpu_percent_one_core")),
               "logical_processors": process.get("logical_processors"),
               "performance": data.get("performance_breakdown"), "worker_startup": data.get("worker_startup"),
               "output_performance": read(folder / "output_performance.json") if (folder / "output_performance.json").exists() else None,
               "coverage": data.get("coverage"), "finalization_status": data.get("finalization_status"),
               "exit_code": process["exit_code"], "errors": data.get("errors"),
               "input": read(folder / "input.json"), "common": read(folder / "common.json"),
               "source_sha256": process["source_sha256"],
               "raw_result_sha256": hashlib.sha256(next(p for p in paths if p.exists()).read_bytes()).hexdigest()}
        rows.append(row)
    checks = {}
    regression_path = RUNS / "final_regression/optimizer_v3_regression.json"
    if regression_path.exists():
        regression = read(regression_path)
        checks["native_regression"] = {"passed": regression["passed"], "checks": [
            {"label": c["label"], "passed": c["passed"]} for c in regression["checks"]]}
    offline_path = RUNS / "clock_v3_offline/clock_regression_offline_fixed_step.json"
    realtime_path = RUNS / "clock_v3_realtime/clock_regression_realtime.json"
    if offline_path.exists() and realtime_path.exists():
        offline, realtime = read(offline_path), read(realtime_path)
        previous = read(ROOT / "results/clock_regression_offline_fixed_step.json")
        cases = []
        for a, b, c in zip(offline["cases"], realtime["cases"], previous["cases"]):
            cases.append({"label": a["label"], "offline_realtime_identical": a["core"] == b["core"],
                          "previous_core_identical": a["core"] == c["core"],
                          "previous_canonical_sha256_identical": a["canonical_sha256"] == c["canonical_sha256"],
                          "previous_core_equal_at_historical_precision": historical_equal(a["core"], c["core"]),
                          "previous_non_fr_core_identical": {k:v for k,v in a["core"].items() if k != "fleet_resources_used"} == {k:v for k,v in c["core"].items() if k != "fleet_resources_used"},
                          "previous_used_fr": c["core"].get("fleet_resources_used"), "exact_used_fr": a["core"].get("fleet_resources_used"),
                          "events_identical": a["runtime_effect_events"] == b["runtime_effect_events"],
                          "offline_simulation_time": a["simulation_time"], "realtime_simulation_time": b["simulation_time"],
                          "canonical_sha256": a["canonical_sha256"]})
        checks["clock_regression"] = cases
    path = RUNS / "determinism_v3_20/determinism_test.json"
    if path.exists():
        d = read(path)
        checks["determinism"] = {k: d.get(k) for k in ["runs_requested", "runs_completed", "identical_count", "all_identical", "error_count", "comparison_ignored_fields"]}
    worker_paths = [RUNS / f"worker_compare_{n}/fleet_optimizer_v2_result.json" for n in [1, 4]]
    if all(p.exists() for p in worker_paths):
        workers = [read(p) for p in worker_paths]
        fields = ["outcome", "fleet_resources_committed", "fleet_resources_used", "boss_damage", "simulation_time", "enemy_destroyed", "player_remaining_health"]
        canonical = [{c["candidate_hash"]: {k: c.get(k) for k in fields} for c in d["ranked_candidates"]} for d in workers]
        checks["workers"] = {"same_candidate_set": canonical[0].keys() == canonical[1].keys(),
                             "all_core_results_identical": canonical[0] == canonical[1],
                             "candidate_counts": [len(c) for c in canonical]}
    native = {}
    expected = {
        "fleet/FleetBattle.gd": "910ab6b313e207ef7265b59e5473a874e48885c9cd5b43f0581d441440ba2509",
        "fleet/FleetController.gd": "8272f116af9e09f5fbc2e66de95872a4a39ca4aa86ad485fb2e3a09cfd664243",
        "fleet/HazardManager.gd": "31003ecbbd10a19c084d1507d3355354fd4dac1df8eb4659500f1c2e8381b9c5",
        "fleet/ShipDeploymentGroup.gd": "2a962d1a01a8869f48050124f332722c435ca19d4be3c96ed355f8f61f1a2df2",
        "fleet/FleetShip.gd": "10d3c76661bdf13a37aa5429aee037242e48261f94d0581f4acb9a5a64552ad9",
        "fleet/Fleet.gd": "91d3a75256ecae14a0fceecff2b1e39604ec2fa6151bcc3b77ebce7f0be163ba",
        "projectiles/Projectile.gd": "ce16f360c12895a8dd8f3997c449d240a8551ba241b22abc7bc6f9dd0a399a49",
    }
    for name, before in expected.items():
        path = ROOT / "work/full_recovered" / name
        if not path.exists():
            matches = list((ROOT / "work/full_recovered").rglob(Path(name).name))
            path = matches[0]
        after = hashlib.sha256(path.read_bytes()).hexdigest()
        native[path.relative_to(ROOT / "work/full_recovered").as_posix()] = {"before": before, "after": after, "unchanged": before == after}
    checks["original_scripts"] = native
    summary = {"game_version": "0.85.1.0", "godot_version": "4.7.2", "runs": rows, "correctness": checks,
               "notes": ["Only measured completed runs are included.", "Missing old improvement timestamps are unknown, not zero.",
                         "before_b13 CPU unavailable: initial console wrapper measurement was invalid.",
                         "CPU 100% denotes one logical processor.", "No global optimum claim for bounded portfolio or kill_cost."]}
    output = ROOT / "results/optimizer_v3_benchmark_summary.json"
    output.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"runs": len(rows), "correctness_sections": list(checks), "output": str(output)}))


if __name__ == "__main__":
    main()
