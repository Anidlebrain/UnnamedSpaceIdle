---
name: fleet-result-diff
description: 诊断游戏、Fleet Manager、JSON 配置与 Optimizer 输出或搜索结果之间的舰队、战斗、花费、Used FR 等不一致；适用于用户尚不清楚差异起点的调查。仅要求修复代码或开发搜索功能时不使用。
---

# Fleet 结果差异诊断

目标是找出两个 case **第一次可证实的差异**，评估它怎样造成用户关心的结果变化；找到足以解释问题的差异就停止。诊断不自动修复代码，也不把预算内的 `BEST FOUND` 当作全局最优；预算内“未找到”也不证明无解。

## 从现有证据开始

- 先看用户给的截图、游戏/Optimizer 战报、结果 JSON/TXT、日志、数值和测试输出。明确各自的 Galaxy、Node、游戏/资源版本、Node Version、时间、运行入口、比较的场次及指标；证据不足时只索取能区分当前假设的资料。不要先读实现代码。
- 主动核对截图中容易漏看的状态、Mods、阵位、舰船数量与资源数。先按舰种和格子建立对应，再比较不同排列或展示方向；数字舰种/Mod 选择须按**本次实际加载**的配置解释，不能凭印象配对。
- 区分部署报价 `Committed FR` 与战后 `Used FR`，精确值与 UI 取整值，搜索候选与最终原版重放推荐，Baseline 与 Best Found。Boss 要区分首场指标、逐场 `kill_sequence`、完整击杀成本和当前资源可负担性；“使用最优配置”只应用首场。不要用相似的标签推断两边在比较同一量。

## 沿差异缩小范围

按证据选择最短路径，通常从可见结果走向实际生效输入，再到必要的本地文件、现成诊断/运行证据；只有外部差异仍解释不了问题才看相关代码。**任意实际生效参数不同都不能称为同条件**：记录两边的值、来源、是否真的进入本次运行，并评估其对搜索空间/排序、阵型、报价、资源结算或战斗的可能影响。即使差值很小或作用未知，也不能忽略；无法证明其足以解释最终结果时，明确说“发现了有效输入差异，但目前尚不能证明它能完全解释最终结果”。没有证据的字段按未知处理，不按相同处理。

按需查权威入口，不要通读无关目录或维护静态字段清单：

- `fleetSimulation/README.md`：日常 BAT 入口、结果文件、搜索状态与语义；`app/README.md`：Manager 工作流与数据边界。涉及对应子项目时先读其 README。
- `app/docs/search-config-source-of-truth.md`、`app/src/shared/schemas.ts`、`app/src/shared/contracts.ts`：配置来源与结果形状；有疑问时再看 `app/src/shared/search-target.ts`、`app/src/main/services/optimizer-runner.ts` 和对应测试，确认当前实现。
- `fleetSimulation/docs/battle_config_and_determinism.md`、`fleetSimulation/docs/overdeploy_source_of_truth.md`：战斗输入、隐藏状态和 FR 账本；必要时核对 `fleetSimulation/poc/friendly_config_resolver.gd`、`fleetSimulation/poc/fleet_test_runner.gd`、相关回归。

特别核对**运行入口与有效文件**：Manager 的选定 Node Version/Common、共享 Search 和 Optimizer 公共配置会冻结为任务快照并暂存到 `fleetSimulation/map/`；直接运行 `run_optimizer.bat <galaxy> <node>` 则读 map 中的 Node/Common 及其搜索设置。公共 Optimizer 配置优先 map 覆盖、再用 poc 默认；结果里的 `base_config`、Resolver 输出、任务快照及 Godot 日志可帮助验证最终生效值。`app/data/`、`app/runtime/`、`fleetSimulation/map/`、`work/` 可能含个人或派生数据，只按当前问题读取，不覆盖或提交。浏览器版 Manager 的结果是工作流 fixture，不能当作真实本地 Optimizer 战斗证据。

若现有材料不能定位，优先使用已有的节点结果 JSON/TXT、`.godot.log`、候选 JSONL、任务快照或匹配范围的测试；必要时用现有 `run_optimizer.bat` 或隔离验证工具生成**一个能区分假设**的对照。运行前确认它会触及哪些本机输入/结果，保留并恢复用户文件；候选 JSONL 不是已重放的最终推荐，`results/latest.*` 也可能不是当前节点结果。不要无意义地扩大测试。需要检查实现时，只追查差异首次出现的读取、合并/覆盖、转换、Resolver、搜索、原版模拟或输出环节，并以当前代码和可复现证据校正文档假设。

## 结论

先报告差异和双方数值/状态及证据，再说明它如何造成或可能造成所问结果，归类为配置/输入、游戏状态、搜索条件、程序 Bug 或尚未确认。区分“明确解释”“合理可能”“仍需验证”；发现程序处理错误时标明已确认、高度疑似或证据不足，以及差异第一次出现的位置。若仍不能判断，只给下一项最有价值的证据。不要罗列大量相同项；不要自动改业务代码、游戏安装目录或正式存档。
