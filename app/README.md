# Unnamed Space Idle 舰队优化器管理器

这是舰队优化器管理应用的 V1.2 工作台实现，基于 Electron、React、Vite、TypeScript、Zod 和 Vitest。

## V1.2.1 可用性调整

- Galaxy / Node / Version / Common 与搜索设置的主要下拉使用统一的限高列表；打开时把当前项尽量放在可视区域中部，Node / Version / Common 可输入筛选。
- 同一 Galaxy / Node / Version 在等待或运行时不能重复加入。再次搜索已结束的目标会替换其当前任务条目；完成、失败和已停止任务保留提醒，点击查看后从左侧导航移除。本次会话的结果仍可在当前搜索页查看，没有增加历史功能。
- Galaxy 重跑在开始前用全宽多列网格选择节点，提供全选/全取消单按钮、勾选和顺序调整；运行后收起选择区，让等待、当前、完成、变化和失败结果占满宽度，停止按钮位于结果区。
- Galaxy 重跑的“已完成”包含“有变化”和“配置未变”；变化只比较阵型与装配。运行中及结束后的已完成节点可点击查看对应结果，失败节点可点击查看错误；变化节点用绿色标示。重跑详情可在批次结束后手动使用 Best Found，目标绑定该节点的任务快照并保留 Version 哈希冲突保护。
- Best Found 按纵向 1–5、横向 B/A 显示 Formation，右侧按舰种显示 Loadout；运行状态缩成单条信息区，日志仍默认折叠。
- 搜索页只显示配置摘要。设置 Dialog 的常用项是搜索方式和共同约束的时间/模拟次数预算；并行进程、模拟时钟、优化目标进入高级设置。当前 v3 记录 `goal` 但不据此改变 Best Found 推荐，界面明确说明这一点。

## V1.2 搜索任务

- 搜索页“加入搜索队列”会先校验并保存独立 Search Config，再冻结 Node、Common、Search 和 Optimizer 公共配置哈希；队列在 Main 串行执行。左侧可切换查看每项状态、日志、结果和错误。队列历史仅保留本次应用会话。
- “停止当前”通过 Windows `taskkill /T /F` 终止 BAT 及其子进程树；“停止全部”同时取消待运行项。停止后会释放执行锁，可继续加入任务。
- Galaxy 重跑可勾选默认版本节点并用箭头调整顺序。启动时自动保存 Search 草稿，整批使用同一快照；可停止当前节点并继续下一项，也可停止整个批次。
- 错误默认显示中文摘要，原始信息和日志可展开。舰种键以 `HeavyCruiser` 等 canonical ID 写回；`Heavy Cruiser` 等别名读取时归一化，冲突值要求人工处理。
- 上次活动页面及各页面 Galaxy / Node / Version / Common 选择保存在 `localStorage`。搜索任务执行状态不跨重启恢复。
- Best Found 采用纵向布局，优先显示结果与一键应用；目标 Version 哈希变化时拒绝写回。

## 已实现范围

- 从 `fleetSimulation/map/` 扫描并一次性导入 Galaxy/Node 配置到 `app/data/`；已有 Manager 数据不会被导入覆盖。
- 以 Galaxy、Node、版本和 Common Profile 选择正式配置，并通过 Zod 校验后原子保存。
- 通过 context-isolated preload bridge 调用 Electron 主进程；Renderer 不直接访问文件系统或启动进程。
- 将选定配置安全暂存到 `fleetSimulation/map/`，启动现有 `run_optimizer.bat`，实时显示 stdout/stderr。
- 检查退出码、结果文件更新时间、结果 JSON 结构以及 Galaxy/Node 身份，避免误读旧结果；确定性搜索生成相同内容仍可被识别为新结果。
- 搜索启动时生成不可变任务快照；运行状态、日志和 Best Found 始终绑定 Task ID 与真实 Galaxy / Node / Version / Common，不受页面选择变化影响。
- 在搜索页直接展示本次 Best Found 的结果质量、完整阵型与按舰种汇总的 Mod 配置；完成结果跨页面切换保留，并只允许写回任务来源 Version。
- 人工新建、复制、重命名、删除、切换 Node Version，并设置默认 Version；各 Version 使用独立 JSON 文件。
- 人工新建、复制、编辑、重命名、删除、切换 Common，并设置默认 Common。
- 将当前 Node Version 保存为人工模板，并从模板或任意当前 Node Version 创建新 Node；创建时仅重写 Galaxy/Node 身份。
- 复用现有 `run_optimizer.bat <galaxy> <node> --c` 应用 Best Found；只有 BAT 成功且修改后的 Node JSON 通过结构与身份校验后，才原子覆盖当前 Manager Version。
- 串行重跑当前 Galaxy 中所选 Node 的默认 Version，按列表顺序执行并使用该 Galaxy 的默认 Common；整批任务持有全局 Optimizer 锁。
- 批量结果按 `formation_key`（缺失时回退到结构化 Formation/Loadout diff）过滤，仅重点列出需要重新配置的节点；失败节点独立显示且不会复用旧 Result。
- Galaxy 重跑过程只做变化发现，不自动执行 `--c`、不更新 baseline、不创建 Version，也不批量采用 Best Found；用户可从节点详情手动使用单个 Best Found。
- 五个独立工作区：节点配置、公共配置、搜索、Galaxy 重跑、模板与复制。Galaxy / Optimizer 公共不再作为当前 Node Tab。
- Node 结构化编辑按阵型、舰队状态、装配、环境排列，覆盖 Formation、Fleet Resources、各舰种数量、Loadout、Boss、Hazards 与 Supports；Raw JSON 收入高级区。完整字段审计见 [`docs/node-field-audit.md`](docs/node-field-audit.md)。
- Galaxy Common 可保存 `ships` 公共舰船数量；启用后 Node `player_state.ships` 表示各舰种额外数量，搜索使用两者相加的有效数量。舰队状态页同时显示公共、节点和搜索数量。未设置 `common.ships` 的旧 Galaxy 仍按节点原有绝对数量运行。
- Search 偏好独立保存在忽略的 `fleetSimulation/map/search_config.json`，缺失时回退提交的 `poc/search_config.json`；点击开始即自动保存、回读确认、写入任务快照并覆盖到 staged Node。
- Optimizer 公共配置优先读取忽略的 `fleetSimulation/map/optimizer_v2_daily.json`，缺失时回退提交的 `poc` 默认文件；日常编辑不再污染 Git。
- Loadout 选择由当前 `allowed_mod_slots` 有序数组驱动：`None + 1 Mod` 显示开关，多个 Mod 显示下拉，无合法 Mod 显示不可用；保存仍保持既有字符串 ID 或数字索引表示。
- 搜索页以 Best Found 为核心；低频参数只显示紧凑摘要并在设置 Dialog 中编辑，结果直接给出 Outcome / Committed FR / Used FR、完整 A1–B5 地图式阵型和按舰种汇总的 Loadout。
- 节点、搜索、模板、公共配置分别持有独立选择上下文；重启后恢复上次活动页面和各页面选择。
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
- G6 本机配置已按公共 `1/2/1/1/0` 迁移，全部 Node Version 的有效舰船数量保持不变；B12 和 BB2 保留原有的额外 1 艘重型巡洋舰。迁移脚本为 `scripts/migrate-g6-ships.mjs`，仅用于尚未迁移的 G6 数据，执行前会在 `app/runtime/` 备份原始文件。
- `app/runtime/`：最近一次任务快照等运行时状态；已加入 Git 忽略。
- `fleetSimulation/map/`：Git 忽略的本机运行与配置覆盖层；包含 staged Node/Common、Search 偏好和可选 Optimizer 公共覆盖。
- `fleetSimulation/poc/search_config.json`、`poc/optimizer_v2_daily.json`：Git 跟踪的默认 / fallback，不由日常 Manager 编辑覆盖。

架构细节见 [`docs/architecture.md`](docs/architecture.md)，产品范围见 [`docs/Unnamed Space Idle 舰队优化器管理界面 PRD v1.0.md`](docs/Unnamed%20Space%20Idle%20舰队优化器管理界面%20PRD%20v1.0.md)。
搜索参数的读取、覆盖和最终生效位置见 [`docs/search-config-source-of-truth.md`](docs/search-config-source-of-truth.md)。
