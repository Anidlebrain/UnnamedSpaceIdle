# 参数化 Battle Config 与确定性验证

日期：2026-09-10

## 结论

`poc/fleet_test.gd` 已提供：

```gdscript
await run_battle(config: Dictionary) -> Dictionary
```

`run_demo()` 只构造示例 Config，再调用同一个 `run_battle(config)`。核心路径仍是原版 `Fleet.start_battle()` → `FleetBattle.tscn` → `FleetBattle._on_btnStart_pressed()` → `FleetController._physics_process()`，没有重写舰队战公式。

示例输入在 `poc/battle_config.json`。最终相同输入连续运行 20 次，要求比较的字段为 **20/20 identical**；机器可读结果在 `results/determinism_test.json`。

## Battle Config 字段与原版映射

| 字段 | 进入原版的位置 | 说明 |
|---|---|---|
| `galaxy_id` | `Fleet.galaxy_nodes`、`_configure_retention()` | 校验 FleetEvent 所属 Galaxy，并设置该 Galaxy 的 FR retention |
| `fleet_event_id` | `Fleet.fleet_event_refs[id]` | 提供真实 `FleetEvent` 节点及 Hazard/Boss 上下文 |
| `battle_id` | `Fleet.start_battle()`、`Fleet.fleet_battles[id]` | 必须等于 FleetEvent 的 `stats.battle_requirement` |
| `grid_size` | `Fleet.grid_size` | 在重新 `setup_battle()` 前覆盖 |
| `player_damage_scale` | `_apply_player_scales()` | 独立乘到玩家部署组的最终 `ship.damage_scale` |
| `player_health_scale` | `_apply_player_scales()` | 独立乘到玩家部署组的最终 `ship.health_scale`，随后调用原版 `FleetShip.update_stats()` |
| `fleet_resources` | `FleetBattle.fleet_resources_max` | 该场可用 FR |
| `fleet_resources_retention` | `PlayerInfo.stats.fleet_resources_retention` | 新 Config 使用 0–1 比例；适配器乘 100 写入原版百分数 stat。大于 1 的旧百分数值仅用于重放历史结果 |
| `ships_available` | `Fleet.fleet_ships_available_this_battle` | 数值是“部署组”数量；1 组 Corvette 会按原版数据生成 4 艘物理舰 |
| `formation[]` | `FleetBattle.fleet1: Array[FleetEntry]` | 玩家 ship、`grid_position[x,y]`、primary/secondary/tertiary Mods |
| `enemy_fleet[]` | `FleetBattle.fleet2: Array[FleetEntry]` | 敌舰 ship、位置、Mods、`difficulty_override` |
| `hazards[]` / `supports[]` | `HazardManager.setup_hazards(nodes)` | ID 映射为真实 FleetEvent 节点，继续使用原版 Hazard 定义 |
| `temporary_events[]` | `FleetBattle.completed_temp_events` | 写入本场临时事件集合 |
| `fight_enemy_command_ship` | `BattlePracticeSettings.fight_enemy_command_ship` | `true` 表示按原版完整 Boss 模式开战 |
| `boss_health` | FleetEvent 的 `command_ship_health_left/pre_battle` | 指定残余 Boss HP；与完整 Boss 模式互斥 |

适配器启动前清空所有舰种的原版全局 Mod 槽，再按 Config 写回。原版 Mod 存储是“按舰种共享”，所以同一种 ship 的多个部署组不能携带不同的主/副/三级 Mod 组合；验证器会拒绝这种输入。

## Damage / Health 的源码落点

原版路径：

```text
ShipDeploymentGroup.deploy_ships()
  -> Fleet.get_fleet_ship()
  -> Fleet.apply_ship_mods()
  -> Fleet.get_ship_stats_based_on_galaxy()
  -> FleetShip setup/update_stats
```

版本 0.85.1.0 的 Practice 只有 `Fleet.sandbox_mode_player_stats` 一个倍率；`Fleet.get_ship_stats_based_on_galaxy()` 会把它同时乘到玩家 `damage_scale` 和 `health_scale`。适配器保留两个外部字段，把这个原生统一倍率固定为 1.0，等原版完成基础舰船、Mod 和敌方 difficulty 处理后：

- `player_damage_scale` 乘到玩家部署组的 `fleet_ship_info.ship.damage_scale`。原版 `FleetShip.setup_turrets()` 执行 `turret.damage *= stats.damage_scale`，最终作用于武器伤害。
- `player_health_scale` 乘到 `fleet_ship_info.ship.health_scale`，再调用原版 `FleetShip.update_stats()`。最大船体和护盾仍按 `health_scale * (1 - shield_ratio)` 与 `health_scale * shield_ratio` 计算。

实际分离测试使用 Damage=2.0、Health=3.0：Corvette 最大 Hull 从 30 变为 90，单次基础攻击从 10 变为 20，证明两个输入独立生效。

## Minimum Complete Battle Input

对当前标准 Galaxy Fleet Practice，一场可复现战斗的最小完整输入是：

1. 固定环境：游戏数据版本、Godot 版本、60 Hz physics tick、`galaxy_id`、`fleet_event_id`、`battle_id`、`grid_size`。
2. 敌方：完整 `enemy_fleet[]`，含 ship、位置、Mods、difficulty override。
3. 环境效果：`hazards[]`、`supports[]`、`temporary_events[]`。
4. Boss：完整 Boss 或指定残余 HP，两者选一；无 Boss 时两者均关闭。
5. 玩家最终状态：独立 Damage/Health multiplier、可用 FR、FR retention、`ships_available`。
6. 候选阵容：每个部署组的 ship、坐标、primary mod、secondary mod、tertiary mods。

Artifact、Galaxy completion、Fleet upgrades 和路线进度不应作为输入；它们对战斗的影响必须先折叠进最终倍率、数量、Mods、FR 或事件列表。

当前范围是标准 Galaxy Practice。Unstable Transit 若未来纳入，还需另行参数化玩家 Command Ship、UT 专属舰船/Mods、Teleport 的真实毫秒冷却和 Roguelike 状态。

## 隐藏依赖分类

### A. 已由 Config 显式覆盖

- 玩家最终 Damage/Health；
- 舰船可用部署组数；
- 玩家和敌方完整阵型、位置、Mods；
- 敌方 difficulty override；
- FR 上限和 FR retention；
- Hazard、Support、临时事件；
- Boss 完整参战或残余 HP；
- grid size。

### B. 固定依赖或全局副作用

- 舰船、武器、Ability、Mod、Hazard、Battle 定义仍来自同版本原版 `game_data.cdb` 和场景资源；这是复用原版规则的固定依赖。
- 碰撞、SceneTree group 顺序和物理更新依赖 Godot 4.7.2、固定 60 Hz 与相同场景构造。
- 原版 `FleetController.reset()` 不清零 `battle_timer`。第一次诊断重复测试因此出现跨场物理相位差；适配器现在每场前后显式设置 `battle_timer=0.0`。
- 原版战斗代码会用进程全局 `randf()` 判定 Fighter 闪避。主进程和并行 worker 的全局随机状态彼此独立；适配器现在每场开始前都重置为 `simulation_seed`（省略时为固定默认值），避免搜索候选与最终主进程回放走不同的随机轨迹。
- 原版胜利状态会检查教程 Dialogue，并可能改变 `Engine.time_scale` 或暂停 SceneTree。适配器仅在隔离进程中把 Dialogue 标记为已查看，并在每场前恢复 `time_scale=1.0`、`paused=false`。
- 原版完成路径仍可能增加内存中的 misc stats 或检查成就。Runner 不 Accept、不 Save，测试 `user://` 与正式目录隔离；这些非战斗副作用不作为后续场次输入。
- HTTP Save/Validate 被设为 unavailable、队列被清空，并通过 `127.0.0.1:9` 代理阻断。Steam singleton 在官方 Godot 中不可用。

每场之间还会禁用并重置 `FleetController`、销毁 `FleetBattle`、重置 Hazard、清空 `Fleet.battle_log`，等待两个 SceneTree 帧后调用 `Fleet.reset()`。

## Battle Result 与首字符

返回值包含：

- `outcome`、`simulation_time`、`fleet_resources_committed`、`fleet_resources_used`、`boss_damage`；
- 双方每艘物理舰的 id、原版名称、team、位置、alive、Hull/Shields/Barrier 及最大值、Mods；
- 带原始 `time` 的 `raw_battle_log`；
- 原版规则生成的 `copy_battle_log_text`；
- 完整 `battle_config` 回显。

`BattleReport.build_log()` 原版实现先为每行添加一个 `"\n"`，最后却调用 `battle_log_text.substr(2)`。因此版本 0.85.1.0 会真实截掉第一行的首字符，`Enemy...` 变成 `nemy...`。适配器故意保留该行为。

## 20 次确定性结果

最终测试使用 `poc/battle_config.json`，每场重建干净 Battle 状态。比较 outcome、FR used、Boss damage、双方所有物理舰最终状态、删除每项 `time` 后的 raw log、Copy Battle Log；`simulation_time` 被记录但不属于指定比较集合。

| 项目 | 结果 |
|---|---|
| 完成 / 一致 | **20 / 20** |
| 错误 | 0 |
| 规范化 SHA-256 | `cfa7233e4014b7bd4c11e01325c2aad0fc1190c69c7c683bb3b9cce5837cb38b`（20 次相同） |
| Outcome | `victory` |
| Simulation time | 约 4.95 秒 |
| FR committed / used | 10 / 7.87 |
| Boss damage | 0 |
| 玩家 | 4 艘 Corvette，2 艘存活，Hull 24/30 与 18/30 |
| 敌方 | 6 艘 EnemyBasic，全部被毁 |
| Raw log | 66 项 |
| Copy log 开头 | `nemy...`，与原版行为一致 |

## 玩家实际 A/B 的最小资料

玩家不需要提供正式存档，也不需要列 Artifact 或已完成路线。最少需要：

1. Battle/Practice 概览截图：Galaxy、Node、Fleet Damage/Health、启用的 Hazard/Support/临时效果、Boss 开关或剩余 HP。
2. 完整部署截图：当前 FR、所有已部署舰种与格子位置；若“可用舰船数量”未同时显示，再补一张舰船选择列表。
3. 每个实际使用舰种的 Mod 页面：primary、secondary，以及已启用的 tertiary/global fleet Mods；相同舰种只需一份。

当前 Practice UI 只显示统一的 `Fleet Damage/Health` 时，一张图只能得到同一个倍率；若未来 A/B 要独立设置 Damage 与 Health，必须另行提供两个精确数值，不能从截图猜测。

只给 Copy Battle Log 可以推导胜负、出手/击毁顺序、舰种名称和伤害数字；不能可靠推导起始 Damage/Health、可用舰船总数、完整 Mods、FR/retention、Hazard/Support、初始 Boss HP 或所有幸存舰最终 HP，所以不能替代上述截图。

若 Galaxy/Node 已明确，敌方默认编队可由锁定版本的原版 DB 生成并写入最终 Config，玩家无需人工抄录；但任何 Practice 中手动改变的敌方 Mod、difficulty、Hazard 或 Boss 状态仍必须出现在截图或精确文本中。

## 停止点

本阶段只完成可信参数化 Battle Simulator 和验证文件；没有开发 Optimizer、Beam Search、遗传算法、自动枚举、UI 自动化、正式存档读取或性能优化。
