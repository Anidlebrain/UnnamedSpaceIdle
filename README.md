# Unnamed Space Idle 舰队优化与管理工具

本仓库围绕《Unnamed Space Idle》的 Fleet Battle 搜索与舰队管理展开。核心由两个活跃项目组成：`fleetSimulation/` 复用游戏原版战斗逻辑进行舰队搜索，`app/` 提供配置管理、搜索运行和结果查看界面。`translation/` 保存早期中文本地化工作及验证资料，目前因无法可靠恢复完整原文 key 映射而暂停批量翻译。

## 项目组成

- [`fleetSimulation/`](fleetSimulation/README.md)：Fleet Battle 原生模拟复用、Optimizer 搜索与命令行工作流。日常入口是 `fleetSimulation/run_optimizer.bat`；搜索与战斗规则以该目录 README 和当前代码为准。
- [`app/`](app/README.md)：面向 Optimizer 的 Electron + React 管理界面，负责配置、调用既有 Optimizer、显示日志与比较结果，不另行实现搜索或战斗模拟。
- `translation/`：中文本地化相关数据与历史验证。来源 key 未可靠恢复前，不进行批量翻译、合并或正式资源构建。
- `docs/`、`status/`、`scripts/`、`tools/`：通用说明、项目状态和维护脚本/工具说明。

## AI 辅助开发

本项目在代码编写、问题分析、文档整理和验证过程中使用 AI 辅助开发。AI 生成或建议的内容由维护者结合仓库代码、原版行为和可复现结果审核；项目行为与功能结论以当前实现和验证证据为准。舰队模拟和搜索仍由仓库中的 Optimizer 调用隔离工程内的原版 Godot 战斗逻辑执行。

## 开发入口

Optimizer 的参数、输入输出、搜索策略与验证限制见 [`fleetSimulation/README.md`](fleetSimulation/README.md)。管理应用的架构、数据边界与命令见 [`app/README.md`](app/README.md)。

在 `app/` 目录运行开发和检查命令：

```powershell
pnpm install
pnpm dev
pnpm format
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
```

通用项目脚本：

```powershell
.\scripts\init.ps1
.\scripts\show-status.ps1
.\scripts\detect-game.ps1
.\scripts\validate-translations.ps1
```

## 本机数据与安全边界

- `app/data/`、`app/runtime/`、`fleetSimulation/map/`、`fleetSimulation/work/`、`translation/work/`、`translation/output/` 和备份目录包含本机配置或派生数据，按仓库忽略规则处理，不应作为通用项目资料提交。
- Optimizer 使用隔离的 Godot 工程和 `user://` 目录，不读取或修改正式存档，不自动安装或替换游戏 PCK。
- 安装或恢复测试 PCK 会修改游戏目录，必须由用户明确决定并使用仓库现有脚本；不要手动替换游戏文件。
- 提交边界见 [`docs/submission-scope.md`](docs/submission-scope.md)。
