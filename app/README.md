# Unnamed Space Idle 舰队优化器管理器

这是舰队优化器管理应用的 V1.2 工作台实现，基于 Electron、React、Vite、TypeScript、Zod 和 Vitest。

## 关闭窗口与未保存修改

节点、公共配置、搜索设置或泰坦档案有未保存修改时，关闭窗口或重新加载会显示桌面确认框。默认“取消”返回应用保留草稿；明确选择“放弃修改并继续”后才允许离开。没有未保存修改时直接关闭。浏览器继续使用浏览器自己的离开提示。

## 泰坦搜索工作区

左侧“泰坦搜索”接入独立的 `../titanSimulation/run_titan.bat`，不复写搜索算法。原生搜索器、恢复工程、Python 3.10+ 与 Godot 仍需在本机可用；搜索范围与约束以 [泰坦搜索器说明](../titanSimulation/README.md) 为准。

1. 打开“玩家档案”，填写统计总览、读数时层域、校准、阵列核心 Base Damage、可同时达到的核心等级与本轮进度。支持科学计数法，未解锁普通武器留空，等级 0 会保留。核对临时技能已结束与三槽等级条件后保存。游戏更新后重新采集统计，不能只更换版本标签。
2. 在“搜索与结果”选择区域、层域、首领击杀或挂机距离。区域支持 `164`、`160A` 及原版内部 ID；实际区域解析和原生校验沿用搜索器。运行环境中设置 Godot，恢复工程留空则沿用 `titanSimulation/local/current_source.json`。首次尝试从现有 Fleet BAT 只读检测有效 Godot 路径。
3. 保存搜索设置或直接开始，开始前自动保存设置。总预算包含工程准备、初始化、候选与复核；默认 180 秒。运行中显示任务目标、耗时和实时日志，可停止整棵进程树。切换工作区保留草稿和当前任务；更改目标不会改写静态玩家档案或已完成任务。
4. 完成后展示三槽武器、里程碑、四项目标、护盾、阵列顺序和有序部件目标。挂机显示三次独立长战斗复核证据，可复制搜索器原始推荐文本。没有游戏内自动应用功能。

只有模式对应的 `KILL_FOUND` / `BEST_VALIDATED_DISTANCE_FOUND` 且证据通过检查才显示推荐。预算内未找到、停止和运行失败分别显示；未找到不代表无解，预算内结果不保证全局最优，有限挂机复核不证明无限期稳定。读取区域资料仅展示原版结构，不表示玩家准入或战斗验证。

数据与隔离边界：

- Manager 档案与偏好分别存入 `app/data/titan/player.json`、`settings.json`（打包后沿用应用 userData 数据根）。首次无 Manager 档案时只读加载 `titanSimulation/local/player.json`；本机没有档案时显示空白，不填合成示例。
- 每次任务独立保存 `titan/tasks/<任务 ID>/player.json` 与 `request.json`，通过 `--player` 指向冻结快照。结果仍由原搜索器写入 `titanSimulation/results/<任务 ID>/`，原生隔离工作目录仍在 `titanSimulation/work/`。App 校验任务路径、玩家哈希、区域、层域、模式与成功证据，避免旧结果串用。
- 不覆盖 `local/player.json`、Fleet 暂存输入、恢复工程、Steam 或正式存档。泰坦与 Fleet 使用独立服务与工作目录。
- 浏览器使用独立 `localStorage` 键 `fleet-manager-web-titan-v1` 保存档案和设置；明确禁用原生搜索和本机区域读取，不制造模拟成功结果。

验证入口：`pnpm test` 包含独立临时目录服务测试、桥接与界面测试。真实 BAT 区域读取及原生搜索为显式 opt-in，详见 `tests/titan-service.test.ts`、`tests/real-titan-smoke.test.ts`；合成 smoke 只验证接入链路，不表示玩家实战成绩。

## G11 CRF / TM 解锁状态

2026-11-07：舰队运行资源更新为 0.90.0.1，新增 G12 / G13 的专属模组开关与节点装配校验。G12 支持 FHB `FrigateHealthBoost`（自动三级）与 TM `FrigateRapidMissileMod`（Primary）；G13 支持 FB `FighterBarrier`（自动三级）与 TM `FighterJumpGatling`（Primary）。在对应 Galaxy 公共中录入已获得状态并保存。TM 在普通优化中自动加入候选；推荐舰队搜站位仍固定节点装配，旅行重置后手动关闭。所有 TM 以字符串 ID 保存，公共数字索引保持不变。跨星系复制带专属模组的 Common 会拒绝。恢复工程的更新与验证方法见 [`../fleetSimulation/README.md`](../fleetSimulation/README.md)。

在“公共配置 → Galaxy 公共”选择 G11 与所用 Common，按游戏中已获得的状态独立勾选 CRF 和 TM，再保存 Galaxy 公共。不会自动修改已有配置。`common.json.galaxy_mods` 支持 `"CorvetteRapidFire"`（CRF）和 `"CorvetteChargeLaserBurst"`（TM）组成的无重复数组；缺省或 `[]` 表示均未解锁。两个开关互相保留，且仅 G11 生效。

- CRF：护卫舰快速开火，三级 Mod。由既有 Optimizer 自动应用于 Baseline、所有候选和最终重放，不占用 Primary / Secondary。
- TM：护卫舰连发充能激光，本次旅行的 Primary 可选模组。旅行重置后必须手动关闭并保存。开启只解锁选项；普通优化会自动加入候选，推荐舰队策略 `advisor_seeded` 沿用节点选中的装备，只搜索站位。与普通充能激光互斥，可搭配 Shield 和 CRF。

节点装配显示所选 Common 当前草稿的状态与设置入口。TM 选项随 G11 与 Common 状态增加或过滤，但旧数字装备始终按原始 Optimizer `allowed_mod_slots` 的有序数组解码。选择 TM 永远保存字符串 `CorvetteChargeLaserBurst`，普通主副模组沿用既有表示。仍装备锁定 TM 的节点会保留原值并显示警告；运行暂存及浏览器模拟执行时拒绝这类 Baseline，不会悄悄清空。

Best Found 按结果 `base_config.galaxy_mods` 显示本次 CRF 生效与 TM 可选状态；TM 实际是否装备以候选 Primary 为准，旧结果显示未记录。草稿、保存、任务冻结和暂存沿用现有 Common 流程，不修改跨 Galaxy 共用的 daily JSON。

携带 CRF / TM 的 Common 不能保存或暂存到其他 Galaxy，跨 Galaxy 复制会明确报错；先在来源 Common 关闭两个开关并保存，Node 已装备 TM 时也应改选其他 Primary。未知 Mod ID、重复 ID 和错误字段类型在保存时拒绝。

## V1.2.1 可用性调整

- 节点环境页可勾选“使用当前节点 Hazards”，自动加入当前节点名；取消时只移除当前节点，其他 Hazards 保留，手动输入也会同步勾选状态。
- Galaxy 公共的永久加成提供“伤害与生命 +0.25”按钮，每次同时增加两个倍率，保存公共配置后生效。
- 模板复制创建 Node / Galaxy 后，节点配置页自动选择新增节点；保存节点后，搜索页自动选择保存的 Galaxy / Node / Version / Common，并使用刚保存的节点内容。其他节点的未保存草稿继续保留。
- 搜索设置支持 `portfolio` 与 `advisor_seeded`。后者使用节点 Baseline 中的游戏推荐舰种、数量和 Mods，仅搜索站位，允许初始战败；与 `exhaustive` 不组合。搜索队列和 Galaxy 重跑仍通过原 BAT 执行，未找到胜利时不提供可应用结果。
- 普通战目标 `target_used_fr` 由节点配置的“环境”页编辑，随当前 Node Version 保存；切换节点各自保留，Galaxy 重跑逐节点使用。时间/模拟次数仍由共享 Search 配置提供。达到实际胜利的 Used FR 目标后仍执行最终原版重放；留空则使用完整预算，Boss 不使用此字段。
- Node 舰队状态可输入负数来抵消 Galaxy 公共舰船数量；实际搜索数量按 `max(0, 公共 + 节点)` 计算。app 暂存运行输入时写入有效非负数量，Best Found 回写时保留 Node 中的增量。
- 搜索页运行状态的指标标签与值按同一列左对齐，并在较窄窗口自动换行。
- Galaxy 重跑完成后可一键将所有“有变化”节点的 Best Found 逐个写入对应默认 Version；继续使用单节点 Copy 校验，目标有未保存草稿、版本变化或结果失效时跳过该节点并报告失败，成功节点不会重试。
- “模板与复制”可创建 Galaxy：输入 Galaxy ID 和初始 Node ID，复制当前 Common 与当前 Node / Version 作为新 Galaxy 的初始配置；已有 Galaxy 不会被覆盖。
- Galaxy / Node / Version / Common 与搜索设置的主要下拉使用统一的限高列表；打开时把当前项尽量放在可视区域中部，Node / Version / Common 可输入筛选。
- 同一 Galaxy / Node / Version 在等待或运行时不能重复加入。再次搜索已结束的目标会替换其当前任务条目；完成、失败和已停止任务保留提醒，点击查看后从左侧导航移除。本次会话的结果仍可在当前搜索页查看，没有增加历史功能。
- Galaxy 重跑在开始前用全宽多列网格选择节点，提供全选/全取消单按钮、勾选和顺序调整；运行后收起选择区，让等待、当前、完成、变化和失败结果占满宽度，停止按钮位于结果区。
- Galaxy 重跑的节点勾选与执行顺序按 Galaxy 保存在本机 `localStorage`，切换页面或重启应用后恢复；新增节点默认勾选。
- Galaxy 重跑的“已完成”包含“有变化”和“无有效变化”；两次 Used FR 各自向下取整后比较，整数相同视为无有效变化，结果缺少 Used FR 时回退比较阵型与装配。节点卡片和 Best Found 显示取整前后及差值，原始 Used FR / Saved FR 仍照实显示。运行中及结束后的已完成节点可点击查看对应结果，失败节点可点击查看错误；变化节点用绿色标示。重跑详情可在批次结束后手动使用 Best Found，目标绑定该节点的任务快照并保留 Version 哈希冲突保护。
- 节点环境页的 Hazards / Supports 可按行或逗号输入，编辑时保留尚未完成的分隔符，并同步解析到 Node 草稿。
- 节点阵型包含尚无 Loadout 的舰种时，读取配置会补出无 Primary/Secondary Mod 的装配；数字格式使用 `0`，英文格式使用 `null`。运行时的暂存配置因此可直接搜索，原 Manager Version 在用户保存或应用 Best Found 时写入补齐结果；应用 Best Found 时保留结果未使用舰种的原装配。
- Best Found 按纵向 1–5、横向从最末列到 A 显示 Formation，右侧按舰种显示 Loadout；运行状态缩成单条信息区，日志仍默认折叠。
- Boss 优先级支持效率、每战 FR 限额下最低击杀总成本，以及当前资源内优先最低成本击杀、否则最大累计伤害。Best Found 显示当前 FR、可负担击杀状态、累计伤害/消耗、剩余 HP/FR，并可展开每场阵型与装配。单场指标明确标为“首场”；“使用最优配置”应用第 1 场，后续按方案换阵。附加完整击杀候选在预算内完成验证时显示，旧结果缺少新字段时仍按原样展示。
- 搜索页直接编辑搜索策略、搜索方式、最长时间、最多模拟次数和并行进程，加入队列时自动保存；模拟时钟和优化目标在页面内的高级设置中。Galaxy 重跑使用同一份共享 Search 配置，可先在搜索页调整。当前 v3 记录 `goal` 但不据此改变 Best Found 推荐，界面明确说明这一点。

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
- 批量结果优先比较 Baseline 与 Best Found 的实际 Used FR 各自向下取整后的整数值；整数值不同视为有变化。Used FR 无法比较时，才按 `formation_key`（缺失时回退到结构化 Formation/Loadout diff）判定；失败节点独立显示且不会复用旧 Result。
- Galaxy 重跑过程只做变化发现，不自动执行 `--c`、不更新 baseline、不创建 Version；完成后可手动批量使用有变化节点的 Best Found，也可从节点详情单独使用。
- 五个独立工作区：节点配置、公共配置、搜索、Galaxy 重跑、模板与复制。Galaxy / Optimizer 公共不再作为当前 Node Tab。
- Node 结构化编辑按阵型、舰队状态、装配、环境排列，覆盖 Formation、Fleet Resources、各舰种数量、Loadout、Boss、Hazards 与 Supports；Raw JSON 收入高级区。完整字段审计见 [`docs/node-field-audit.md`](docs/node-field-audit.md)。
- Node 顶级 `formation_columns` 控制阵型宽度（1–26 列，每列 5 格，A/B/C 分别对应 grid x=0/1/2）；旧 Node 缺省为 2 列。编辑器只显示有效列，缩小列数前必须清空将被隐藏的舰船。Best Found 优先按结果 `base_config.grid_size[0]` 显示列数，旧结果回退任务快照或 2 列；应用到浏览器工作区时会拒绝列数不匹配、重复位置和目标范围外的位置。实际部署组数上限为阵型格子数与 Optimizer 公共组数上限的较小值，旧本机公共配置仍可能限制为 10 组。
- Galaxy Common 可保存 `ships` 公共舰船数量；启用后 Node `player_state.ships` 表示各舰种可为负的增量，搜索使用 `max(0, 公共数量 + 节点增量)`。舰队状态页同时显示公共、节点和搜索数量。未设置 `common.ships` 的旧 Galaxy 仍按节点原有绝对数量运行。
- Search 偏好独立保存在忽略的 `fleetSimulation/map/search_config.json`，缺失时回退提交的 `poc/search_config.json`；点击开始即自动保存、回读确认、写入任务快照并覆盖到 staged Node。
- Optimizer 公共配置优先读取忽略的 `fleetSimulation/map/optimizer_v2_daily.json`，缺失时回退提交的 `poc` 默认文件；日常编辑不再污染 Git。
- Loadout 选择由当前 `allowed_mod_slots` 有序数组驱动：`None + 1 Mod` 显示开关，多个 Mod 显示下拉，无合法 Mod 显示不可用；保存仍保持既有字符串 ID 或数字索引表示。
- 搜索页直接提供常用搜索参数，并以内嵌高级区编辑低频参数；结果给出 Outcome / Committed FR / Used FR、按节点宽度展示的完整地图式阵型和按舰种汇总的 Loadout。
- 节点、搜索、模板、公共配置分别持有选择上下文；复制创建时同步节点页，保存节点时同步搜索页，重启后恢复上次活动页面和各页面选择。
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
