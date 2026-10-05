# Node JSON 字段审计（Fleet Manager V1.1 第二轮）

本审计同时检查了 Manager 当前 25 份真实 Node Version JSON、`nodeConfigSchema`，以及 `fleetSimulation/poc/friendly_config_resolver.gd` 的实际读取路径。真实数据的顶层字段全集为：`galaxy`、`node`、`boss`、`hazards`、`supports`、`player_state`、`baseline`、`search`。

| 字段 | 当前 UI | 用途 | 建议频率 | 处理结论 |
| --- | --- | --- | --- | --- |
| `baseline.formation` | 有，阵型页 | 搜索基线和最终部署阵型 | 最高频 | 结构化，默认首屏 |
| `player_state.fleet_resources` | 本轮新增 | 本次可用 FR | 高频 | 结构化，舰队状态页 |
| `player_state.ships.*` | 舰队状态页 | 未设置 `common.ships` 时为 Node 绝对数量；设置后 Manager 可保存负的 Node 增量，按 `max(0, 公共数量 + 节点增量)` 算出有效数量；运行前暂存为 Resolver 接受的非负数量 | 高频 | 结构化，始终列出五种标准舰种，并保留数据中其他合法舰种键 |
| `baseline.loadouts.*` | 有，装配页 | 基线各舰种 Primary / Secondary / Tertiary Mod | 中频 | 结构化；选项继续由 Optimizer 公共配置驱动 |
| `baseline.enabled` | 本轮补到搜索页 | 是否启用基线；`beat_baseline` 必须为 true | 中低频 | 结构化，随搜索目标编辑 |
| `search.profile` | 有 | 搜索档位 | 中低频 | 结构化，搜索页 |
| `search.goal` | 有 | 最佳结果或击败基线 | 中低频 | 结构化，搜索页 |
| `search.simulation_clock` | 有 | 实时或固定步长模拟时钟 | 中低频 | 结构化，搜索页 |
| `search.max_wall_seconds` | 有 | 墙钟预算 | 中低频 | 结构化，搜索页 |
| `search.max_simulations` | 有 | 模拟次数预算 | 中低频 | 结构化，搜索页 |
| `search.workers` | 有 | Worker 数（Resolver 限制 1–4） | 中低频 | 结构化，搜索页 |
| `hazards[]` | 有，移至环境页 | 原版 Hazard Node 引用 | 低频 | 结构化文本列表 |
| `supports[]` | 有，移至环境页 | 原版 Support Node 引用 | 低频 | 结构化文本列表 |
| `boss.alive` | 有，移至环境页 | 是否按 Boss 目标搜索 | 条件低频 | 结构化 |
| `boss.remaining_hp` | 有，移至环境页 | Boss 剩余生命 | 条件低频 | 结构化 |
| `boss.priority` | 有，移至环境页 | `efficiency` / `kill_cost` / `affordable_kill_cost` 排序 | 条件低频 | 结构化 |
| `galaxy` / `node` | 上下文栏展示 | 配置身份；保存和 Result 归属校验 | 系统字段 | 不提供自由编辑，创建/复制时由系统重写 |
| `baseline.observed` | 仅一份真实 B35 配置存在 | 已观察基线证据/诊断元数据；Resolver 不用于候选配置 | 诊断 | 只保留 Raw JSON |
| `player_state.fleet_resources_retention` | 真实 Manager Node 中未出现；Resolver 有兼容默认值 0.5 | 战斗后 FR 保留比例兼容输入 | 极少使用 | 只保留 Raw JSON，不为缺省兼容字段增加常规 UI |
| `diagnostic.known_candidate` / `diagnostic.micro_test` | 真实 Manager Node 中未出现 | Optimizer 回归与微测试入口 | 仅内部诊断 | 只保留 Raw JSON |
| 未知透传字段 | Raw JSON | 向前兼容或实验字段 | 极少使用 | Schema `passthrough` 保留，不做无证据的结构化 UI |

## 舰种结论

当前 Optimizer 公共搜索空间支持 `Fighter`、`Corvette`、`Frigate`、`Cruiser`、`HeavyCruiser`。真实 Node 数据中同时存在旧显示键 `Heavy Cruiser`；UI 使用现有 selector 归一化逻辑识别它，但保存时保留原键，避免无操作格式漂移。舰队状态页会始终提供五个标准舰种数量入口，并额外展示 Node 中已经存在的其他合法舰种键。

## 页面顺序

节点配置页按实际频率固定为：阵型 → 舰队状态 → 装配 → 环境 → 高级 Raw JSON。Boss、Hazard、Support 不再占据默认首屏。
