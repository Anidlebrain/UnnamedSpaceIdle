# 搜索配置 Source of Truth

本页记录 Fleet Manager 日常入口 `run_optimizer.bat <galaxy> <node>` 的真实读取、合并和覆盖顺序。结论来自 BAT、PowerShell、`fleet_test_runner.gd`、`friendly_config_resolver.gd`、`fleet_optimizer_search.gd` 与 `fleet_optimizer_v2.gd`，不是按字段名推测。

## 运行链路

1. Fleet Manager 从 `map/search_config.json` 读取用户 Search 配置；文件不存在时回退 Git 跟踪的 `poc/search_config.json`。
2. 点击开始搜索时，Main 先校验并原子保存 Search，重新读取确认，然后创建包含完整 Search 与战斗环境的不可变 Task Snapshot。保存失败不会启动任务。
3. Main 在 staging 时把确认后的共享 Search 与选中 Node Version 自带的普通战 `target_used_fr` 合并，将该 Node 与 Common 写到 `map`，同时锁定并记录有效 Optimizer 公共配置哈希。持久 Node Version 不因共享搜索偏好而改变。
4. BAT 选择 `map/optimizer_v2_daily.json`，不存在时回退 `poc/optimizer_v2_daily.json`，再把三份输入暂存到隔离 Godot 工程。
5. Runner 分别加载三份 JSON，将 daily JSON 复制为 `optimizer_settings`；Resolver 使用 Node + Common 生成 Battle Config 和 `config.optimizer`。
6. Runner 用 `config.optimizer` 覆盖 daily 副本中的 objective、Boss、完整 `search`、baseline、diagnostic 和 player state；Optimizer `_normalize_settings()` 再读取最终预算。

因此 Godot 输入格式中 staged Node `search` 仍是最终预算来源。共享预算来自独立 Search 配置，普通战目标来自当前 Node Version 的 `search.target_used_fr`；Boss 任务省略该字段。完整链路为 `共享 Search + Node 目标 → Task Snapshot → staged Node.search → Resolver → Godot normalized settings`。直接 BAT 运行仍使用 Node 自带 `search`，保持旧 CLI 兼容。

## 参数结论

| 用户概念 | 默认值 | 覆盖规则 | 最终生效位置 |
| --- | --- | --- | --- |
| 战斗目标 objective | daily JSON 可含 `objective=normal`，但 Friendly Resolver 默认由 Boss 状态推导 | `boss.alive=true` → `boss`；否则 `normal`。Runner 无条件用 Resolver 结果覆盖 daily objective | `fleet_optimizer_search.gd` 的 `objective`，决定普通战/Boss 排序与结果字段 |
| 优化目标 goal | Node 缺失时 `best` | Node `search.goal` 完整覆盖；只接受 `best` / `beat_baseline` | Resolver 校验并传入 `_goal`。当前 v3 在结果中记录 `search_goal`，但最终候选仍由 Best Found 排序，`beat_baseline` 不改变推荐；旧版 v2 才在没有严格改善时保留 Baseline。`beat_baseline` 仍要求 `baseline.enabled=true` |
| 最大模拟次数 | Node 缺失时 1,000,000；daily 顶层也有回退值 | Node `search.max_simulations` 覆盖 daily 顶层同名字段 | `_settings.max_simulations`；限制已计数的真实模拟，并为 Boss 精炼预留模拟数 |
| 最长墙钟时间 | Node 缺失时 300 秒；daily 顶层也有回退值 | Node `search.max_wall_seconds` 覆盖 daily 顶层同名字段 | `_settings.max_wall_seconds`；v3 计入 Godot 启动后的初始化、搜索与精炼，提前预留收尾时间；正在执行的战斗可能使总耗时略超限制 |
| 普通战目标 Used FR | 默认无 | Manager 使用当前 Node Version 的 `search.target_used_fr`，不保存到共享 Search；Boss 任务省略 | 仅实际胜利且真实 Used FR 不高于目标时提前停止探索，之后仍执行最终原版重放；留空继续到预算/空间耗尽 |
| 搜索方式 profile | Node 缺失时 `fast` | Node `search.profile` 完整覆盖 | v3 `fast` 的调度约 25% 尝试全局候选、其余尝试改进已有候选；`balanced` 约 40% 尝试全局候选；`exhaustive` 逐项遍历配置空间，只有全部完成才可声明穷举。v2 公共归一化还会调整 fast 的探测/报价默认预算 |
| 模拟时钟 simulation_clock | fast/balanced 默认 `offline_fixed_step`，exhaustive 默认 `realtime` | Node `search.simulation_clock` 覆盖；BAT 同时据此决定是否传 `--fixed-fps 60` | Battle Config 与 Runner / Optimizer 的模拟时钟 |
| 并行进程 workers | Node 缺失时 1，范围强制 1–4 | daily 当前没有 workers；即使未来添加，Node `search.workers` 仍优先 | `_settings.workers` 是请求的独立 Godot worker 数；启动失败可回退单进程，结果中的 `workers_effective` 才是实际并行数 |
| 部署模式 mode | daily JSON 当前 `realistic` | Node 没有对应覆盖字段；`practice_unlimited` 仅兼容归一化为 `practice` | 候选部署语义（真实 Overdeploy / practice），与 simulation_clock 无关 |
| 舰种、组数、Mod 搜索空间 | daily JSON | Node 不覆盖 | `ship_types`、`group_ranges`、`max_total_groups`、`max_groups_per_ship`、展开后的 `allowed_loadouts` |
| Galaxy 倍率 | `common.json` 必填；历史路径才回退 player_state 旧字段 | `effective = permanent + temporary` | Resolver 写入 `player_damage_scale` / `player_health_scale` |
| Boss priority / remaining HP | Node Boss | Boss 存活时必须为 `efficiency` / `kill_cost` 且 `0 < remaining_hp <= 原版最大生命` | Boss 排序与连续击杀精炼 |
| Hazards / Supports | Node 数组，默认空 | 不与 Common / daily 合并；Resolver 按原版 Fleet 数据校验并转内部 ID | Battle Config 的 `hazards` / `supports` |

当前仓库 daily 文件的显式默认搜索空间是：`Fighter / Corvette / Frigate / Cruiser / HeavyCruiser`，每种 `group_ranges=0..10`，`max_total_groups=10`，每种 `max_groups_per_ship=10`。`allowed_mod_slots` 的数组顺序同时定义可选真实 Mod ID 与旧数字 Loadout 的索引映射；`null` 表示 None。Primary 与 Secondary 做笛卡尔积，Standard Galaxy 的 Tertiary 由原版 Fleet 按 Galaxy scope 自动附加。

## daily JSON 其他预算字段

- `top_n`：最终输出的 Top / refined finalists 截取数量；不增加搜索总预算。
- `kill_refine_top_n`：Boss `kill_cost` 阶段计划精炼的候选规模。v3 至少取 3，并补充不同 composition；仍受总时间/模拟预算约束。
- `kill_sequence_max_battles`：单个 Boss 候选连续复战验证的最大场数；还会因 FR 不足、时间片或总预算提前停止。
- `finalization_reserve_seconds`（未知字段可由 Raw JSON 保留）：为最终阶段预留墙钟时间；默认 `min(45 秒, max_wall_seconds × 15%)`。
- `kill_refine_reserve_simulations`（可选）：Boss 精炼预留模拟数；默认 `kill_refine_top_n × 3`。
- `probe_budget`、`composition_quote_budget` 等可选内部字段控制候选探测/原版部署报价阶段，不取代 Node 的总模拟和墙钟上限。

当前 `optimizer_v2_daily.json` 的显式预算默认值为 `max_simulations=1,000,000`、`max_wall_seconds=300`、`top_n=10`、`kill_refine_top_n=3`、`kill_sequence_max_battles=100`；前两项在日常 Friendly Config 路径中会被 Node `search` 覆盖。

## Manager UI 与本机配置决策

- “搜索”页编辑独立 Search Draft；默认只显示紧凑摘要。Dialog 常用项是搜索方式与共同生效的时间/模拟次数预算；并行进程、模拟时钟和当前 v3 不改变推荐的 goal 放高级设置。点击加入队列时自动保存。
- “节点配置 → 环境”编辑普通战目标 Used FR；此值随当前 Node Version 保存。Galaxy 重跑使用每个节点各自的目标，Boss 忽略该字段。共享 Search 文件不保存目标。
- Search 使用 `map/search_config.json → poc/search_config.json`；Optimizer 公共使用 `map/optimizer_v2_daily.json → poc/optimizer_v2_daily.json`。UI 显示当前来源。
- `poc` 只保存可提交默认值，`map` 是已忽略的本机实际配置，日常修改不会污染 Git。
- Galaxy rerun 启动时自动校验并保存当前共享 Search 草稿，冻结后逐节点合并各自已保存的目标到 Task Snapshot 与 staged Node，不依赖此前手动搜索或保存。
- 旧 Node `search` 保留给 Resolver、直接 CLI 和旧数据兼容，不做破坏性迁移。
- “Optimizer 公共”不再结构化重复显示 objective、max_simulations、max_wall_seconds；它们仍原样保留在 Raw JSON，作为非 Friendly Config 回退兼容字段。
- `mode` 标为“部署模式”，`simulation_clock` 标为“模拟时钟”，避免把二者视为同义配置。
- workers 只在 Node 搜索页出现。
- Boss objective 不再让用户另外维护：由 `boss.alive` 自动决定。
