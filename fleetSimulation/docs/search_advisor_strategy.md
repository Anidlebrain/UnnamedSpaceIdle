# 搜索改进与推荐阵容搜站位

## G8 B4 记录说明

输入来自本机 `map/g8/B4-1/`、`map/g8/B4-2/`，分析未修改这些文件。

| 记录 | 输入 | 输出 | 终止原因 |
| --- | --- | --- | --- |
| B4-1 | 900 秒 / 900 次模拟；2 Fighter + 1 Cruiser + 1 HeavyCruiser | 基线 Used FR 58.31，搜索结果 53.83；总计 902 场，约 551 秒 | SIMULATION BUDGET REACHED |
| B4-2 | 30 秒 / 30 次模拟；1 Fighter + 1 Cruiser + 1 HeavyCruiser | Used FR 44.60；总计 2 场，约 32 秒 | TIME BUDGET REACHED |

B4-1 实际有小幅改进，但未找到 B4-2 更便宜的舰队。两者相差 9.23 FR。B4-2 主要完成输入基线验证与最终重放，不代表 30 秒完成了广泛搜索。900 秒也不代表跑满 900 秒：搜索次数和时间是两个独立上限。

旧结果记录了 285 个数量组合、约 768 万个站位/装配候选；只模拟了 26 个数量组合。900 个排队候选中，全局通道 50、当前优胜通道 513、档案通道 337。未访问空间不能根据这些结果判断优劣。

## 算法中的盲点与修改

1. 旧的删船、换装、移动通常各改一个维度。删船后的原位失败，会削弱该舰队继续获得搜索机会的能力；而省资源的方案可能需要一起换装和重排。
2. 旧邻域流按操作类型轮转。一类候选用尽时即生成当前舰队的随机站位，即使其他类别还有未访问候选。用尽较快的删船/Mod 类会让大量预算回到同一舰队。
3. 全局数量组合覆盖与舰队站位覆盖不是同一回事。一次不好的随机布局无法排除一个数量组合。

默认 `portfolio` 现在交错处理：全局舰队、当前优胜邻域、档案、持续站位搜索和组合变异。持续站位搜索保留当前优胜舰队及按舰种去重的单组删除舰队，不以删除后是否获胜为准入条件；当前胜者只是站位变化时，不重建同一个搜索流。组合变异同时修改数量、Mods 和位置，不要求中间状态逐步变好。邻域耗尽处理先查找其他尚未用完的类别。

固定舰队的较小站位空间使用组合序号与互质步长遍历，不存储全部阵型，也不重复生成相同站位。超过十亿个站位或计数超出有效范围时回退到随机布局。此机制适配实际列数，同类舰船不做无意义的排列重复，镜像仍需独立模拟。自动搜索流有 32 个的内存上限；淘汰后重新建立可能重复生成，但全局战斗缓存继续去重。

这些调整改变搜索机会和顺序，不修改战斗规则、FR 计算或胜负排序，不承诺预算内必定找到指定方案。

## 原版 Advisor 证据

已有恢复脚本提供了直接证据，无需提取新 PCK 或访问游戏存档：

- `work/recovered_scripts/fleet/interface/BattleCompletionsPopup.gd`：说明推荐来自使用相应条件通关的其他玩家；非精准部署时明确提示位置不正确。
- `work/recovered_scripts/fleet/FleetBattle.gd::_on_BattleCompletionsPopup_deploy_suggested_incomplete`：复制推荐战斗记录，将各组的 `grid_position` 清为 `(0, 0)`，随后重新部署。因此显示出来的原始站位不可信，但数量和 Mods 可作为搜索输入。
- 同文件 `find_best_matching_bcd_from_list_for_advisor`：按舰船数量、临时节点与 Mods 等条件筛选。实际模拟仍须使用当前输入的倍率、Hazard、Support 和 Boss HP。
- `work/recovered_scripts/fleet/HTTPGetBattleSuggestion.gd` 与 `Fleet.gd::build_suggest_battle_solution_query`：推荐来自在线服务，查询带节点、版本、战斗倍率、Hazard 和 Boss 状态。本地不是一张静态推荐表。

结论：适合把用户录入的推荐舰队作为站位搜索输入。此次保留 HTTP 隔离，不请求在线服务、不上传战斗结果。

## 配置与结果语义

在原节点 JSON 保留其余字段，将推荐舰队填入 `baseline.formation` 和 `baseline.loadouts`，并设置：

```json
"search": {
  "strategy": "advisor_seeded",
  "profile": "fast",
  "simulation_clock": "offline_fixed_step",
  "max_wall_seconds": 300,
  "max_simulations": 1000000,
  "workers": 4
}
```

`baseline.enabled` 保持 `true`，数字舰种和数字 Mod 槽位规则不变。实际第一场可以输；但非法坐标、未启用舰种、数量超出配置范围、部署超预算或模拟错误仍会被拒绝。输入只提供数量和装配时，可给每组随意分配一个合法空格。

`advisor_seeded` 固定舰队、Mods，集中搜索站位；`portfolio` 继续优化数量、Mods 和站位。两种搜索策略与 Boss 的三个评分目标相互独立。

### G8 B2 启动故障与第二次改进

B2 输入确实是 240 秒、240 次模拟，但原始 `B2.godot.log` 显示 Runner 在解析阶段因缺少 `fleet_search_regression.gd` 而加载失败。上一版把该脚本加入了 Runner 的 preload，却漏加到 BAT 的显式复制清单。隔离基准复制全部脚本，未覆盖这个日常部署差异。Godot 主进程仍运行，因此搜索本身的时间限制未能生效。PowerShell 又等进程结束才输出 stderr，导致界面只显示初始化。

已修复复制清单，并增加对本地脚本依赖的检查。日常启动器同时读取 stdout/stderr，识别脚本错误并停止自己启动的进程树；启动与整体时间另有外层保护。正常情况下仍由搜索算法提前收尾，外层强制停止只用于异常，不能保证保留尚未验证的最终结果。

搜索从单纯打乱站位遍历改为：

1. 真实验证输入布局；正常完成的失败也进入位置搜索。
2. 保留最多四个按真实成绩排名的父阵型，优先搜索移动、交换和镜像。失败按既有战斗成绩排序，胜利按实际 Used FR 排序。
3. 两个局部调度机会之后至少安排一个全局站位；局部邻域用尽也回到全局。共享缓存去重，固定舰种和 Mods 不变。比例是候选调度比例，不是保证的模拟数量比例。
4. 用户可选普通战 `target_used_fr`。实际胜利达到目标后结束探索，再做最终重放。未达到则继续到时间、次数或完整站位空间耗尽。不会因少量失败或短期无改进宣称无解。

例如目标 27.3：

```json
"search": {
  "strategy": "advisor_seeded",
  "profile": "fast",
  "max_wall_seconds": 240,
  "max_simulations": 1000000,
  "workers": 4,
  "target_used_fr": 27.3
}
```

不需要知道数学上的最优 FR；已知可达目标或个人可接受成本都可以。阈值比较真实数值，不按截图显示的小数位做额外四舍五入。用户的 B2 示例中，31.81 属于带 HeavyCruiserBeamMod 的方案，27.3 是不带该 Mod 的 Advisor 记录，不能把两者当成同一固定装配空间的成绩。

新增 `<node>.result.candidates.jsonl` 实时记录每个已完成探索候选的具体站位、装配、胜负、Used FR 和错误。日志汇总已搜索的唯一站位数、胜负数、最佳成本、目标差距、剩余时间；没访问过的站位不标作失败。三种不同舰组在两列十格是 720 个独特站位。最终重放和 Boss 后续序列仍以结果 JSON 中的验证记录为准，不计入此探索流水。

后续可以考虑在输入、原版版本、倍率、敌阵、Hazard、Support 和 Mods 完全一致时恢复搜索缓存，避免重复运行从头搜索；目前尚未实现跨运行续搜。默认不加“停滞若干秒即放弃”，以免再次漏掉需要多组一起移位的可行方案。

普通战没有找到胜利时：`best_result` 为空、状态 `NO VICTORY FOUND`，TXT 没有可复制阵型。即使初始阵型战败，找到胜利后仍执行原版最终重放。站位遍历结束仅表示所录入舰队的站位已处理；整体结果仍不声明全部舰队全局最优。

## 简单验证入口

```powershell
python fleetSimulation/tools/benchmark_preserved.py --label search-logic --config fleetSimulation/map/g8/B2.json --common fleetSimulation/map/g8/common.json --seconds 45 --extra --search-regression
```

该逻辑检查不执行战斗，覆盖一至三列无重复站位遍历、搜索流不因位置改变而重启、删船候选保留、邻域耗尽、组合变异合法性、推荐输入解析和失败回退。真实 smoke 继续使用原隔离基准工具；日常入口保持 BAT。`benchmark_preserved.py` 会备份并恢复暂存工程输入。完整长时间、多节点测试留给用户执行。

2026-09-28 简单验证结果：

- 14 项逻辑检查通过。
- 默认策略使用 B4-1 输入，180 秒预算、4 workers：约 176.5 秒、282 场，结果 53.83 FR，原版重放一致。此次短测尚未自行发现 44.60 FR 的三舰方案，不能据此宣称已解决所有局部停滞。
- 推荐阵容策略使用 B4-2 的三舰与 Mods，但故意改为 Fighter A1、Cruiser A2、HeavyCruiser A3：初始战败；90 秒预算内约 86.7 秒、114 场，找到 Fighter A5、Cruiser A4、HeavyCruiser B2，44.60 FR，原版重放一致。全部探索候选都来自推荐舰队站位通道。
- 单 Fighter 失败路径：约 25.3 秒、10 个站位全部处理，输出 `NO VICTORY FOUND` / `ADVISOR POSITIONS EXHAUSTED`，`best_result` 为空，TXT 不包含可复制阵型。

三个 smoke 的战斗错误计数均为零。隔离工程仍有已知的 shader 编译器提示与退出资源清理提示；未出现未修复的脚本错误。暂存输入已逐文件核对恢复。本机证据在 `results/optimizer_v3/search_logic_20260928c/`、`search_b4_portfolio_20260928/`、`search_b4_advisor_20260928/`、`search_advisor_no_win_20260928b/`（忽略目录）。

第二次改进验证（同日）：

- 启动器五项小测试通过：BAT 本地脚本依赖完整、解析错误立即退出、启动超时、整体超时、正常 stderr 实时传递。命令：`python -m unittest fleetSimulation/tools/test_optimizer_runner.py -v`。
- 搜索逻辑检查增至 19 项并通过，新增固定装配局部移动、失败不能触发目标、目标未达继续、达到目标停止及非法阈值检查。
- 经过真实日常 PowerShell 启动器的 B2 隔离短测：重巡无 Primary Mod，75 秒预算，约 70.5 秒算法时间/72.3 秒启动器时间，21 个唯一站位（2 胜、19 负）加一次重放。结果 31.69 FR，目标 27.3 未达；不据此推断目标无解。流水 21 行与结果唯一候选一一对应，日志包含实时心跳、胜负、720 站位总数与目标差距。
- 以刚验证的 31.69 阵型设定 31.69 测试阈值：仅运行输入验证和最终重放两场，约 24.3 秒，`TARGET USED FR REACHED`；虽请求四个 worker，但已达到目标，未启动多余 worker。该阈值仅用于验证早停，不更改用户 B2 目标。
- 测试未覆盖用户的 B2 JSON、common 或正式结果，暂存工程已逐文件核对恢复。证据：`advisor_guided_logic_20260928b/`、`b2_guided_launcher_20260928/`、`b2_target_replay_20260928/`，均位于忽略的 `results/optimizer_v3/`。

本次短测显示四 worker 的初始化与预热约占前 55 秒，短预算下不能假设更多 worker 必然更快。后续提速优先评估预热与基线验证重叠、按空间规模选择 worker 数量；目前仍尊重用户设置，不在没有对照验证的情况下自动更改并行度。
