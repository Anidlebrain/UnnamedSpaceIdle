# Fleet Battle 原生模拟复用

## 当前日常 Optimizer：v3

日常入口已切换为 `poc/fleet_optimizer_search.gd`。普通战按 **WIN → 最低真实 Used FR** 排名；Boss 有三种 `boss.priority`：`efficiency`（伤害效率，允许 LOSS）、`kill_cost`（最低击杀总成本，输入 FR 为每次部署上限，每场恢复同一上限）、`affordable_kill_cost`（当前资源内完整击杀，逐场使用原版账本结算，剩余 FR 必须足够下一次部署，且累计实际 Used FR 不超过输入 FR）。两个击杀策略都使用原版逐场模拟至 Boss HP 为零的成绩，最后一场保留原版退款；投影场数/成本只用于探索排序。

两种击杀策略同时保留 `per_battle_best_result` 和 `affordable_best_result`，`best_result` 按所选策略选择；两者可以是同一阵型。`affordable_kill_status` 明确输出“已找到可负担的完整击杀”或“未找到可负担的完整击杀”。例如当前 690 FR、单次部署策略总成本 1690 FR，只保留后者作为补充资源后的候选，不能视为当前可负担击杀。未找到表示预算内没有完成验证，不是证明所有阵型均无解。TXT 将附加候选单独列出，`--copy` 仍只复制主推荐。

默认 `search.strategy: "portfolio"` 必须提供 `baseline.enabled: true`、formation 和 loadouts。启动先验证 Baseline：普通战必须 WIN，Boss 必须 `boss_damage > 0`，否则输出 **BASELINE VALIDATION FAILED** 并停止。Baseline 是参考上界，并不限制全局 composition 的生成。新增的 `advisor_seeded` 策略允许输入阵型战败，见下文。

`kill_cost` 搜索限制内尚未验证出完整击杀序列时，输出 **BASELINE RETAINED**，保留并重放已验证的输入阵型。`affordable_kill_cost` 优先推荐已验证完整击杀中累计实际 Used FR 最低的方案；未找到击杀时输出 **NO VERIFIED AFFORDABLE KILL**，推荐当前资源内已验证累计伤害最高的方案，伤害相同再比较总消耗和场数，不再直接退回基线。状态表示搜索预算内未找到，并非证明无解。

当前资源策略分别保留单场最大伤害、预计可负担累计伤害，以及不同部署预算/可挑战次数的搜索父阵型。次数估计同时检查部署费、原版向下取整扣款和累计实际 Used FR，不能简单用 `floor(FR / Used FR)` 代替。估计仅控制搜索顺序；结果全部逐场运行原版场景，并按真实 BOSS HP 和钱包继续。搜索支持重复阵型及剩余资源换阵收尾，最终推荐的每一场都会重放。多场探索在线约占总时间的 10%，收尾预留约 20%；有界候选与缓存控制三列及更大阵型的成本。这是预算内启发式搜索，不保证穷举所有混合序列。

`best_result` / `affordable_damage_result` 的 `campaign_boss_damage`、`campaign_battles`、`refined_fr_spent`、`campaign_remaining_fr` 和 `boss_final_hp` 描述整套当前资源方案；原 `boss_damage` / `fleet_resources_used` 仍描述首场。`kill_sequence` 每场保存阵型、装配、伤害和资源账本。TXT 与 App 都列出后续场次，`--copy` / “使用最优配置”只应用首场。`affordable_best_result` 仅表示完整击杀；未找到击杀时该字段为空，伤害方案仍可有效。附加的 `per_battle_best_result` 仅在预算内完成验证时提供，当前资源策略优先把模拟预算用于可执行方案。`kill_cost_resource_policy` 区分 `per_battle_budget` 与 `current_resources`；不能仅依据单次部署候选的旧兼容字段 `killable_with_current_fr` 判断当前资源能否击杀。

算法方案、源码依据和验证见 [当前资源 BOSS 搜索](docs/boss_current_resources.md)。隔离测试可通过 `tools/benchmark_preserved.py` 包装原基准入口，自动备份并恢复暂存工程输入；日常使用仍是 `run_optimizer.bat`。

日常只需 `"search": {"profile": "fast"}`，默认单 worker、300 秒（含 Godot 初始化）。Balanced 增加全局探索比例；已有显式时间、worker 和 simulation 上限仍兼容。收尾预留真实重跑与 Boss 序列时间，当前战斗会完成，极慢战斗可能略超预算。`beat_baseline` 字段兼容，但仍尽量搜索到预算结束。Exhaustive 只用于受限空间验证；只有确实完成全部配置空间的普通战/效率搜索才显示 EXHAUSTIVE BEST。

新流程交错生成全局 composition、档案候选和当前优胜方案的变体，移除了日常路径中的 Beam/Probe 截断与 Smart Prune。**BEST FOUND / TIME BUDGET REACHED 均不代表全局最优。** 详细算法、原版语义、性能拆解、回归与前后对照见 [optimizer_v3_report.md](docs/optimizer_v3_report.md)。下文的 v2 搜索描述和结果保留作历史记录。

2026-09-28 搜索改进：增加固定舰队的持续站位搜索（包括优胜阵型删去一组后的舰队），不再要求删船后的原位置先获胜；增加数量、Mods、站位一起变化的候选。邻域某类操作用尽后继续处理其他未访问邻域，全部用尽后才做组合变异。站位子空间较小时按打乱顺序无重复遍历，大空间使用随机布局，保留最多 32 个自动站位搜索流。全局搜索、档案和原版战斗评分继续保留。G8 B4 的原因分析见 [搜索改进与推荐阵容策略](docs/search_advisor_strategy.md)。

### 推荐阵容搜站位：advisor_seeded

将游戏“部署推荐”里的舰种、数量和 Mods 填入现有 `baseline`，位置可以任意填写合法、不重复的格子，保留 `baseline.enabled: true`。然后在节点 JSON 的 `search` 中加入：

```json
"strategy": "advisor_seeded"
```

仍通过 `run_optimizer.bat g8 B4` 运行。该策略固定输入舰种、数量和 Mods，只搜索站位；**起始站位可以战败**。搜索优先尝试真实成绩较好的最多四个阵型周围的移动、交换与镜像，每三个调度机会至少保留一个给全局站位遍历，局部邻域用尽后也继续全局探索。普通战只有实际获胜并通过原版重放的方案才会作为结果推荐。未找到时返回 `NO VICTORY FOUND`，不输出可复制阵型。完成这支舰队的全部站位后提前停止并报告 `ADVISOR POSITIONS EXHAUSTED`，不表示全部舰队空间全局最优。

普通战可选设置 `search.target_used_fr`，例如 `27.3`。只有获胜且真实 Used FR 不高于目标（仅容许浮点尾差）才停止探索，随后仍做最终原版重放；失败不发布推荐。目标是用户希望达到的成本，不是已证明最优值。省略或设为 `null` 则持续搜索到预算/站位空间耗尽；Boss 不接受该字段，继续使用独立的 Boss 评分目标。推荐截图中的 Mods 必须与输入一致，部署费不能充当战后 Used FR。

日常日志现在实时显示标准错误，启动器每五秒输出阶段心跳；脚本错误立即终止本次进程树，Runner 60 秒未就绪会退出，整体运行超过节点时间预算加 30 秒收尾宽限也会退出。退出码分别为 70（脚本错误）、71（启动超时）、72（整体超时）。搜索周期性输出唯一候选/站位数、胜负数、最佳 FR、目标差距与剩余时间。每场已完成的探索战斗实时写入 `<node>.result.candidates.jsonl`，包含站位、Mods、胜负、实际 FR 和错误；其内容是搜索记录，最终推荐仍以完成重放的 result JSON/TXT 为准。手动停止会保留已刷新的日志，但不会把未完成重放的候选发布为最终推荐。

这是独立的搜索策略，与 `boss.priority` 的 `efficiency`、`kill_cost`、`affordable_kill_cost` 分开；Boss 目标仍按原有规则评分和验证。`search.profile` 使用 `fast` 或 `balanced`；`exhaustive` 保留为全部配置空间验证，不与此策略组合。切回普通优化使用 `"strategy": "portfolio"` 或省略此字段。建议保留较大的 `max_simulations`，按 `max_wall_seconds` 控制运行时间；两个限制任一先到都会停止，最终重放可能使模拟总数略高于搜索上限。

推荐信息由用户录入；Optimizer 保持离线，不查询 Advisor 服务。本次未修改 app；新增加的 `target_used_fr` 需直接编辑节点 JSON 并通过 BAT 使用，界面暂存不保证保留此字段。原始日志和候选记录路径会打印到控制台。

v3 部署报价优化：Baseline 和未知装配先建立原版场景，读取真实 Mod 后单组成本；同一战斗环境内，后续不同数量按原版 `calc_total_deployment()` 的逐组 Overdeploy 加价顺序累计，继续使用原版 `NumberUtils.fleet_less_or_equal` 判定预算，避免为已知成本反复创建整个战斗场景。战斗评分和最终验证仍运行原版场景。性能输出分别记录原生场景报价、推导报价及缓存命中，不把推导报价计作原生场景调用。

## 阵型列数（A/B/C）

Friendly Node 顶级字段 `formation_columns` 表示阵型列数，每列五格，允许 1–26，缺省为 2。G6 B46 必须设置 `"formation_columns": 3`，阵位为 A1–C5；原版恢复脚本 `Fleet.gd` 的 `galaxy6_battle46` 明确为 `Vector2(3, 5)`，后续也存在一列节点。Resolver 将配置列数与原版节点 `grid_size` 精确核对，不相符时停止并指出所需列数，绝不改写原版战斗尺寸。五格之外的原版高度目前会明确报不支持。

搜索候选位置、组合计数、随机布局、邻域移动/交换/镜像、精确枚举和结果命名均使用实际网格。三列的镜像按 A↔C、B 保持计算；镜像只是额外候选，不能视为战斗等价并剪枝。日常 v3 继续关闭旧 Smart Prune；历史 v2 在非 2×5 网格也关闭这类启发式剪枝。重复、非整数或越界坐标会在原版部署前拒绝。

提交的默认公共搜索空间已将总组数、单舰种上限及范围上限设为 15；实际总组数取公共上限与节点格子数的较小者，所以两列仍最多十组，一列最多五组。**已有 `map/optimizer_v2_daily.json` 保持不变并优先于默认文件**：若本机仍设置十组，三列会搜索全部十五个位置，但最多部署十组；要开放十一到十五组，需在 app 公共设置中同时调整总组数、各舰种范围及上限。正式 Overdeploy 与 FR 可负担性仍使用原版部署报价。

组合生成在递归过程中提前跳过容量超限和禁用舰种分支，不删除任何合法组合；v3 至多保留 32 个父阵型的变异集合，淘汰后可重新生成。结果 TXT 增加 `Formation columns: N` 并输出所有列，`--copy` 严格核对元数据、目标列数、完整列和重复列，失败不写回。

多列回归入口（只用于隔离验证，日常仍使用 BAT）：

```powershell
python tools/benchmark_optimizer.py --label grid-check --seconds 600 --extra --grid-regression --validation-galaxies=6 --battle-config=res://ui_ab_test_02_config.json
python -m unittest tools/test_copy_result_columns.py -v
```

`--grid-regression` 使用合成玩家倍率与原版 G6 B45/B46 敌阵，验证三列 C(15,5)=3003、混合 15×14×13=2730、五舰种十五格的 15503 个非空数量组合、全局候选、十五组部署、两列/三列受限穷举及真实重放。加 `--grid-logic-only` 可跳过战斗，仅检查网格与候选逻辑。验证不代表用户实际进度的最优解；日常有预算的结果仍是 BEST FOUND。

2026-09-26 验证：34 项 Godot 检查及三列文本断言通过；B45 的 20 个、B46 的 30 个受限候选全部完成，战斗错误为零，最终原版重放一致。另一个 B46 Fast 双 worker smoke 正常结束并通过 TXT → 15 格配置写回比对。五舰种十五格组合生成约 149ms，提前跳过容量超限分支后仍完整保留 15503 个非空组合。详细本机证据在 `results/optimizer_v3/grid_columns_native_20260926/` 和 `grid_b46_parallel_20260926/`（忽略目录，不提交）。

## Daily Usage（日常使用）

map/ 是本机输入目录，已加入 Git 忽略；从远端克隆后需在本机自行准备 Galaxy/Node JSON 和 common.json。

1. 编辑 `map/<galaxy>/<node>.json` 和同目录的 `common.json`。
2. 运行 `run_optimizer.bat g6 B21`。
3. 等待本机搜索完成。
4. 查看控制台中的输入、解析、搜索预算和最优结果摘要。
5. 查看 `map/g6/B21.result.txt`，需要完整结构化数据时查看 `map/g6/B21.result.json`；`results/latest.json` 和 `results/latest.txt` 继续作为兼容调试输出。

运行 `run_optimizer.bat g6 B21 --copy`（短别名 `--c`，大小写不敏感）可将 `map/g6/B21.result.txt` 中推荐的阵型和 Mod 配置写回 `map/g6/B21.json` 的 `baseline`。复制模式只更新结果，不启动 Godot 优化器；它同时兼容英文舰种/Mod ID 和数字格式的结果文本。结果中出现的舰种更新装配，原配置中其他舰种的装配保留，方便以后重新加入阵型。解析或校验失败时不会改写 JSON。

Friendly Config 的舰种既可沿用英文名，也可使用数字：`1=Fighter`、`2=Corvette`、`3=Frigate`、`4=Cruiser`、`5=Heavy Cruiser`。`baseline.formation`（以及 diagnostic candidate 的 formation）可以把 A1–B5 全部写出，空位使用 `0` 或 `null`。`player_state.ships` 与 `loadouts` 的键也兼容字符串数字键 `"1"`–`"5"`。
Baseline 阵型引用了尚未配置装配的舰种时，Resolver 自动按无 Primary/Secondary Mod 处理；已有装配不会被重置。diagnostic candidate 仍要求显式提供装配。

`primary` / `secondary` 可以沿用内部 Mod ID，也可使用数字索引：`0` 表示不使用，`1` 表示该槽位在 `poc/optimizer_v2_daily.json` 中的第一个 Mod，未来存在第二个 Mod 时使用 `2`。越界索引会直接报错，不会静默替换。数字格式输入文件可使用 `<node>_num.json`，例如 `run_optimizer.bat g6 B16_num` 会读取 `B16_num.json`，校验其中的 `node: "B16"`，并仍输出 `B16.result.json` / `B16.result.txt`。TXT 中推荐舰种、阵型和两个 Mod 槽位均使用同一数字表示，空阵位显示为 `0`。

日常使用不需要 Codex。模拟和优化完全在本机 Godot 中运行，不会消耗 Codex token。用户只填写 Friendly Config；Fleet Event、Battle、敌舰、Hazard、Support 和 Command Ship 等内部 ID 继续由 Resolver 从原版数据解析。

`run_optimizer.bat` 根据 Galaxy 和 Node 参数读取 `map/<galaxy>/<node>.json`，不写死 G6。Galaxy 公共倍率来自同目录 `common.json`：`permanent` 是长期最终倍率，`temporary` 是手工加算增量，`effective = permanent + temporary`；节点文件不再保存这两个 scale。使用已验证的 Godot 4.7.2 隔离测试工程，并采用当前已确认解锁的 Standard Galaxy Mod 集合。Fast / Balanced 默认使用 `offline_fixed_step`；Runner 通过 Godot 官方 `--fixed-fps 60` 关闭墙钟同步，但仍逐 tick 执行原版 60 Hz physics。可把 `search.simulation_clock` 改为 `realtime` 做 Reference / Debug。配置或 Baseline 验证失败时命令返回非零退出码，且不会覆盖已有的节点 JSON/TXT 或兼容 `latest` 输出。

`common.json` 还可设置 `ships` 公共舰船数量。设置后，节点 `player_state.ships` 表示该节点额外数量，Resolver 按舰种相加后交给原版战斗与搜索。未设置 `common.ships` 时，节点舰船数量继续按旧格式作为绝对数量读取。Fleet Manager 的 G6 本机数据使用公共 `Fighter 1 / Corvette 2 / Frigate 1 / Cruiser 1 / HeavyCruiser 0`；B12 和 BB2 现有的重型巡洋舰仍作为节点额外数量保留。

跨 Galaxy 的搜索空间、部署模式与精炼规则优先来自本机 `map/optimizer_v2_daily.json`，不存在时回退到提交的 `poc/optimizer_v2_daily.json`。BAT 会显示实际来源并把唯一有效文件复制到隔离 Godot 工程；Fleet Manager 只写 `map` 覆盖，因此日常设置不会修改 Git 默认文件。`allowed_mod_slots` 是按舰种、槽位保存的有序候选数组，`null` 是 None，数字 Loadout 值按数组索引解析；v3 当前只对 Primary 与 Secondary 做笛卡尔积。Standard Galaxy 的 Tertiary 仍由原版 `Fleet.get_ship_mods()` 按 Galaxy scope 自动附加，不是当前手动搜索维度。

更精确地说，daily JSON 是跨 Galaxy 搜索空间、部署模式与精炼规则的来源；Friendly Config 的 Node `search.max_simulations`、`search.max_wall_seconds`、`search.simulation_clock`、`search.workers` 会在 Runner 合并后覆盖其中同名回退值，objective 则由 `boss.alive` 推导。Fleet Manager 维护 `map/search_config.json`（回退 `poc/search_config.json`），启动时才把确认值覆盖进 staged Node；直接 BAT 运行仍使用 Node 自带 `search`。完整 Source of Truth 表见 [`../app/docs/search-config-source-of-truth.md`](../app/docs/search-config-source-of-truth.md)。

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
