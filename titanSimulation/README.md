# Titan 主线搜索器（研究版）

独立于 `fleetSimulation/` 和 `app/`。已实现 **160+ 区域的原生战斗联合搜索**：三门核心武器、二选一里程碑、四项普通目标设置、阵列组成/顺序、每发攻击的有序部件目标。护盾与阵列核心采用录入的可达等级，固定里程碑自动应用。

- `boss_once`：实际击杀所选首领一次即停止，不要求多次成功。
- `farm_distance`：优先搜索区域内更远的挂机距离，推荐配置必须通过独立长战斗复核。
- 静态玩家参数单独保存；选择区域、层域、模式不会修改它。

这是可运行的研究搜索器。结果是预算内找到的配置，不保证全局最优；尚未与用户正式游戏实战做完整 A/B 对照。示例全部是合成数据，不能当作截图中的玩家数值。

## 开始使用

需要 Python 3.10+、已有恢复工程副本、兼容 Godot。当前适配原版 0.90.0.1 / Godot 4.7.2（保留 0.85.1.0 兼容分支），无 Python 第三方依赖。以下命令在本目录执行。

先交互录入一次玩家档案：

```powershell
.\run_titan.bat configure
```

本机 `local/current_source.json` 已指向更新后的独立恢复副本；仍可用 `--source` 显式指定已有恢复工程。默认新建 `local/player.json`，已有文件不会覆盖；之后直接编辑该文件，或用 `--output local/player2.json` 新建另一份。不读取游戏存档。

再选择区域、层域和模式：

```powershell
.\run_titan.bat search --godot E:\tools\Godot_v4.7.2-stable_win64\Godot_v4.7.2-stable_win64_console.exe --player local\player.json --sector 164 --layer antumbra --mode boss_once

.\run_titan.bat search --godot E:\tools\Godot_v4.7.2-stable_win64\Godot_v4.7.2-stable_win64_console.exe --player local\player.json --sector 164 --layer antumbra --mode farm_distance
```

| 层域 | 参数 |
|---|---|
| 表象域 | `surface` |
| 伪本影域 | `antumbra` |
| 半影域 | `penumbra` |
| 本影域 | `umbra` |

默认总预算 **180 秒**，包含复制、加载、候选试验和最终复核。`--budget-seconds 300` 可延长；`Ctrl+C` 可中断，已完成试验和已验证结果保留。低预算被冷启动耗尽时会明确报告没有结果。

默认 `--clock fixed` 使用固定 60 FPS，游戏时间倍率保持 1。`--clock realtime` 可作实时对照，同样预算内候选更少。当前一组实时与固定模式的击杀时间差约 0.16%，不代表所有临界配置的误差上限。

## 最少需要录入什么

| 输入 | 获取方式 / 原因 |
|---|---|
| 统计总览的泰坦伤害、泰坦最大护盾 | 直接录入当前版本显示值，支持科学计数法；0.90 校准已不再加在玩家统计上 |
| 读数时实际层域、伪本影和半影校准值 | 0.90 按原版降低对应层域敌人强度并执行上限；不再对玩家伤害/护盾乘除校准。旧版保留原有归一化 |
| 当前阵列容量、读数时阵列核心等级 | 去除固定里程碑和层域容量加成，得到基准 |
| 阵列核心的 **Base Damage** | 反推总览缺少的阵列专属成就倍率；不是序列顶部合计伤害 |
| 各核心可同时达到的等级 | 未解锁普通武器省略。必须能支持三槽同时装备，包括重复武器 |
| 本轮四层域最高已到达区域、本影合并边界、再整合及 Galaxy 12 解锁状态 | 检查准入、实际层域、首领前置；Galaxy 12 状态影响 165+ 敌人缩放 |

在临时战斗技能结束后录入统计。范围是基础 **Titan** 船体；不包含手动施法、资源点击或其他船体。前三轮基础强化是此 160+ Titan 范围的先决条件，自动设置。

默认护甲伤害 `1` 不必填；当前源码中其余泰坦射速/射程/回复等修正来自核心或原生技能，无需逐项输入。代码检查外部来源，出现未支持的新来源会拒绝搜索。阵列护盾、速射能力按原版规则执行。设施、研究、成就、敌人数据、技能费用和固定里程碑均不手填。

这是**等级约束搜索**，不分配升级资源：重复类型按同一录入等级使用，不验证整套配置的购买成本。若三槽不能同时达到所填等级，请填保守的共同等级。新版结构见 `examples/player.synthetic.0.90.json`（旧版示例仍保留），巨大数值仅用于成功路径测试。

本影合并边界本身不属于本影：源码规则是 `区域 < 边界` 才属于本影域。选错实际层域会拒绝。伪本影/半影首领还要求本轮表象域已到达下一区域。

0.90 档案的 `statistics.game_version` 必须为 `0.90.0.1`，`progress.galaxy12_unlocked` 必须明确填写。旧版或未标版本的统计需要重新采集，不可只改版本标签。新增技能/里程碑、`ships2` 敌人、干扰场和充能效果均从新版数据及原生战斗读取。

## 搜索和结果

每次新建 `results/<标签>/` 和独立 `work/<标签>/`。默认自动生成标签，可用 `--label` 指定全新标签。

- `result.txt`：武器槽位、等级、里程碑选项、四项目标、护盾、阵列顺序与目标列表。
- `result.json`：完整配置、区域、验证证据、耗时和停止原因。
- `input.json`：本次静态输入及归一化结果，不改变原档案。
- `trials.jsonl`：逐个已完成试验，包括种子、护盾、击杀、技能、距离和阵列计数。
- `startup.json`：初始化耗时；`work/<标签>/manifest.json`、请求/响应和 stdout/stderr 保留来源与诊断。

算法采用多种初始装备、精英候选局部变异和随机重启，原版 Godot 执行每场战斗。变异覆盖武器类型/槽位、所有已解锁分支、目标字段、阵列增删换序和每发目标优先列表。一次加载服务多场，场间重建装备并清理战斗状态。

挂机粗查距离并向更远处细化，再按距离降序复核。默认距离网格步长 20，总是包含首端 `start+1` 和末端 `end-1`；`--distance-step 1` 提高分辨率，但预算内覆盖减少。没有假定所有距离单调变难，也没有证明每个更远距离都不可用。

最终挂机门槛：**3 个与短场不同的种子；每次至少 120 模拟秒且至少 10 次巨型敌人击杀；零死亡、距离始终保持；最后两组三个周期的最低剩余护盾不能下降超过 0.2 个百分点**。复核内部连续战斗，不在波次间重置护盾、阵列或冷却。趋势检查拒绝明显持续耗盾；有限样本不能证明无限期稳定。

`--farm-seconds` / `--farm-cycles` 可提高门槛，不能低于默认值。单次最长模拟时间 `max(600, farm_seconds*3)`，仍受总预算约束。BOSS 每候选默认最多 90 模拟秒，可用 `--boss-seconds` 调整。短场未击杀只是探索结果，不是不可击杀证明。

`KILL_FOUND` / `BEST_VALIDATED_DISTANCE_FOUND` 才有推荐。`NO_*_WITHIN_BUDGET`、初始化耗尽或未完成复核不会输出短场冒充的成功结果。退出码：0 有已验证结果，3 没有完成符合条件的结果，2 输入或原生运行错误。

## 验证和研究工具

```powershell
$env:TITAN_RESEARCH_SOURCE='E:\code\UnnamedSpaceIdle\titanSimulation\work\update_20261106_5e352f56\recovered'
python -m unittest discover -s tests -q

# 显式长测试：四层域、连续挂机、死亡后重置；仅用合成数据
python tests/run_search_integration.py --source work\update_20261106_5e352f56\recovered --godot E:\tools\Godot_v4.7.2-stable_win64\Godot_v4.7.2-stable_win64_console.exe --label new_integration_label

# 0.90 专项：新阵列效果、干扰场、校准/进度切换、场间重置与两种搜索模式
python tests/run_update_integration.py --source work\update_20261106_5e352f56\recovered --godot E:\tools\Godot_v4.7.2-stable_win64\Godot_v4.7.2-stable_win64_console.exe --label new_update_label

.\run_titan.bat inspect --sector 164 --layer antumbra
.\run_titan.bat check-candidate --sector 164 --layer antumbra --candidate examples\candidate.json
.\run_titan.bat normalize --snapshot examples\stats_snapshot.0.90.json
```

静态研究工具的 `RESEARCH_ONLY` / `ready_for_combat:false` 表示它们自身没有完成战斗验证；不能取代 `search` 的最终复核。

保留 `native-smoke`，支持 `--synthetic-battle boss_once|farm_distance`、`--synthetic-strength strong`、`--batch-audit --seed 12345 --clock fixed`。该入口的 `--timeout` 只限制原生进程，区别于搜索的端到端预算。

源码依据、实验与最新实测见 [研究设计](docs/research.md) 和 [开发记录](docs/checkpoint.md)。

## 文件边界与限制

只读已有恢复工程，不提取 PCK；仅在本目录 `work/` 独立副本及独立 `user://` 执行。不修改来源、Fleet 暂存工程、Steam 或正式存档；禁用存档加载、Steam 和外部 HTTP 请求。`local/`、`work/`、`results/` 均忽略提交。

原版初始化耗时取决于机器和当前负载，约 60–100 秒；完整长挂机复核可能需要提高 `--budget-seconds`。旧版合成首领约 82 秒、挂机约 156 秒，新版实测另见开发记录。这些是合成场景实测，不是所有参数的速度保证。真实玩家状态对照、临界配置实时/固定差异仍需后续验证。
