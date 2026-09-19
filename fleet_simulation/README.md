# Fleet Battle 原生模拟复用

## 当前日常 Optimizer：v3

日常入口已切换为 `poc/fleet_optimizer_search.gd`。普通战按 **WIN → 最低真实 Used FR** 排名；Boss 使用现有 `boss.priority: "efficiency" | "kill_cost"`。Efficiency 允许 LOSS；Kill Cost 只推荐完成原版连续战斗并逐场支付得起 committed FR 的方案。

必须提供 `baseline.enabled: true`、formation 和 loadouts。启动先验证 Baseline：普通战必须 WIN，Boss 必须 `boss_damage > 0`，否则输出 **BASELINE VALIDATION FAILED** 并停止；不会进入 Recovery。Baseline 是参考上界，并不限制全局 composition 的生成。

日常只需 `"search": {"profile": "fast"}`，默认单 worker、300 秒（含 Godot 初始化）。Balanced 增加全局探索比例；已有显式时间、worker 和 simulation 上限仍兼容。收尾预留真实重跑与 Boss 序列时间，当前战斗会完成，极慢战斗可能略超预算。`beat_baseline` 字段兼容，但仍尽量搜索到预算结束。Exhaustive 只用于受限空间验证；只有确实完成全部配置空间的普通战/效率搜索才显示 EXHAUSTIVE BEST。

新流程交错生成全局 composition、档案候选和当前优胜方案的变体，移除了日常路径中的 Beam/Probe 截断与 Smart Prune。**BEST FOUND / TIME BUDGET REACHED 均不代表全局最优。** 详细算法、原版语义、性能拆解、回归与前后对照见 [optimizer_v3_report.md](docs/optimizer_v3_report.md)。下文的 v2 搜索描述和结果保留作历史记录。

## Daily Usage（日常使用）

map/ 是本机输入目录，已加入 Git 忽略；从远端克隆后需在本机自行准备 Galaxy/Node JSON 和 common.json。

1. 编辑 `map/<galaxy>/<node>.json` 和同目录的 `common.json`。
2. 运行 `run_optimizer.bat g6 B21`。
3. 等待本机搜索完成。
4. 查看控制台中的输入、解析、搜索预算和最优结果摘要。
5. 查看 `map/g6/B21.result.txt`，需要完整结构化数据时查看 `map/g6/B21.result.json`；`results/latest.json` 和 `results/latest.txt` 继续作为兼容调试输出。

运行 `run_optimizer.bat g6 B21 --copy`（短别名 `--c`，大小写不敏感）可将 `map/g6/B21.result.txt` 中推荐的阵型和 Mod 配置写回 `map/g6/B21.json` 的 `baseline`。复制模式只更新结果，不启动 Godot 优化器；它同时兼容英文舰种/Mod ID 和数字格式的结果文本。解析或校验失败时不会改写 JSON。

Friendly Config 的舰种既可沿用英文名，也可使用数字：`1=Fighter`、`2=Corvette`、`3=Frigate`、`4=Cruiser`、`5=Heavy Cruiser`。`baseline.formation`（以及 diagnostic candidate 的 formation）可以把 A1–B5 全部写出，空位使用 `0` 或 `null`。`player_state.ships` 与 `loadouts` 的键也兼容字符串数字键 `"1"`–`"5"`。

`primary` / `secondary` 可以沿用内部 Mod ID，也可使用数字索引：`0` 表示不使用，`1` 表示该槽位在 `poc/optimizer_v2_daily.json` 中的第一个 Mod，未来存在第二个 Mod 时使用 `2`。越界索引会直接报错，不会静默替换。数字格式输入文件可使用 `<node>_num.json`，例如 `run_optimizer.bat g6 B16_num` 会读取 `B16_num.json`，校验其中的 `node: "B16"`，并仍输出 `B16.result.json` / `B16.result.txt`。TXT 中推荐舰种、阵型和两个 Mod 槽位均使用同一数字表示，空阵位显示为 `0`。

日常使用不需要 Codex。模拟和优化完全在本机 Godot 中运行，不会消耗 Codex token。用户只填写 Friendly Config；Fleet Event、Battle、敌舰、Hazard、Support 和 Command Ship 等内部 ID 继续由 Resolver 从原版数据解析。

`run_optimizer.bat` 根据 Galaxy 和 Node 参数读取 `map/<galaxy>/<node>.json`，不写死 G6。Galaxy 公共倍率来自同目录 `common.json`：`permanent` 是长期最终倍率，`temporary` 是手工加算增量，`effective = permanent + temporary`；节点文件不再保存这两个 scale。使用已验证的 Godot 4.7.2 隔离测试工程，并采用当前已确认解锁的 Standard Galaxy Mod 集合。Fast / Balanced 默认使用 `offline_fixed_step`；Runner 通过 Godot 官方 `--fixed-fps 60` 关闭墙钟同步，但仍逐 tick 执行原版 60 Hz physics。可把 `search.simulation_clock` 改为 `realtime` 做 Reference / Debug。配置或 Baseline 验证失败时命令返回非零退出码，且不会覆盖已有的节点 JSON/TXT 或兼容 `latest` 输出。

普通节点的正式 `<node>.result.json` 只保留现有排序逻辑选出的 `best_result`，内部搜索和兼容的 `results/latest.json` 仍可包含多候选。Boss 节点继续保留 Top、refinement 和 ranked candidate 结构。加上 `--verbose` 可实时查看完整 Godot 输出；普通模式只折叠已确认不影响战斗的 Shader 编译器断言和固定退出清理摘要，原始输出始终写到 `map/<galaxy>/<node>.godot.log`，其他错误不会被过滤。

目标是把《Unnamed Space Idle》自身的 Fleet Battle Practice 逻辑封装成可重复调用的模拟接口，而不是重写战斗规则。

当前结论：应复用完整 `FleetBattle.tscn` 和 `FleetController` 物理帧驱动，不能把现有实现当作纯逻辑类直接调用。正式 Galaxy 战斗、Practice 和 Advisor Validate 已确认共用同一个场景与状态机；外部 JSON 驱动的参数化 PoC 已在官方 Godot 4.7.2 中实际跑通，并完成同配置 20 次一致性验证。

## 目录

- `docs/fleet_simulator_feasibility.md`：第一阶段源码侦察与原生单场可行性证据
- `docs/battle_config_and_determinism.md`：Battle Config 映射、隐藏依赖、20 次验证和玩家 A/B 最小输入
- `docs/overdeploy_source_of_truth.md`：0.85.1.0 正式 Overdeploy 成本、availability 与 FR 结算源码依据
- `poc/battle_config.json`：显式、可外部替换的 Battle Config 示例
- `poc/ui_ab_test_01_config.json`：第一场真实 UI Practice A/B 输入
- `poc/ui_ab_test_02_config.json`：第二场真实 UI Practice A/B 输入（Galaxy 5 B30 Hazard）
- `poc/ui_ab_test_03_config.json`：第三场真实 UI Practice A/B 输入（Galaxy 5 BB3 Boss）
- `poc/fleet_test.gd`：参数化 `run_battle(config)` 适配器；`run_demo()` 仅构造兼容示例
- `poc/fleet_optimizer_bootstrap.tscn` / `poc/fleet_optimizer_battle_area.gd`：Optimizer 专用最小启动场景和原版 Projectile Pool 接口
- `poc/fleet_optimizer.gd`：v1 固定舰队的唯一位置精确枚举与公共评分
- `poc/fleet_optimizer_search.gd`：v3 日常调度、严格 Baseline、真实目标、预算及连续 Boss 验证
- `tools/benchmark_optimizer.py`：隔离真实 Godot 基准、进程 CPU 与源码哈希
- `poc/fleet_optimizer_v2.gd`：保留公共运行服务及历史 v2 算法；v2 舰种级 Loadout、舰种数量、代表阵型、Fleet/Position Beam、局部精确搜索与全局缓存
- `poc/friendly_config_resolver.gd`：把日常 `galaxy + node + hazards + supports + boss.remaining_hp + player_state` 输入解析为原版 Battle Config
- `poc/optimizer_v2_bb3_regression.json`：只使用已确认 Cruiser Loadout 的 BB3 v1 兼容回归设置
- `poc/fleet_test_runner.gd`：等待原版初始化、拦截 HTTP、执行单场或确定性测试、写 JSON 并退出的薄 Runner
- `map/g6/common.json`：Galaxy 6 的 permanent / temporary 公共倍率
- `map/g6/B8.json` / `map/g6/B21.json`：不含公共倍率的节点配置
- `tools/run_godot_optimizer.ps1`：Windows PowerShell 5.1 兼容的 Godot 进程、日志和退出码适配器
- `results/fleet_test_result.json`：Godot 4.7.2 实际单场运行结果
- `results/determinism_test.json`：相同 Config 连续 20 场的规范化比较结果
- `results/ui_ab_test_01.json`：第一场真实 UI Practice A/B 的完整 Runner 结果
- `results/ui_ab_test_02.json`：第二场真实 UI Practice A/B 的完整 Runner 结果
- `results/ui_ab_test_03.json`：第三场真实 UI Practice A/B 的完整 Runner 结果
- `results/optimizer_v1_bb3.json`：v1 的 252 个 BB3 位置完整结果
- `results/optimizer_v2_bb3_regression.json`：v2 分层搜索与 252/252 精确子空间回归结果
- `results/optimizer_v2_bb3_fixed_regression.json`：最终适配器代码上的固定 CruiserSingleArmorTank 252/252 回归
- `results/optimizer_v2_overdeploy_tests.json`：原版部署报价 A–E 与 BB3 回归 F
- `results/friendly_config_regression.json`：B30/BB3 Resolver、Boss HP 边界、BB3 基准与纯排序回归
- `results/support_config_regression.json`：G6 B8 的 B10 Hazard + F2 Support 解析、原版运行时行为与空 Supports 对照
- `results/clock_regression_realtime.json` / `clock_regression_offline_fixed_step.json`：四个固定 Candidate 的 Realtime / Offline 核心结果与事件顺序 A/B
- `results/determinism_offline_fixed_step_bb3_20.json`：BB3 Offline Fixed Step 20/20 一致性
- `results/performance_benchmark_b35_offline_fixed_step.json`：固定 B35 Candidate 的 10 次 Offline 性能分解
- `results/optimizer_v2_boss_objective_regression.json`：Boss projected/refined kill cost 的真实三战回归
- `results/optimizer_v2_boss_affordability_regression.json`：逐战 committed FR 不足时停止的回归
- `work/recovered_scripts/`：从原版 PCK 备份仅恢复出的脚本与恢复日志
- `work/recovered_data/`：从同一备份仅提取出的 `game_data.cdb` 与提取日志
- `work/full_recovered/`：完整恢复工程，仅用于本机隔离运行验证

`work/` 只用于本机分析。测试使用独立 `user://`，未读取或修改正式存档；没有构建、安装或替换任何 PCK，也没有修改 Steam 游戏目录。

## 当前验证状态

完整恢复工程已由 Godot 4.7.2 官方版加载。固定输入去掉真实 tick 时间后的要求字段为 **20/20 identical**，普通、Hazard、Boss 三场真实 UI Practice A/B 均已通过。Realtime / Offline Fixed Step 四场 canonical 结果一致；额外 G6 B8 回归确认 F2 在模拟 1.0 秒开始 1.0 秒的 reinforcement spawning（总计 2.0 秒），B10 laser volley 在 2.5 秒触发且顺序一致。

Optimizer v2 仍只调用已验证的 `run_battle(config)` 评分。Loadout 是舰种级变量：同一候选内，一个舰种的所有 deployment groups 共用一套 Primary/Secondary 选择；两个槽独立做笛卡尔积，`null` 是合法选项。Standard Galaxy Tertiary 继续由原版 `Fleet.get_ship_mods()` 按 Galaxy scope 自动加入，不参与手动枚举。

v2 设置使用 `allowed_mod_slots`、`group_ranges`、`player_state`、`max_simulations` 和 `max_wall_seconds`。例如：

```json
{
  "allowed_mod_slots": {
    "Corvette": {
      "primary": [null, "CorvetteChargeLaserMod"],
      "secondary": [null, "ShieldMod"]
    }
  },
  "player_state": {
    "fleet_resources": 950.0,
    "ships": {
      "Corvette": {"enabled": true, "available": 1}
    }
  }
}
```

`realistic` 允许正式 Overdeploy；`available` 是正常数量而非上限，`enabled=false` 或 `available=0` 才禁用舰种。Composition 的 committed FR 通过完整原版 FleetBattle Scene 的 `calc_total_deployment()` 报价，超出 `player_state.fleet_resources` 时在 Battle 前剪枝。Runner 参数为 `--optimizer-v2=res://optimizer_v2_config.json`，完整结果写入 `user://fleet_optimizer_v2_result.json`。

Friendly Config 不填写内部 event/battle/enemy/hazard/support/command-ship ID；Resolver 从当前原版运行时 DB 与 FleetEvent 解析。`hazards` 和 `supports` 是互相独立的节点名数组；未列出的节点不启用，并且每个源节点必须真实作用于当前 Galaxy 的目标 Battle。使用 `--friendly-config=res://friendly.json` 会先写 `user://resolved_g<galaxy>_<node>_config.json`；与 `--optimizer-v2=...` 同时使用时，解析出的 `normal` 或 Boss `efficiency` / `kill_cost` 目标会覆盖设置文件中的目标。Boss 输入使用当前 `remaining_hp`，严格校验 `0 < remaining_hp <= command_ship_original_health`，不做 clamp。

Boss 结果同时保留单场 `boss_damage`、`fleet_resources_used`、Damage/FR、投影击杀场次/FR，以及 Top-N 候选逐场复跑得到的实际击杀场次、总 FR、最终 HP、剩余 FR 和 affordability 状态。`kill_cost` 每场开始前检查当前 FR 是否仍足以 committed；所有战斗仍只由 `run_battle(config)` 执行。

BB3 槽位回归实际运行 2 个 Cruiser Loadout × 252 个位置 = 504 个唯一 Battle、0 error；固定 `CruiserSingleArmorTank` 的 252/252 子空间仍为 PASS：最大 Boss Damage 1365、FR Used 300、Damage/FR 4.55，A1–A5 属于并列最优。

## Optimizer v2.2 Fast 与 Baseline

日常 `config.json` 可加入：

```json
{
  "search": {
    "profile": "fast",
    "goal": "beat_baseline",
    "simulation_clock": "offline_fixed_step",
    "max_wall_seconds": 300,
    "max_simulations": 300,
    "workers": 4
  },
  "baseline": {
    "enabled": true,
    "formation": {
      "A1": "Frigate",
      "A2": "Frigate",
      "A3": "Cruiser"
    },
    "loadouts": {
      "Frigate": {"primary": null, "secondary": null},
      "Cruiser": {"primary": null, "secondary": "CruiserSingleArmorTank"}
    },
    "observed": {"fleet_resources_used": 150, "boss_damage": 819}
  }
}
```

`observed` 仅用于核对；Baseline 总会先由真实 `run_battle(config)` 运行，所有 incumbent 和剪枝门槛只读取 `verified_baseline`。不一致时输出 `BASELINE OBSERVED RESULT DIFFERS FROM SIMULATION`。`goal=beat_baseline` 且没有严格改进时输出 `NO IMPROVEMENT FOUND`，继续推荐 Baseline。

Fast 使用 20 场 Counter Probe 上限、20 个 Composition 原版部署报价上限、确定性 12.5% exploration、Battle Analyzer 排序、代表阵型签名去重、Escort/efficiency/kill-cost 启发式剪枝。Smart Prune 不产生全局精确声明；完整结果继续标为 `SEARCHED BEST`。`balanced` 保留较宽搜索；`exhaustive` 关闭会损失全局保证的 Smart Prune。

Hard Prune 只包含可证明规则：原版部署报价超过 FR、舰种禁用、规范化重复，以及根据 `calc_total_deployment()`、单舰 refundable value 和 retention 推导的 `minimum_possible_used_fr` 已无法击败已验证 Normal Victory。Counter、Hazard、Probe、Formation Signature、Escort Gate、optimistic factor 全部记录为 Smart Prune。

输出文件：

- `map/<galaxy>/<node>.result.json`：正式节点结果；普通战只保留最终 Best，Boss 保留原有候选结构。
- `map/<galaxy>/<node>.godot.log`：未过滤的完整 Godot stdout/stderr。
- `results/latest.json`：完整调试/机器结果与 ranked candidates。
- `results/latest_summary.json`：日常所需的精简字段。
- `results/latest.txt`：可直接照着游戏部署的舰种、Mods 与 A1–B5 阵型。
- `results/performance_benchmark_b35_v22.json`：固定 B35 candidate 的 10 次 full/minimal 性能分解。
- `results/optimizer_v22_unit_tests.json`：Hard/Smart Prune 与阵型文本回归。

独立 headless worker 有 60 秒预热保护；每个 worker 使用独立 user data 目录、握手文件和日志，不写 `latest.json`。Optimizer 现在只启动所需 Galaxy、FleetBattle 依赖和 HTTP guard，不初始化完整 Main UI、Themes、Steam 或 PurchaseHelper。本机 4-worker smoke 的 ready 时间约 25 秒，结果为 `workers_requested=4`、`workers_effective=4`。若进程启动、ready 或 simulation 失败，结果会记录进程状态与 worker 日志尾部，并保留确定性单进程 fallback。
