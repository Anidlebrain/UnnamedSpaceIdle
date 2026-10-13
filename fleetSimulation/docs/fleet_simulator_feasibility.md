# Fleet Battle Practice 原生模拟复用侦察结果

日期：2026-09-09

> 2026-09-10 更新：外部 Battle Config、独立 Damage/Health 倍率和 20 次确定性测试已经完成。本文后半部“单场 PoC”和“仍需重复验证”的表述保留为第一阶段历史记录；当前结论、数值与输入清单以 `docs/battle_config_and_determinism.md` 为准。

## 结论

**可以把游戏自己的 Fleet Practice 改造成优化程序反复调用的模拟 API，但复用层级应是“完整 FleetBattle 场景 + 固定物理帧驱动”，不是纯逻辑 Battle 类。**

分类为 **B：加载完整 Battle Scene 后自动运行**。

依据：

1. 正式 Galaxy 战斗与 Practice 都从 `BattleInfoPanel._on_btnStartBattle_pressed()` 进入 `Fleet.start_battle()`；Practice 只改变 `battle_practice_mode`、玩家倍率、可选 Hazard/Support/Mod 和 Boss 初始状态。
2. `Fleet.load_battle()` 对两种模式都实例化同一个 PC 场景 `res://fleet/FleetBattle.tscn`（移动端为 `FleetBattleMobile.tscn`）。
3. Advisor Validate 只是把服务器返回的 `BattleCompletionDetails` 重新部署，然后再次调用同一个 `_on_btnStart_pressed()`。
4. 战斗由 Autoload `FleetController._physics_process(delta)` 顺序驱动舰船、炮塔、投射物、Hazard、Ability 和 StatusEffect，依赖 `SceneTree`、`Node2D`/`Area2D`、碰撞查询、物理帧与场景节点。

因此最小正确方向是：

```text
simulate(config)
  -> 找到独立恢复工程中的 FleetEvent
  -> Fleet.start_battle(...)
  -> 对 FleetBattle 写入固定阵型/倍率/Hazard/Mods/Boss 设置
  -> FleetBattle._on_btnStart_pressed()
  -> 等待 BattleState 进入 COMPLETE_WIN / COMPLETE_LOSE
  -> 读取 FleetController、BattleCompletionDetails、Fleet.battle_log
```

本阶段已实际完成一次原生场景战斗。`poc/fleet_test_runner.gd` 在完整恢复工程中等待原版 Autoload、DB 和 FleetEvent 初始化，然后调用 `poc/fleet_test.gd`。Godot 4.7.2 官方版以 60 physics ticks/s 运行至 `COMPLETE_WIN`，完整结果见 `results/fleet_test_result.json`。

## 分析基线

| 项目 | 结果 |
|---|---|
| 游戏版本 | `0.85.1.0`；内部整数 `85100`，来自 `PlayerInfo.gd` |
| Steam App / Build | App ID `2471100`；本机 Build ID `25145163` |
| Godot | PCK 记录 `4.7.2`；PCK 格式 4；实测使用官方 Godot `4.7.2-stable` 控制台版本 |
| 原版 PCK | 68,319,828 字节；SHA-256 `47E161C73741E11DF9C5F2B8FCB8DCB71B5930180D1A60407EAAAE8D85B4C5CC` |
| 安装目录核对 | 配置中安装 PCK 与项目备份 SHA-256 相同；只读核对，未修改 |
| GDRETools | `2.6.4` |
| PCK 资源 | 7,359 个；未加密；校验无错误 |
| 已有恢复工程 | `translation/work/current/recovered` 只有 22 个文件、0 个 `.gd`、0 个 `.tscn`，仅适合翻译，不是完整工程 |
| 本轮脚本恢复 | 836 个 `.gdc` 全部成功反编译为 836 个 `.gd`；0 失败、0 lossy |
| 本轮数据提取 | 只提取 `game_data.cdb`；其中 `fleet_ships` 50 行、`fleet_mods` 83 行、`fleet_galaxies` 11 行、`fleet_events` 503 行、`fleet_abilities` 28 行 |
| 完整恢复 | `work/full_recovered` 当前 11,742 个文件（含 2 个 PoC 脚本和 Godot 导入产物）；836 个原版 `.gd`、931 个 `.tscn`、140 个 `.tres`、140 个 `.res` |
| 恢复质量 | PCK 7,359 个文件全部校验和提取成功；836 个脚本全部反编译；3,665 个导入资源全部转换，12 个 lossy、2 个 non-importable、0 failed、0 not converted |

## 关键文件

| 文件路径 | 用途 | 关键类 / 函数 |
|---|---|---|
| `work/recovered_scripts/fleet/Fleet.gd` | 战斗全局状态、正式/Practice 统一入口、场景加载与日志 | `Fleet.start_battle`、`load_battle`、`record_battle_action` |
| `work/recovered_scripts/fleet/FleetBattle.gd` | 阵型部署、战斗启动、胜负和结果结算 | `FleetBattle.setup_battle`、`_on_btnStart_pressed`、`start_battle`、`update_battle_state` |
| `work/recovered_scripts/fleet/FleetController.gd` | 固定物理帧内驱动全部战斗实体 | `_physics_process`、`reset` |
| `work/recovered_scripts/fleet/interface/FleetEvent.gd` | Galaxy 节点状态与 Practice 判定 | `is_battle_practice_mode` |
| `work/recovered_scripts/fleet/interface/PopupBattlePracticeSettings.gd` | Practice 倍率、Hazard、Support、Mod 与 Boss 配置 | `setup`、`update_practice_mode_hazard_settings` |
| `work/recovered_scripts/fleet/interface/BattleCompletionDetails.gd` | 阵型、Mod、FR、Boss Damage 的记录和序列化 | `build`、`get_save_string`、`create_from_string` |
| `work/recovered_scripts/fleet/interface/BattleReport.gd` | 从原始日志构造 Copy Fleet Battle Log 文本 | `build_log`、`_on_btnCopyBattleLog_pressed` |


## 完整入口调用链

### 正式 Galaxy 战斗

```text
fleet/interface/BattleInfoPanel.gd::_on_btnStartBattle_pressed
-> Fleet.start_battle(battle, {}, fleet_event_ref)
-> FleetEvent.is_battle_practice_mode() == false
-> fleet/Fleet.gd::start_battle
-> Fleet.load_battle
-> instantiate res://fleet/FleetBattle.tscn
-> fleet/FleetBattle.gd::_ready
-> FleetBattle.setup_battle
-> FleetBattle._on_btnStart_pressed
-> FleetController._physics_process(delta)
-> entity.process_fleet_physics(delta)
-> FleetBattle._on_ship_destroyed
-> FleetBattle.update_battle_state(COMPLETE_WIN / COMPLETE_LOSE)
```

### Fleet Battle Practice

```text
同一个 BattleInfoPanel 按钮
-> Fleet.start_battle(...)
-> FleetEvent.is_battle_practice_mode() == true
-> Fleet.battle_practice_mode = true
-> 同一个 Fleet.load_battle / FleetBattle.tscn
-> FleetBattle.setup_practice_mode
-> BattlePracticeSettings.setup
-> 同一个 FleetBattle.setup_battle / _on_btnStart_pressed
-> 同一个 FleetController._physics_process(delta)
-> 同一个胜负状态机
```

`FleetEvent.is_battle_practice_mode()` 在节点已完成、当前路径不可达但曾完成，或当前未处于 Galaxy 探索时返回 `true`。所以 Practice 不是另一套战斗引擎，而是同一场景的配置模式。

### Advisor Validate

```text
FleetBattle.get_suggested_battle_if_any
-> HTTPGetBattleSuggestion 获取 BattleCompletionDetails 字符串
-> BattleCompletionsPopup 发出 validate_advisor
-> FleetBattle._on_BattleCompletionsPopup_validate_advisor
-> set_player_fleet_from_bcd
-> setup_battle
-> _on_btnStart_pressed
-> 同一个 FleetController / FleetBattle 胜负状态机
-> FleetBattle.advisor_validation_complete
-> Fleet.validate_bcd_to_server
```

Advisor 的“Validate”明确是重新跑一次客户端原生战斗并比较目标 FR 或 Boss Damage，不是只做静态校验。

## 输入数据结构

| 输入 | 原始对象/变量 | 代码行为 |
|---|---|---|
| Galaxy | `Fleet.galaxy_exploring`、`FleetEvent.galaxy_id` | 决定 Galaxy 专属属性、FR、船只和节点集合 |
| Node / Practice 节点 | `Fleet.battle_started_from`（`FleetEvent`） | `stats` 来自 `db.fleet_events[fleet_event]` |
| Battle ID | `FleetEvent.stats.battle_requirement` | 索引 `Fleet.fleet_battles` |
| 敌方舰队 | `Fleet.fleet_battles[battle_id].fleet_setup` | `Array[FleetEntry]`；包含 ship、grid_position、mods、difficulty_override |
| 玩家舰种与数量 | `Fleet.get_fleet_ships_available(...)`、`Fleet.fleet_ships_available_this_battle` | 数量由全局/Galaxy stats、Ship Choice 和 Patrol 节点合成 |
| 实际布阵 | `FleetBattle.fleet1` | 每个格子最终构造 `FleetEntry(ship, grid_position)` |
| 每艘船两槽选择 | `Fleet.get_fleet_ship_dict(ship).selected_mods` | 两元素数组；主/副槽由 `ModSlot.PRIMARY/SECONDARY` 管理；三级 Mod 自动附加 |
| 武器 | `db.fleet_ships[id].ship -> db.ship_data[ship].weapons -> db.weapon_data[weapon]` | `Fleet.get_fleet_ship()` 深复制并解析武器数据 |
| 护盾/船体 | `ship.health_scale`、`ship.shield_ratio` | `max_hull = health_scale*(1-shield_ratio)`；`max_shields = health_scale*shield_ratio` |
| Mod | `db.fleet_mods` | 可替换 weapon/ability，并修改舰船或武器属性 |
| 玩家 Damage/Health Multiplier | `Fleet.sandbox_mode_player_stats` | Practice 中同时乘到玩家 `damage_scale` 与 `health_scale` |
| 敌方 Difficulty | `Fleet.fleet_battles[battle_id].difficulty` 或 `FleetEntry.difficulty_override` | 同时乘到敌舰 damage/health |
| Hazard/Support | `FleetEvent.hazard_node_sources`、`BattlePracticeSettings.hazard_node_list`、`HazardManager.hazards` | 数据来自 `fleet_events[].hazard`；已见 `laser_volley`、`damage_wave`、`damage_per_second`、`reinforcements`、`grid_buff` |
| Boss | `FleetEvent.has_command_ship`、`command_ship_type`、`command_ship_health_left`；Practice 的 `fight_enemy_command_ship` | 决定是否部署敌方 Command Ship 及其初始 hull |
| FR 上限/承诺值 | `fleet_resources_max`、`fleet_resources`、`fleet_resources_committed` | Practice 使用 `galaxy_node.fleet_resources_max`；开战时把当前部署成本记为 committed |
| FR 实际损失 | `fleet_resources_committed - fleet_resources` | 存活舰按剩余 hull 折算保留 FR，最终 snapped 到 0.01 |
| 已完成临时事件 | `Fleet.get_temporary_nodes_completed(origin)` | 写入 `BattleCompletionDetails.temp_events`；Practice 再合并手动启用的 Support/临时 Mod |

`BattleCompletionDetails` 是可复用的配置/历史记录对象，字段包括：`fleet_composition`、`resources_used`、`resources_committed`、`boss_damage`、`mods`、`temp_events`、`ships_available`、`other_ships_to_record`、`fleet_stats`。其 `V2` 字符串已经是现成、紧凑、可往返解析的阵型序列化格式。

## 输出数据与 Copy Fleet Battle Log

| 目标输出 | 现有来源 | 结论 |
|---|---|---|
| Victory / Defeat | `FleetBattle.battle_state` | `COMPLETE_WIN` / `COMPLETE_LOSE` 可直接读取 |
| 模拟耗时 | `FleetController.battle_timer` | 物理帧累计的模拟时间；应在刚进入完成状态时截取 |
| 玩家/敌方幸存 | `FleetController.ships` 中仍有效且 `!dead` 的节点 | 可按 `team` 分组 |
| 幸存舰 Hull / Shields / Barrier | 活着的 `FleetShip` 节点字段 | 可直接读取当前值和最大值 |
| 已毁舰 | 开战后先保存全部 `FleetShip.ship_record`；结束时无有效节点者视为已毁 | 因舰船死亡后 `queue_free()`，不能只在结束时枚举 SceneTree |
| FR loss | `bcd.resources_used` 或即时计算 `committed - fleet_resources` | Practice 胜利路径已使用同一计算 |
| Boss Damage | `bcd.boss_damage` | 由战前 Boss HP 减去当前 hull 得出 |
| Battle Log 原始对象 | 全局 `Fleet.battle_log: Array` | 每项为 `{actor: ShipRecord, action, target: ShipRecord, amount, time}` |
| Copy Fleet Battle Log 文本 | `BattleReport.battle_log_text` | `BattleReport.build_log()` 遍历 `Fleet.battle_log`，仅格式化 DAMAGE_DEALT 与 KILL，然后 `DisplayServer.clipboard_set(battle_log_text)` |

注意：剪贴板文本没有输出事件时间；原始 `Fleet.battle_log` 项有 `time`。`ShipRecord` 保存总伤害、承伤、击杀和 killer，但不保存最终 HP，因此 API 应在战斗完成的同一帧读取仍存活节点。

## 确定性检查

### 已确认的确定性机制

- 核心更新集中在 `FleetController._physics_process(delta)`，并按固定顺序处理 `ships -> turrets -> projectiles -> hazard_manager -> abilities -> status_effects`。
- 常规目标选择按距离/血量/伤害比较；距离相等时使用 Y 坐标打破平局，没有在 `FleetBattle.find_target*` 中随机选择。
- Fleet Missile 创建时由 `FleetTurret.fire(..., index)` 写入 `rng_seed = index`，其初始偏转使用局部固定 seed。
- `FleetShip.get_random_attach_offset()` 使用 `randomize()`，但只设置 Disruptor 附着特效的局部位置；伤害仍由附着对象定时直接调用 `attached_to.take_damage()`。
- `ChainBeam` 会随机选下一跳目标，但当前 `game_data.cdb` 的 50 个 `fleet_ships` 没有任何武器的 `chain > 0`，所以在当前标准 Fleet 舰船数据中不可达。

### 仍需运行时验证的风险

- 移动、射速、投射物、Hazard、Ability、StatusEffect 均使用 `delta`。必须固定 Godot physics tick；不能用不受控的 `_process` 或自行加速 delta。
- `FleetTeleportDrive` / `TeleportDrive` 使用 `Time.get_ticks_msec()` 做 2 秒冷却；当前只由 `UTTeleport` / `UTFleetTeleport` Mod 引用，标准 Galaxy Practice 不受影响，但 Unstable Transit 模拟不能直接假设纯物理时间确定性。
- 目标与碰撞依赖 SceneTree group 枚举、Area2D overlap 和物理帧提交顺序。源码表现为稳定，但必须用相同引擎版本、相同 physics tick 和相同 Scene Tree 构造验证。
- `Fleet.record_battle_action().time` 使用真实 ticks，而 BattleReport 剪贴板文本忽略该字段。比较原始 JSON 日志时不应要求 `time` 字段逐字相等；比较 Copy Battle Log 文本、事件顺序、胜负、FR 与 HP 更合适。

建议的第一轮等价性判据：同一节点和同一 `BattleCompletionDetails` 连跑 10 次，要求胜负、FR、Boss Damage、幸存舰 Hull/Shields 和 Copy Battle Log 文本完全一致；另把 physics tick 改动作为负向测试。

## 最小 PoC 状态

`poc/fleet_test.gd` 与薄 Runner 已实际执行，适配逻辑为：

- 固定选择 `galaxy1 / g1_1_b1 / galaxy1_battle1`；
- 固定部署一组 Corvette；
- 调用 `Fleet.start_battle()` 和原生 `FleetBattle._on_btnStart_pressed()`；
- 等待原生完成状态；
- 返回 outcome、物理模拟时间、FR loss、Boss Damage、双方舰船状态和与 Copy Battle Log 同规则生成的文本；
- 把 HTTP battle submit 节点设为 unavailable，避免 PoC 向官方接口提交结果；
- 不调用 Accept 或 Save；原生完成路径仍会更新内存统计，因此必须使用隔离 user data 目录。
- 首次战斗教学对话会把 `Engine.time_scale` 降至 `0.0001`；Runner 直接走原生启动路径后恢复为 `1.0`，否则 headless 测试会长期停在教学对话。

实际执行由 `poc/fleet_test_runner.gd` 作为第一个 Autoload 完成：等待原版初始化、调用 `await run_demo()`、写出 JSON、打印结果并自动退出。运行细节如下。

## Runtime PoC Result

### 运行方案与 PCK

1. 已找到独立原版 PCK，与项目备份 SHA-256 一致。安装目录中的 `SpaceIdle.exe` 与同名旁置 PCK 分离，PCK 含 `project.binary`。
2. “原版 `SpaceIdle.exe` + 测试 PCK”本轮未实跑。它需要重新打包测试 PCK，而仓库 `AGENTS.md` 当前明确禁止解包/重新打包或创建测试 PCK，因此没有绕过该限制，也没有修改或安装正式 PCK。
3. 按既定优先级改用独立 Godot 4.7.2 官方版，直接运行完整恢复工程；主场景使用原版 `Game.tscn`，原版 Autoload 保持不变，测试 Runner 是新增的第一个 Autoload。

### `user://` 隔离

- 正式版数据目录位于当前 Windows 用户的 Godot `user://` 路径下。
- 测试版使用独立的 `Unnamed Space Idle Fleet Test` 用户数据目录。
- 测试副本的 `project.godot` 使用 `config/use_custom_user_dir=true` 和 `config/custom_user_dir_name="Unnamed Space Idle Fleet Test"`。运行前只确认正式目录存在，未读取其内容；测试结果也回报了测试目录的实际全路径。

### 单场输出

| 项目 | 结果 |
|---|---|
| 输入 | `galaxy1 / g1_1_b1 / galaxy1_battle1`；一组 Corvette，无 Mod，倍率 1.0 |
| 结果 | `victory` |
| Physics tick | 60 Hz；`Engine.time_scale=1.0`；SceneTree 未暂停 |
| 模拟时间 | 4.25 秒 |
| Fleet resources used | 8.12 |
| Boss damage | 0 |
| 玩家舰 | 4 艘 Corvette；2 艘存活，Hull 分别为 12/30、18/30；2 艘被毁 |
| 敌舰 | 6 艘 EnemyBasic，全部被毁 |
| 原始日志 | 70 项，包含伤害、承伤、击毁事件及原始 tick 时间 |
| Copy Battle Log | 已按原版 `BattleReport.build_log()` 规则生成；原版代码的 `substr(2)` 会截掉首行首字母，结果忠实保留该行为 |
| 输出文件 | `results/fleet_test_result.json` |

### 完整性、错误与联网

- `FleetBattle.tscn`、`FleetBattleMobile.tscn`、舰船、武器、投射物、Hazard、Ability、StatusEffect、UI、字体/贴图及 Autoload 均已完整恢复；Godot 修正后的导入日志无 missing resource、加载失败或解析错误。
- 实际运行存在两个非阻断兼容问题：官方 Godot 的 shader compiler 报 custom sampler 条件错误；`Themes.gd:199` 对 `Dictionary.default` 的访问报 Script Error。两者都未阻止原版 Fleet 初始化、物理循环、胜负状态和结果采集。
- 官方编辑器没有游戏 custom build 的 Steam singleton，因此 Steam 初始化失败；这避免了 Steam 联网，但也意味着本轮未验证 custom runtime 差异。
- Runner 给运行期发现的 16 个 `HTTPRequest` 同时设置 HTTP/HTTPS 到 `127.0.0.1:9` 的代理，关闭并清空 Battle submit 队列；未调用 Validate、Accept 或 Save。
- 正常退出时有 106 个 ObjectDB instance 和 5 个 resource 的强制退出泄漏提示；这是 Runner 得到结果后立即退出导致的清理告警，不影响本次战斗结果。

### 本阶段结论与停止点

现有 PoC 已用原版 `Fleet.start_battle()`、`FleetBattle.tscn`、`FleetController` 和 Godot physics loop 完成一场战斗并写出完整 JSON，本阶段唯一成功标准已满足。当前没有阻止“官方 Godot 4.7.2 + 完整恢复工程”单场运行的阻塞点；尚未验证的唯一分支是“custom `SpaceIdle.exe` + 测试 PCK”，原因是项目安全规则禁止构建测试 PCK。

## 建议 API 边界

当前源码最适合封装两个层次：

```gdscript
prepare(config) -> FleetBattle
await run_to_completion(battle) -> Dictionary
```

`config` 至少包含：

```text
galaxy_id
fleet_event_id / battle_id
formation[{ship, grid_position}]
selected_mods{ship: [primary, secondary]}
combat_scale
hazard/support/temp_event selection
fight_enemy_command_ship
fleet_resources_available/committed
physics_ticks_per_second
```

返回字典至少包含：

```text
outcome
simulation_time
fleet_resources_used
boss_damage
player_ships[]
enemy_ships[]
battle_log[]
copy_battle_log_text
```

### 后续推荐架构

```text
Python Optimizer
      -> JSONL / 本地进程接口
Godot 4.7.2 隔离 Runner
      -> prepare(config)
      -> 原版 Fleet.start_battle / FleetBattle / FleetController
      -> collect_result()
      -> JSON result
```

先用可见窗口完成单次验证，再评估 Headless 是否能保持物理、碰撞与场景初始化一致。优化器只生成候选配置和消费结果，不复制任何战斗公式。


不要先做 Beam Search/遗传算法。先证明该适配器在固定输入下重复一致，且与 UI Practice 一致。

## 安全与修改记录

截至本阶段只做了以下变更：

- 新建 `fleetSimulation/` 模块；
- 从项目内原版 PCK 备份以 `--scripts-only` 恢复 836 个脚本到 `fleetSimulation/work/recovered_scripts/`；
- 从同一备份只提取 `game_data.cdb` 到 `fleetSimulation/work/recovered_data/`；
- 从同一项目备份完整恢复到 `fleetSimulation/work/full_recovered/`，并仅在该副本中加入测试 Runner、隔离项目设置和 PoC；
- 新增本报告、模块 README、已运行的 PoC 与 `results/fleet_test_result.json`；
- 在根 README 增加模块目录说明。

未执行：构建/安装/替换 PCK、写入 Steam 游戏目录、读取或修改正式存档、联网提交 Battle、重建战斗公式、构建优化器。仅用官方 Godot 4.7.2 在完整恢复副本中执行单场 headless 测试。

## 主要源码证据索引

- `fleet/interface/BattleInfoPanel.gd`：96-99
- `fleet/interface/FleetEvent.gd`：101-109、1386-1393
- `fleet/Fleet.gd`：2241-2283、2329-2457、2494-2523、2661-2666
- `fleet/FleetBattle.gd`：139-243、461-509、700-773、844-880、931-948、2271-2338、2482-2489
- `fleet/FleetController.gd`：21-31
- `fleet/interface/PopupBattlePracticeSettings.gd`：65-198、225-338
- `fleet/interface/BattleCompletionDetails.gd`：24-91
- `fleet/interface/BattleReport.gd`：39-77、204-206
- `fleet/ships/FleetShip.gd`：382-407、619-731、835-852、958-972
- `fleet/HazardManager.gd`：25-106
- `fleet/ShipRecord.gd`：1-76
- `projectiles/Missile.gd`：68-90
- `projectiles/ChainBeam.gd`：110-128
