# 提交范围说明

本项目当前提交的是两块可维护功能的源代码、输入数据和验证依据：

1. 翻译模块：translation/、scripts/、config/config.example.json、status/pck_analysis.json、.codex/agents/translator.toml 和 translation/docs/。
   - translation/translations/inventory.csv 是翻译清单基线。
   - custom.csv、pending.csv、review.csv 和 test_patch.csv 分别保存正式自定义翻译、待处理建议、人工复核项和测试补丁。
   - scripts/validate-translations.ps1 与 scripts/validate-final-translations.ps1 负责技术校验；校验内容包括占位符、标签、换行、转义符、数字和公式。

2. 星系舰队模拟：fleetSimulation/docs/、fleetSimulation/poc/、fleetSimulation/tools/、fleetSimulation/run_optimizer.bat、fleetSimulation/config.json、fleetSimulation/README.md 及选定的稳定回归结果。
   - poc/ 是模拟器与优化器源代码，map/ 是面向用户的 Galaxy/Node 输入，tools/ 是 Godot 进程适配器。
   - fleetSimulation/work/full_recovered/ 是从本机原版 PCK 恢复的隔离运行时，不属于远端提交；模拟器运行仍需要用户在本机准备兼容的 Godot 4.7.2 恢复工程。
   - results/ 只保留稳定、可审计的回归证据；时间戳运行结果、latest.* 和 worker 输出属于本机产物。

3. 舰队优化器管理应用 APP V1：app/src/、app/docs/、app/tests/、app/design.md、app/tokens.css、app/package.json、app/pnpm-lock.yaml、app/pnpm-workspace.yaml、app/electron.vite.config.ts、app/tsconfig.json 和 app/vitest.config.ts。
   - APP V1 暂时封板：提供 Electron 主进程、context-isolated preload bridge、React 配置界面、正式配置导入与版本化保存、Zod 校验、Optimizer 进程管理、实时输出、结果差异展示和 Galaxy 全局默认配置重跑。
   - Phase 2 增加 Node Version/Common 的生命周期管理、默认项切换、模板管理、从模板或版本创建 Node，以及经 `--c` 校验后将 Best Found 安全写回当前 Manager Version 的事务流程。
   - 当前 V1 还包含标准浏览器运行时、舰种选择器、中文工作台样式和对应概念图；网页运行时不执行真实本地 Optimizer。
   - Optimizer 公共配置继续以 `fleetSimulation/poc/optimizer_v2_daily.json` 为唯一运行来源；Manager 只对该文件做结构校验、保留未知字段的原子编辑，不复制为第二份配置。
   - `app/docs/search-config-source-of-truth.md` 记录 Node `search`、daily JSON、Galaxy Common 与 Runner/Optimizer 的读取、覆盖和最终生效位置。
   - 应用只负责管理和调用已有 fleetSimulation Optimizer；不会重新实现战斗/搜索算法，也不会自动安装 PCK 或修改 Steam 游戏目录。

## 不提交的文件

以下文件已在 .gitignore 中排除，或不应手工加入提交：

- config/config.local.json：包含本机游戏路径和工具路径。
- backup/：原版 SpaceIdle.pck 及其备份元数据。
- translation/work/：提取、转换、批次输入输出和日志。
- translation/output/：测试/正式 PCK 构建产物及构建元数据。
- fleetSimulation/work/：原版恢复脚本、数据和运行时文件。
- fleetSimulation/map/：本机 Galaxy/Node 输入文件，按要求不纳入 Git。
- app/data/：个人本机正式配置和导入结果，整个目录不纳入 Git。
- app/runtime/：应用运行时任务快照和临时状态，不纳入 Git；仓库只提交 `app/runtime/.gitkeep`。
- app/node_modules/、app/out/、.pnpm-store/：依赖、构建产物和包管理器缓存，不纳入 Git。
- .agents/、app/.hallmark/：本机 Codex/设计工具资源和日志，不纳入 Git。
- *.log、地图运行结果、时间戳结果、latest.* 和多 worker 临时结果。
- 任何 Steam 游戏目录、存档或原版 PCK。项目规则禁止自动安装或替换这些文件。

排除这些文件的原因是它们要么含有本机路径/运行状态，要么是可由源数据重新生成的派生物，要么属于原版游戏内容；提交它们不能提高项目的可维护性，反而会造成体积、版权和误安装风险。

## 本机验证

在已准备本机配置、原版备份和隔离 Godot 工程后，可运行：

    .\scripts\init.ps1
    .\scripts\validate-translations.ps1
    .\scripts\validate-final-translations.ps1
    .\fleetSimulation\run_optimizer.bat g6 B8

翻译脚本只检查项目副本和翻译数据；舰队模拟器把输入和 PoC 脚本复制到隔离 Godot 工程后运行。上述命令不会自动修改 Steam 游戏目录，也不会安装 PCK。

## 提交前检查

    git status --short
    git add --all
    git diff --cached --stat
    git diff --cached --check

提交前应确认暂存区中没有 SpaceIdle.pck、config.local.json、translation/output/、translation/work/ 或 fleetSimulation/work/。
