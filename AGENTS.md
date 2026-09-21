# Unnamed Space Idle 项目智能体规则

## 项目现状

本仓库目前包含三个相对独立的工作面，处理任务前先确认所属范围：

1. `translation/`：中文补丁项目。该方向目前基本停滞，主要阻塞是无法可靠恢复并对应完整的原文 key；已有 PCK 和翻译产物主要用于保留验证成果，不代表可以继续按行号或字符串位置批量翻译。
2. `fleetSimulation/`：当前可运行的舰队搜索与模拟项目。搜索算法和原版 Fleet Battle 复用逻辑位于此目录，日常入口是 `fleetSimulation/run_optimizer.bat`。
3. `app/`：面向 `fleetSimulation` 的独立可视化管理界面。它负责配置、运行和结果展示，不是另一套战斗模拟或搜索算法实现。

除非用户明确要求恢复翻译/PCK 工作，优先把 `fleetSimulation/` 和 `app/` 视为当前活跃开发范围。

## 文档与事实来源

- 开始修改某一子项目之前，必须先阅读该目录中的 `README.md`。
- `fleetSimulation/README.md` 是 Optimizer 用法、输入输出、算法现状和验证结论的主要说明。
- `app/README.md` 是应用架构、数据边界和开发命令的主要说明。
- `translation/docs/localization-analysis.md` 记录本地化 key 恢复限制和 PCK 验证证据。
- 文档与实际代码不一致时，以当前代码、可复现测试和用户最新说明为准，并同步修正文档；不得根据旧阶段名称推断当前状态。

## 主智能体职责

主智能体负责：

- 项目架构、跨目录契约和维护规则
- `fleetSimulation/` 搜索算法、Godot 资源复用、配置和结果验证
- `app/` 的 Electron / React 界面、桥接、数据模型和测试
- PCK / Godot 资源分析、游戏更新差异和构建脚本（仅在用户明确要求时）
- 翻译 key 可信度、术语、占位符、`NEED_REVIEW` 和最终产物审核
- 最终构建、安装与回滚等高风险步骤

普通文本的批量翻译在具备可靠 key 映射后，应优先交给 `translator` 子智能体；搜索算法、应用代码、PCK 操作和 key 恢复不得交给 `translator`。

## Fleet Optimizer 规则

- 日常运行方式为在 `fleetSimulation/` 下执行 `run_optimizer.bat <galaxy> <node>`；参数、输入文件、复制结果模式和输出含义以 `fleetSimulation/README.md` 为准。
- `run_optimizer.bat` 是标准入口。不要绕过它另造一套日常启动流程，也不要在 `app/` 中重写搜索算法或战斗规则。
- Optimizer 复用恢复出的原版 Godot Fleet Battle 场景与状态机。除非用户明确要求，不要把它改写成近似公式模拟器。
- `fleetSimulation/map/`、`fleetSimulation/work/` 和本机结果可能包含用户数据或派生文件；不要无故覆盖、删除或提交。
- 修改搜索、Resolver、Runner 或结果复制流程后，应运行与改动范围匹配的单元、回归或 smoke 测试。不得把 `BEST FOUND` 或时间预算内结果描述为已证明的全局最优。
- 分析原版资源时只在项目工作副本和隔离的 `user://` 中操作，不读取或修改正式存档，不修改 Steam 游戏目录。

## App 开发与 UI 检查

- `app/` 是 `fleetSimulation` 的独立可视化界面。应用层可以管理配置、调用现有 Optimizer、展示日志和比较结果，但不应复制搜索算法。
- 在 `app/` 中使用仓库既定的 pnpm 工作流：`pnpm dev`、`pnpm test`、`pnpm typecheck`、`pnpm build` 和格式检查。
- 需要 UI 测试、页面审查、响应式检查或浏览器交互时：
  1. 在 `app/` 目录运行 `pnpm dev`。
  2. 从终端输出确认实际的 `localhost` 端口，不要猜测固定端口。
  3. 仅使用 Codex 的 IAB 内置 Browser 打开对应 `http://localhost:<port>` 页面。
  4. 不得使用 Chrome 或 Edge 外部浏览器插件进行本项目的 UI 测试。
- 浏览器运行时主要用于 UI 和工作流验证，数据保存在 `localStorage`；真实本地 Optimizer 执行依赖 Electron 主进程。不要把 IAB 中无法执行桌面桥接误判为界面缺陷。
- `app/data/` 和 `app/runtime/` 是本机数据/运行状态目录。测试不得覆盖用户已有配置；涉及真实 Optimizer 的测试必须保留并恢复触及的工作区文件。

## 翻译项目规则

- 当前关键阻塞是缺少完整、可信的原文 key 对应关系。不得用 locale 行号、哈希桶顺序或不可靠的恢复结果强行配对翻译。
- 不得猜造 key，也不得把仅凭文本相似度得到的对应关系写入正式翻译。证据不足时记录阻塞或标记 `NEED_REVIEW`。
- `translation/glossary/glossary.csv` 中的术语优先级最高。
- 不确定的游戏机制术语不得猜测，必须标记 `NEED_REVIEW`。
- 不得删除、增加或修改占位符、标签和转义字符，包括 `%s`、`%d`、`%.2f`、`{0}`、`{1}`、`{name}`、BBCode / Godot 标签和 `\n`。
- 不得擅自修改数字或公式；中文应符合游戏 UI 表达，同一英文术语必须保持一致。
- 只有来源 key 已被可靠恢复并验证后，才可以进入批量翻译、合并和正式资源构建。

## `translator` 权限边界

`translator` 只能：

- 读取 `translation/glossary/glossary.csv`
- 读取主智能体明确指定的待翻译文件
- 修改主智能体明确指定的翻译中间文件
- 翻译普通 UI 与描述文本
- 对不确定内容标记 `NEED_REVIEW`

`translator` 禁止：

- 修改、复制、提取或构建 `SpaceIdle.pck`
- 猜测、恢复或重新配对本地化 key
- 修改 Steam 游戏目录或存档
- 修改 `scripts/`、`fleetSimulation/`、`app/` 或 `AGENTS.md`
- 修改原始官方翻译备份
- 执行构建、安装或回滚
- 创建其他子智能体

## 安全与文件边界

- 不修改游戏安装目录，不自动安装或替换 `SpaceIdle.pck`，不修改正式存档。
- PCK 提取、分析和测试构建仅在用户明确要求时进行，并且必须使用项目目录中的原版副本和已有可信流程；不得创建伪造 PCK。
- 安装或回滚必须由用户明确授权，并沿用现有校验、备份和恢复脚本。
- 不下载或运行来源不明的工具。
- 不删除或覆盖未知文件；脚本和迁移应尽量可安全重复运行。
- 保留用户的未提交修改与本机配置。修改前检查 Git 状态，提交范围不得包含本机派生数据或忽略目录。
- PowerShell 脚本应兼容 Windows PowerShell 5.1 和 PowerShell 7，并尽量只使用系统自带功能。
