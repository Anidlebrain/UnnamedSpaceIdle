# Unnamed Space Idle 舰队优化器管理器

这是舰队优化器管理应用的 Phase 1 实现，基于 Electron、React、Vite、TypeScript、Zod 和 Vitest。

## Phase 1 范围

- 从 `fleetSimulation/map/` 扫描并一次性导入 Galaxy/Node 配置到 `app/data/`；已有 Manager 数据不会被导入覆盖。
- 以 Galaxy、Node、版本和 Common Profile 选择正式配置，并通过 Zod 校验后原子保存。
- 通过 context-isolated preload bridge 调用 Electron 主进程；Renderer 不直接访问文件系统或启动进程。
- 将选定配置安全暂存到 `fleetSimulation/map/`，启动现有 `run_optimizer.bat`，实时显示 stdout/stderr。
- 检查退出码、结果文件时间和内容变化、结果 JSON 结构以及 Galaxy/Node 身份，避免误读旧结果。
- 展示本次搜索的 Best Found 结果，并比较 Verified Baseline 与最佳阵型/Mod 配置的差异。

应用层不重新实现战斗模拟、搜索算法或结果复制逻辑，也不会自动安装 PCK、修改 Steam 游戏目录或覆盖已有正式配置。

## 开发

在 `app/` 目录执行：

```powershell
pnpm install
pnpm dev
```

常用检查命令：

```powershell
pnpm typecheck
pnpm build
pnpm test
```

开发模式默认把正式配置保存在 `app/data/`。打包运行时使用 Electron 的 `userData/fleet-manager-data`，避免把可写数据放入 asar。

## 数据边界

- `app/data/`：个人本地正式配置、Galaxy/Node 版本和 Common Profile；整个目录已加入 Git 忽略，不提交任何个人数据。
- `app/runtime/`：最近一次任务快照等运行时状态；已加入 Git 忽略。
- `fleetSimulation/map/`：Optimizer 工作区，只有用户明确导入或启动任务时才写入。

架构细节见 [`docs/architecture.md`](docs/architecture.md)，产品范围见 [`docs/Unnamed Space Idle 舰队优化器管理界面 PRD v1.0.md`](docs/Unnamed%20Space%20Idle%20舰队优化器管理界面%20PRD%20v1.0.md)。
