# Unnamed Space Idle 中文翻译补丁

这是《Unnamed Space Idle》内容探索与中文翻译补丁的长期维护工程。项目根目录就是 `E:\code\UnnamedSpaceIdle`，翻译资料集中在 `translation/`。

## 当前阶段

- Phase 2：PCK 与本地化结构验证已完成。原版 PCK 已按 SHA-256 备份；已定位 Godot 编译翻译资源；已生成并静态验证只改一条普通标签的 `translation\output\SpaceIdle.test.pck`。
- app-Phase 1：舰队优化器管理桌面应用已完成。`app/` 提供 Electron + React + TypeScript 界面，负责配置导入、版本化保存、JSON 校验、Optimizer 启动、实时输出和 Baseline/Best Found 差异展示；实际战斗与搜索仍复用 `fleetSimulation/`，应用不会自行重实现或自动安装 PCK。
- app-Phase 2：配置生命周期和结果应用流程已完成。支持 Node Version/Common 的新建、复制、重命名、删除、默认项切换，模板管理和从模板/版本创建 Node；支持通过现有 `run_optimizer.bat --c` 安全应用 Best Found，并在校验失败、退出码非零或结果身份不匹配时保护 Manager 数据。
- APP V1 暂时封板：在上述能力基础上完成 Galaxy 全局默认配置重跑、网页运行时兼容、舰种选择器和中文工作台 UI；全局重跑只发现变化，不自动写回配置，后续迭代另行开启。

测试 PCK **尚未安装**，Steam 游戏目录未被修改。

## 关键目录

- `config/`：本机配置；`config.local.json` 不提交
- `translation/`：翻译子项目；包含词典、正式数据、工作区、输出、状态和本地化文档
- `fleetSimulation/`：Fleet Battle 原生模拟复用研究；包含侦察报告、最小 PoC 和本地恢复工作区
- `app/`：舰队优化器管理桌面应用；包含 Electron 主进程、preload bridge、React renderer、共享契约、APP V1 文档、设计规范和测试。`app/data/` 是个人本机数据目录，整个目录不提交
- `status/`：游戏/PCK 基础分析等通用状态
- `docs/`：通用项目文档；翻译报告位于 `translation/docs/`
- `scripts/`：检测、校验、备份、安装和恢复脚本
- `backup/`：按原包 SHA 建立的备份，不提交
- `translation/work/`：翻译提取、转换与日志，不提交
- `translation/output/`：翻译构建产物，不提交
- `tools/`：只记录外部工具，不存放 GDRETools 二进制

翻译资料统一存放在 `translation/`；根目录仅保留通用项目资料和操作入口。

## 常用命令

```powershell
.\scripts\init.ps1
.\scripts\show-status.ps1
.\scripts\detect-game.ps1
.\scripts\validate-translations.ps1
```

人工安装测试包前必须退出游戏，然后由用户明确决定是否运行：

```powershell
.\scripts\install-test-pck.ps1
```

恢复时必须显式指定备份：

```powershell
.\scripts\restore-pck.ps1 -BackupDirectory "E:\code\UnnamedSpaceIdle\backup\2026-09-06_47E161C7"
```

舰队优化器管理应用的 Phase 1/2 开发命令：

```powershell
cd app
pnpm install
pnpm dev
pnpm format
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
```

安装和恢复脚本都会拒绝在游戏运行时操作，并采用临时文件、SHA-256 校验和安全替换。不要手工删除游戏 PCK 后再复制。

## 提交范围

项目的可提交功能分为三块：translation/ 负责本地化数据、占位符校验和测试 PCK 流程；fleetSimulation/ 负责基于原版 Fleet Battle 场景的参数化模拟与舰队优化；app/ 负责本地配置管理和 Optimizer 桌面操作界面。提交边界和本机派生文件的处理方式见 docs/submission-scope.md。
