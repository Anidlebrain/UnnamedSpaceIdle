# Unnamed Space Idle 舰队优化器管理器

这是舰队优化器管理应用的 APP V1 封板实现（包含 Phase 1、Phase 2 和当前 Phase 4 工作台能力），基于 Electron、React、Vite、TypeScript、Zod 和 Vitest。

## 已实现范围

- 从 `fleetSimulation/map/` 扫描并一次性导入 Galaxy/Node 配置到 `app/data/`；已有 Manager 数据不会被导入覆盖。
- 以 Galaxy、Node、版本和 Common Profile 选择正式配置，并通过 Zod 校验后原子保存。
- 通过 context-isolated preload bridge 调用 Electron 主进程；Renderer 不直接访问文件系统或启动进程。
- 将选定配置安全暂存到 `fleetSimulation/map/`，启动现有 `run_optimizer.bat`，实时显示 stdout/stderr。
- 检查退出码、结果文件时间和内容变化、结果 JSON 结构以及 Galaxy/Node 身份，避免误读旧结果。
- 展示本次搜索的 Best Found 结果，并比较 Verified Baseline 与最佳阵型/Mod 配置的差异。
- 人工新建、复制、重命名、删除、切换 Node Version，并设置默认 Version；各 Version 使用独立 JSON 文件。
- 人工新建、复制、编辑、重命名、删除、切换 Common，并设置默认 Common。
- 将当前 Node Version 保存为人工模板，并从模板或任意当前 Node Version 创建新 Node；创建时仅重写 Galaxy/Node 身份。
- 复用现有 `run_optimizer.bat <galaxy> <node> --c` 应用 Best Found；只有 BAT 成功且修改后的 Node JSON 通过结构与身份校验后，才原子覆盖当前 Manager Version。
- 串行重跑当前 Galaxy 的全部 Node 默认 Version，并统一使用该 Galaxy 的默认 Common；整批任务持有现有全局 Optimizer 锁。
- 批量结果按 `formation_key`（缺失时回退到结构化 Formation/Loadout diff）过滤，仅重点列出需要重新配置的节点；失败节点独立显示且不会复用旧 Result。
- Galaxy 重跑只做变化发现，不执行 `--c`、不更新 baseline、不创建 Version，也不批量采用 Best Found。
- Phase 4 工作台 UI：结构化 Formation / Loadout / Common 编辑、选择上下文、保存状态、Best Found / Diff、模板与 Galaxy 重跑均以中文日常操作为主，Raw JSON 收入高级区。
- 将 `fleetSimulation/poc/optimizer_v2_daily.json` 作为唯一的 Optimizer 公共配置直接管理；可视化编辑搜索舰种、组数范围、允许 Mod 和全局预算，未知字段保留。单节点与 Galaxy 重跑均继续通过既有 BAT 读取这同一文件，不建立第二份运行配置。
- Loadout 选择由当前 `allowed_mod_slots` 有序数组驱动：`None + 1 Mod` 显示开关，多个 Mod 显示下拉，无合法 Mod 显示不可用；保存仍保持既有字符串 ID 或数字索引表示。
- Renderer 同时支持 Electron preload 和标准浏览器运行时。浏览器工作区使用 `localStorage` 持久化配置，可用于网页部署与 UI 工作流；真实本地 Optimizer 执行仍由桌面 Main 进程负责，后续网页部署需要受控的本地服务或服务端执行器。

应用层不重新实现战斗模拟、搜索算法或结果复制逻辑，也不会自动安装 PCK、修改 Steam 游戏目录或覆盖已有正式配置。

## 开发

在 `app/` 目录执行：

```powershell
pnpm install
pnpm dev
```

常用检查命令：

```powershell
pnpm format
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
```

`pnpm format` 通过 `scripts/format.ps1` 使用仓库固定版本的 Prettier，格式化 `src/`、`tests/` 和 TypeScript/JSON 配置；`pnpm format:check` 只检查格式，不修改文件。

`tests/real-optimizer-smoke.mts` 是真实 Optimizer + `--c` 安全 Smoke；它会先备份所有触及的工作区文件，并在 `finally` 中按原始字节恢复。

开发模式默认把正式配置保存在 `app/data/`。打包运行时使用 Electron 的 `userData/fleet-manager-data`，避免把可写数据放入 asar。

## 数据边界

- `app/data/`：个人本地正式配置、Galaxy/Node 版本和 Common Profile；整个目录已加入 Git 忽略，不提交任何个人数据。
- `app/runtime/`：最近一次任务快照等运行时状态；已加入 Git 忽略。
- `fleetSimulation/map/`：Optimizer 工作区，只有用户明确导入或启动任务时才写入。
- `fleetSimulation/poc/optimizer_v2_daily.json`：跨 Galaxy 的 Optimizer 公共配置，也是 BAT 的直接输入。Manager 原子编辑该权威文件；它不复制进 `app/data/`。

架构细节见 [`docs/architecture.md`](docs/architecture.md)，产品范围见 [`docs/Unnamed Space Idle 舰队优化器管理界面 PRD v1.0.md`](docs/Unnamed%20Space%20Idle%20舰队优化器管理界面%20PRD%20v1.0.md)。
