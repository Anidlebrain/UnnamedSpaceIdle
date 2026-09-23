# Unnamed Space Idle 舰队优化器管理器

这是舰队优化器管理应用的 V1.1 工作台实现，基于 Electron、React、Vite、TypeScript、Zod 和 Vitest。

## 已实现范围

- 从 `fleetSimulation/map/` 扫描并一次性导入 Galaxy/Node 配置到 `app/data/`；已有 Manager 数据不会被导入覆盖。
- 以 Galaxy、Node、版本和 Common Profile 选择正式配置，并通过 Zod 校验后原子保存。
- 通过 context-isolated preload bridge 调用 Electron 主进程；Renderer 不直接访问文件系统或启动进程。
- 将选定配置安全暂存到 `fleetSimulation/map/`，启动现有 `run_optimizer.bat`，实时显示 stdout/stderr。
- 检查退出码、结果文件时间和内容变化、结果 JSON 结构以及 Galaxy/Node 身份，避免误读旧结果。
- 搜索启动时生成不可变任务快照；运行状态、日志和 Best Found 始终绑定 Task ID 与真实 Galaxy / Node / Version / Common，不受页面选择变化影响。
- 在搜索页直接展示本次 Best Found 的结果质量、完整阵型与按舰种汇总的 Mod 配置；完成结果跨页面切换保留，并只允许写回任务来源 Version。
- 人工新建、复制、重命名、删除、切换 Node Version，并设置默认 Version；各 Version 使用独立 JSON 文件。
- 人工新建、复制、编辑、重命名、删除、切换 Common，并设置默认 Common。
- 将当前 Node Version 保存为人工模板，并从模板或任意当前 Node Version 创建新 Node；创建时仅重写 Galaxy/Node 身份。
- 复用现有 `run_optimizer.bat <galaxy> <node> --c` 应用 Best Found；只有 BAT 成功且修改后的 Node JSON 通过结构与身份校验后，才原子覆盖当前 Manager Version。
- 串行重跑当前 Galaxy 的全部 Node 默认 Version，并统一使用该 Galaxy 的默认 Common；整批任务持有现有全局 Optimizer 锁。
- 批量结果按 `formation_key`（缺失时回退到结构化 Formation/Loadout diff）过滤，仅重点列出需要重新配置的节点；失败节点独立显示且不会复用旧 Result。
- Galaxy 重跑只做变化发现，不执行 `--c`、不更新 baseline、不创建 Version，也不批量采用 Best Found。
- 五个独立工作区：节点配置、公共配置、搜索、Galaxy 重跑、模板与复制。Galaxy / Optimizer 公共不再作为当前 Node Tab。
- Node 结构化编辑按阵型、舰队状态、装配、环境排列，覆盖 Formation、Fleet Resources、各舰种数量、Loadout、Boss、Hazards 与 Supports；Raw JSON 收入高级区。完整字段审计见 [`docs/node-field-audit.md`](docs/node-field-audit.md)。
- Search 偏好独立保存在忽略的 `fleetSimulation/map/search_config.json`，缺失时回退提交的 `poc/search_config.json`；点击开始即自动保存、回读确认、写入任务快照并覆盖到 staged Node。
- Optimizer 公共配置优先读取忽略的 `fleetSimulation/map/optimizer_v2_daily.json`，缺失时回退提交的 `poc` 默认文件；日常编辑不再污染 Git。
- Loadout 选择由当前 `allowed_mod_slots` 有序数组驱动：`None + 1 Mod` 显示开关，多个 Mod 显示下拉，无合法 Mod 显示不可用；保存仍保持既有字符串 ID 或数字索引表示。
- 搜索页以 Best Found 为核心；低频参数只显示紧凑摘要并在设置 Dialog 中编辑，结果直接给出 Outcome / Committed FR / Used FR、完整 A1–B5 地图式阵型和按舰种汇总的 Loadout。
- 节点、搜索、模板、公共配置分别持有独立选择上下文；仅搜索页恢复上次实际搜索的 Galaxy / Node / Version / Common。
- Node、Search、Galaxy Common 与 Optimizer Public 草稿按数据域独立保留。搜索运行期间只锁定任务 Node+Version、任务 Common 和 Optimizer Public，其余应用操作保持可用。
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
- `fleetSimulation/map/`：Git 忽略的本机运行与配置覆盖层；包含 staged Node/Common、Search 偏好和可选 Optimizer 公共覆盖。
- `fleetSimulation/poc/search_config.json`、`poc/optimizer_v2_daily.json`：Git 跟踪的默认 / fallback，不由日常 Manager 编辑覆盖。

架构细节见 [`docs/architecture.md`](docs/architecture.md)，产品范围见 [`docs/Unnamed Space Idle 舰队优化器管理界面 PRD v1.0.md`](docs/Unnamed%20Space%20Idle%20舰队优化器管理界面%20PRD%20v1.0.md)。
搜索参数的读取、覆盖和最终生效位置见 [`docs/search-config-source-of-truth.md`](docs/search-config-source-of-truth.md)。
