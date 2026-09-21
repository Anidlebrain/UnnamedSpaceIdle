\# Unnamed Space Idle 舰队优化器管理界面 PRD v1.0



\## 1. 项目背景



当前已经完成 Unnamed Space Idle 舰队战斗模拟及优化搜索程序，并可以通过命令行运行：



```bat

run\_optimizer.bat g6 B21

```



节点配置存放于：



```text

map/{galaxy}/{node}.json

```



Galaxy 公共加成配置存放于：



```text

map/{galaxy}/common.json

```



搜索完成后产生：



```text

{node}.result.json

{node}.result.txt

{node}.godot.log

```



当前也已经支持：



```bat

run\_optimizer.bat g6 B21 --c

```



或：



```bat

run\_optimizer.bat g6 B21 --copy

```



将最近一次搜索得到的最佳结果回写到节点 JSON 的 baseline 配置中。



现阶段主要问题不是算法本身，而是节点配置、不同状态版本、搜索执行、结果查看及批量重跑仍依赖手工维护 JSON 和命令行操作。



因此开发一个本地管理页面，对现有优化器进行管理。



\---



\# 2. 产品目标



第一版产品主要解决五个问题：



1\. 管理 Galaxy / Node 配置。

2\. 一个节点可以人工维护多个配置版本，并指定默认版本。

3\. 将指定配置复制到优化器运行目录并执行搜索。

4\. 查看当前配置与本次搜索得到的最佳配置。

5\. Galaxy 全局属性变化后，批量重新搜索当前 Galaxy，找出需要修改舰队配置的节点。



本项目不是新的搜索器。



前端管理系统不得重新实现 Fleet Optimizer 的搜索逻辑，应尽量复用现有：



```text

run\_optimizer.bat

节点 JSON

common.json

result.json

result.txt

\--c / --copy

```



现有优化器继续保持可以脱离前端独立运行。



\---



\# 3. 核心原则



\## 3.1 管理数据与运行数据分离



应用程序独立维护正式配置。



现有：



```text

fleet\_simulation/map/

```



仅作为优化器运行目录。



应用自身维护：



```text

manager/data/

```



运行搜索时，将应用中的配置复制到：



```text

fleet\_simulation/map/

```



然后调用现有 BAT。



因此：



> manager/data 是正式数据源，map 是运行工作区。



即使运行目录结果被覆盖，也不会导致应用正式配置丢失。



\---



\## 3.2 “版本”不是搜索历史版本



版本用于表示：



> 同一个节点在不同游戏状态、可用条件、Hazard、Support 等条件下的配置。



例如：



```text

G6 / B21



默认

无 Hazard

Support F2

低舰船数量

其他特殊状态

```



可能导致创建不同版本的字段包括但不限于：



\* 可用舰船

\* Fleet Resources

\* Boss 状态

\* Hazards

\* Supports

\* 其他节点环境

\* 对应 Common 状态



以下变化不需要创建版本：



\* 舰船位置变化

\* Primary 变化

\* Secondary 变化

\* Tertiary 变化

\* Optimizer 找到了更好的阵容

\* Used FR 更低



这些属于：



> 同一个版本下得到的更优 baseline。



版本只允许用户手工创建、删除、重命名、复制和切换。



系统不得因为执行搜索自动创建版本。



\---



\# 4. 数据层级



推荐的数据关系：



```text

Galaxy

├── Common 配置

│   ├── 默认 \*

│   ├── 临时加成 A

│   └── 临时加成 B

│

├── B12

│   ├── 默认 \*

│   └── 特殊版

│

├── B13

│   └── 默认 \*

│

└── B21

&#x20;   ├── 默认 \*

&#x20;   └── Support F2

```



`\*` 表示默认配置。



\---



\# 5. Common 配置管理



\## 5.1 数据内容



保持现有 `common.json` 格式：



```json

{

&#x20; "permanent": {

&#x20;   "damage\_scale": 2.0,

&#x20;   "health\_scale": 2.0

&#x20; },

&#x20; "temporary": {

&#x20;   "damage\_scale": 0.0,

&#x20;   "health\_scale": 0.0

&#x20; }

}

```



第一版直接维护现有四个值：



```text

Permanent Damage Scale

Permanent Health Scale



Temporary Damage Scale

Temporary Health Scale

```



\---



\## 5.2 Common 多配置



每个 Galaxy 可以人工创建多个 Common 配置。



例如：



```text

Galaxy 6



● 默认

&#x20; Permanent Damage  2.0

&#x20; Permanent Health  2.0

&#x20; Temporary Damage  0

&#x20; Temporary Health  0



○ 临时 Buff

&#x20; Permanent Damage  2.0

&#x20; Permanent Health  2.0

&#x20; Temporary Damage  0.5

&#x20; Temporary Health  0.2

```



允许：



```text

新建

复制

编辑

重命名

删除

设为默认

```



系统不得自动产生 Common 版本。



\---



\# 6. Node 配置管理



\## 6.1 当前 JSON



现有节点结构继续作为主要业务模型，例如：



```json

{

&#x20; "galaxy": 6,

&#x20; "node": "B21",



&#x20; "boss": {},

&#x20; "hazards": \[],

&#x20; "supports": \[],



&#x20; "player\_state": {

&#x20;   "fleet\_resources": 280,

&#x20;   "ships": {}

&#x20; },



&#x20; "baseline": {

&#x20;   "enabled": true,

&#x20;   "formation": {},

&#x20;   "loadouts": {}

&#x20; },



&#x20; "search": {}

}

```



前端不能强制重构现有 JSON 格式。



\---



\# 7. 节点创建



支持两种创建方式。



\## 7.1 从模板创建



用户可以将一个合法的节点 JSON 保存为模板。



例如：



```text

模板名称：

G6 普通 Boss



模板文件：

某个已有 Bxx.json

```



创建节点时：



```text

Galaxy：G6

Node：B23

模板：G6 普通 Boss

```



系统创建配置后，应至少自动修改：



```json

"galaxy": 6,

"node": "B23"

```



其他内容保留模板值，再由用户编辑。



\---



\## 7.2 复制已有节点



支持：



```text

复制来源：

G6 / B22 / 默认



创建目标：

G6 / B23 / 默认

```



系统复制完整节点配置，并修改：



```text

galaxy

node

```



之后由用户自行修改环境参数。



\---



\# 8. 节点版本



每个 Node 可以存在多个人工版本。



例如：



```text

B21



\[默认 ▼]



默认

无 Hazard

Support F2

```



允许：



```text

新建版本

复制版本

编辑版本

重命名

删除版本

设为默认

```



搜索不会创建版本。



执行“使用搜索结果”也不会创建版本。



\---



\# 9. 节点配置编辑



第一版不制作复杂图形化舰队编辑器。



使用普通表单和表格。



\---



\## 9.1 基础状态



例如：



```text

Boss Alive       \[✓]



Remaining HP     \[10000]



Priority         \[kill\_cost ▼]



Fleet Resources  \[280]

```



\---



\## 9.2 Hazard / Support



例如：



```text

Hazards



\[x] B21

\[ ] B24

```



Support 同理。



第一版可以先采用文本、多选或简单数组编辑方式，不要求地图化。



\---



\## 9.3 可用舰船



例如：



| Ship          | Available |

| ------------- | --------: |

| Fighter       |         1 |

| Corvette      |         2 |

| Frigate       |         1 |

| Cruiser       |         1 |

| Heavy Cruiser |         1 |



\---



\# 10. Baseline 配置



\## 10.1 Formation



无需复杂拖拽界面。



采用二维表格即可：



|   | 1        | 2            | 3            | 4       | 5       |

| - | -------- | ------------ | ------------ | ------- | ------- |

| A | Corvette | HeavyCruiser | HeavyCruiser | Frigate | Cruiser |

| B | Fighter  | Corvette     | Cruiser      | Empty   | Fighter |



单元格使用下拉选择：



```text

Empty

Fighter

Corvette

Frigate

Cruiser

Heavy Cruiser

...

```



\---



\## 10.2 Loadout



按舰种维护：



| Ship          | Primary | Secondary |

| ------------- | ------: | --------: |

| Fighter       |       0 |         0 |

| Corvette      |       0 |         1 |

| Frigate       |       0 |         1 |

| Cruiser       |       0 |         1 |

| Heavy Cruiser |       1 |         0 |



第一版应兼容现有 JSON。



未来如果优化器增加 Tertiary 等字段，数据结构应允许扩展。



\---



\# 11. 搜索参数



第一版优先级较低。



已有 JSON 中例如：



```json

"search": {

&#x20; "profile": "fast",

&#x20; "goal": "beat\_baseline",

&#x20; "simulation\_clock": "offline\_fixed\_step",

&#x20; "max\_wall\_seconds": 500,

&#x20; "max\_simulations": 500,

&#x20; "workers": 4

}

```



第一版可以：



1\. 展示；

2\. 允许基础编辑；

3\. 不重点设计复杂 UI。



不需要第一版实现高级参数预设、搜索策略管理等功能。



\---



\# 12. 单节点搜索



\## 12.1 操作流程



用户选择：



```text

Galaxy 6

B21

版本：默认

Common：默认

```



点击：



```text

开始搜索

```



系统执行：



```text

Manager 节点版本

&#x20;       ↓

复制

&#x20;       ↓

map/g6/B21.json





Manager Common

&#x20;       ↓

复制

&#x20;       ↓

map/g6/common.json





&#x20;       ↓



run\_optimizer.bat g6 B21

```



\---



\# 13. 搜索运行状态



第一版至少显示：



```text

Galaxy 6 / B21



状态：搜索中



开始时间

已运行时间



控制台输出 / 当前阶段

```



如果现有 Optimizer 已能提供：



```text

完成数量

总数量

预计剩余时间

```



则直接显示。



否则第一版不要求为了 UI 修改搜索算法。



\---



\# 14. 搜索结果



产品只关心：



> 本次搜索的最佳结果。



不需要展示：



```text

Top 10

Top 100

ranked\_candidates

其他次优配置

```



即使 Result JSON 内存在这些信息，UI 第一版也不展示。



\---



\# 15. 最佳结果展示



现有 Result JSON 已包含：



```text

best\_result

verified\_baseline

improvement\_vs\_baseline

```



因此页面主要显示：



\## 当前配置



VS



\## 本次搜索最佳结果



例如：



| 项目            |      当前 |    本次最佳 |

| ------------- | ------: | ------: |

| Outcome       | Victory | Victory |

| Committed FR  |     180 |     180 |

| Used FR       |  163.70 |  160.67 |

| Total Kill FR |  163.70 |  160.67 |

| Boss Damage   |   10000 |   10000 |



另外显示：



```text

节省 FR：3.03

改善：1.85%

```



\---



\# 16. 阵容差异



重点展示：



```text

Formation

Loadout

```



的变化。



例如：



```text

Corvette



Secondary

Shield → None

```



如果位置发生变化：



```text

A4

Corvette → Frigate

```



方便用户直接在游戏中配置搜索结果。



\---



\# 17. “最佳”含义



UI 应避免将搜索结果描述为：



> 已数学证明的全局最优。



当前 Optimizer 输出可能存在：



```text

TIME BUDGET REACHED

Not mathematically global exact

```



因此统一使用：



> 本次搜索最佳结果



或：



> Best Found



表示在当前搜索预算下找到的最佳结果。



\---



\# 18. 使用搜索结果



不设计审批、采用、生成新版本等流程。



提供一个直接操作，例如：



```text

\[使用最优配置]

```



其业务含义与当前：



```bat

run\_optimizer.bat g6 B21 --c

```



保持一致。



流程：



```text

执行 --c

&#x20;  ↓

修改 map/g6/B21.json

&#x20;  ↓

读取修改后的 JSON

&#x20;  ↓

覆盖 Manager 中当前节点版本

```



不创建新版本。



不保存旧 baseline 版本。



因为：



> 当前节点版本下，旧的较差舰队配置没有长期保留价值。



\---



\# 19. 使用最优配置后的状态



例如当前：



```text

B21 / 默认



Used FR

163.70

```



搜索：



```text

160.67

```



点击：



```text

使用最优配置

```



以后：



```text

B21 / 默认

```



baseline 就变成新的配置。



用户可以再次：



```text

开始搜索

```



形成自然迭代：



```text

当前 baseline

&#x20;     ↓

搜索

&#x20;     ↓

Best Found

&#x20;     ↓

使用最优配置

&#x20;     ↓

新的 baseline

&#x20;     ↓

再次搜索

```



整个过程始终属于同一个人工版本。



\---



\# 20. Galaxy 全局重跑



这是第一版核心功能。



入口：



```text

Galaxy 6

```



点击：



```text

\[重跑当前 Galaxy]

```



只处理当前 Galaxy。



不跨 Galaxy。



\---



\# 21. 全局重跑使用的配置



默认规则：



每个节点使用：



> 该节点的默认版本。



例如：



```text

G6



B3   默认

B4   默认

B5   默认

B7   默认

...

B22  默认

```



Common 使用：



> 当前 Galaxy 默认 Common。



\---



\# 22. 全局重跑过程



系统顺序执行：



```text

B3

↓

B4

↓

B5

↓

...

```



每个节点流程：



```text

复制节点默认版本

\+

复制 Galaxy 默认 Common

&#x20;       ↓

运行 optimizer

&#x20;       ↓

读取 best\_result

&#x20;       ↓

与 verified\_baseline 比较

```



第一版默认串行执行。



暂不要求多节点并发搜索。



\---



\# 23. 全局重跑页面



运行过程中显示：



```text

Galaxy 6



2 / 15



✓ B3

✓ B4

→ B5 搜索中

○ B7

○ B8

...

```



如果能够获得时间信息，则显示：



```text

当前节点耗时

总耗时

预计剩余时间

```



\---



\# 24. “发现新方案”的判定



Galaxy 全局重跑的目的不是查看数值变化，而是：



> 判断玩家是否需要修改游戏中的舰队配置。



因此不能仅根据 FR 判断。



应比较：



```text

formation

\+

loadout

```



推荐优先使用 Optimizer 已生成的标准化结果，例如：



```text

formation\_key

```



或者自行标准化比较：



```text

Position

Ship

Primary Mod

Secondary Mod

Tertiary Mods

```



\---



\## 24.1 应列出



旧配置：



```text

Corvette

Secondary = Shield

```



新配置：



```text

Corvette

Secondary = None

```



即使只提升：



```text

0.1 FR

```



也属于新的舰队配置。



应该列出。



\---



\## 24.2 不应列出



由于 Damage Scale 提升：



```text

旧 Used FR：40

新 Used FR：36

```



但是：



```text

舰船位置完全一样

武器完全一样

装备完全一样

```



则：



> 不输出该节点。



因为玩家不需要做任何配置修改。



\---



\# 25. 全局重跑结果



最终只显示：



> 与当前默认配置不同的最佳方案。



例如：



```text

Galaxy 6 重跑完成



发现 3 个配置发生变化：



B8

当前 Used FR：33.71

新的 Used FR：31.26

\[查看]



B13

当前 Used FR：58.21

新的 Used FR：54.72

\[查看]



B17

当前 Used FR：76.11

新的 Used FR：71.40

\[查看]



其余节点无需修改。

```



不需要把所有“没有变化”的节点逐项占据页面。



\---



\# 26. 全局重跑不得自动修改配置



全局重跑只负责：



```text

发现变化

```



不得：



```text

自动执行 --c

自动更新节点 baseline

自动创建版本

自动批量覆盖配置

```



用户进入：



```text

B13

```



查看搜索结果。



确认自己已经准备使用该方案以后，可以直接执行：



```text

使用最优配置

```



即当前 `--c` 行为。



\---



\# 27. 页面规划



第一版推荐四个主要区域。



\## 页面一：Galaxy / Node



主工作页面。



```text

Galaxy：G6

Node：B21

版本：默认

Common：默认

```



功能：



```text

编辑

保存

开始搜索

查看最佳结果

使用最优配置

```



\---



\## 页面二：Galaxy 总览



例如：



| Node | 默认版本 | 上次结果    | 状态  |

| ---- | ---- | ------- | --- |

| B3   | 默认   | Victory | 已搜索 |

| B4   | 默认   | Victory | 已搜索 |

| B5   | 默认   | Victory | 已搜索 |

| B7   | 默认   | Victory | 已搜索 |

| B8   | 默认   | Victory | 已搜索 |



提供：



```text

重跑当前 Galaxy

```



\---



\## 页面三：Common



管理当前 Galaxy：



```text

Permanent Damage

Permanent Health

Temporary Damage

Temporary Health

```



支持多个人工配置及默认配置。



\---



\## 页面四：模板



维护 Node JSON 模板。



支持：



```text

导入 JSON

创建模板

编辑名称

删除模板

从模板创建 Node

```



\---



\# 28. 数据目录建议



示例：



```text

fleet\_manager/

├── data/

│   ├── galaxies/

│   │   └── g6/

│   │       ├── galaxy.json

│   │       │

│   │       ├── common/

│   │       │   ├── default.json

│   │       │   └── temp\_buff.json

│   │       │

│   │       └── nodes/

│   │           ├── B12/

│   │           │   ├── meta.json

│   │           │   ├── default.json

│   │           │   └── special.json

│   │           │

│   │           └── B21/

│   │               ├── meta.json

│   │               └── default.json

│   │

│   └── templates/

│       ├── g6\_normal\_boss.json

│       └── g6\_other.json

```



不要求严格使用以上文件名。



关键要求是：



> Manager 正式数据与 Optimizer map 目录隔离。



\---



\# 29. Meta 信息



建议 Node 保存少量管理元数据。



例如：



```json

{

&#x20; "default\_version": "default",

&#x20; "versions": \[

&#x20;   {

&#x20;     "id": "default",

&#x20;     "name": "默认"

&#x20;   },

&#x20;   {

&#x20;     "id": "support\_f2",

&#x20;     "name": "Support F2"

&#x20;   }

&#x20; ]

}

```



Common 同理：



```json

{

&#x20; "default\_profile": "default"

}

```



\---



\# 30. 搜索结果存储原则



管理器不需要永久保存：



```text

所有 ranked\_candidates

全部战斗日志

全部历史搜索结果

失败候选

次优配置

```



Optimizer 原有：



```text

result.json

result.txt

godot.log

```



继续保留在运行目录即可。



管理器可以记录少量状态，例如：



```text

上次搜索时间

上次搜索结果

Used FR

Outcome

是否发现配置变化

```



仅用于页面快速显示。



完整结果仍以 Optimizer 文件为准。



\---



\# 31. 错误处理



\## JSON 无效



禁止开始搜索，并显示具体文件和错误原因。



\---



\## Galaxy / Node 不一致



例如文件：



```text

map/g6/B21.json

```



内部：



```json

{

&#x20; "galaxy": 5,

&#x20; "node": "B20"

}

```



应阻止执行。



这与 BAT 当前验证规则保持一致。



\---



\## Common 缺失



阻止搜索：



```text

当前 Galaxy 没有可用 Common 配置。

```



\---



\## Optimizer 执行失败



保留：



```text

Exit Code

Godot Log

Console Output

```



页面提供：



```text

查看日志

```



不得因为搜索失败覆盖 Manager 配置。



\---



\## --c 执行失败



不得同步回 Manager。



只有：



```text

\--c 执行成功

\+

修改后的 JSON 可正常读取

```



才允许覆盖 Manager 当前版本。



\---



\# 32. 数据安全



任何搜索开始前：



> Manager 配置必须已经保存。



未保存编辑存在时，应先阻止执行并提示：



```text

当前配置存在未保存修改。

```



避免页面显示值与真正投入 Optimizer 的 JSON 不一致。



\---



\# 33. 第一版明确不做



以下功能暂不属于 V1：



\* 图形化拖拽布阵

\* 搜索候选排行榜

\* Top N 结果

\* 搜索结果历史版本树

\* Baseline 自动版本化

\* 自动采用全部最佳结果

\* 多 Galaxy 全局重跑

\* 多节点并行 Optimizer

\* 搜索算法修改

\* 搜索剪枝参数高级控制台

\* 游戏内自动部署

\* 云同步

\* 多用户

\* 权限系统



\---



\# 34. 第一版优先级



\## P0



必须完成：



```text

Galaxy / Node 选择

Node 多人工版本

Node 默认版本

Common 多人工配置

Common 默认配置

节点 JSON 编辑

Formation 编辑

Loadout 编辑

模板创建节点

复制节点创建

启动单节点搜索

显示 Best Found

显示当前配置与 Best Found 差异

执行 --c 等价操作

同步 --c 结果回 Manager

当前 Galaxy 全局重跑

只输出配置发生变化的节点

```



\## P1



可以随后增加：



```text

搜索运行进度优化

ETA

更好的日志界面

搜索参数 UI

Node 搜索状态统计

模板管理增强

结果差异高亮

```



\## P2



未来考虑：



```text

并行搜索

更多自动化

搜索参数预设

搜索性能分析

```



\---



\# 35. 关键验收用例



\## Case 1：单节点搜索



选择：



```text

G6 / B21 / 默认

Common：默认

```



点击搜索。



系统必须：



1\. 正确复制 Node JSON。

2\. 正确复制 Common JSON。

3\. 执行：



```bat

run\_optimizer.bat g6 B21

```



4\. 能解析 B21.result.json。

5\. 显示 `best\_result`。

6\. 显示 baseline 与 best 的配置差异。



\---



\## Case 2：使用最佳配置



B21 搜索发现：



```text

Corvette Secondary



Shield → None

```



执行：



```text

使用最优配置

```



系统必须产生与：



```bat

run\_optimizer.bat g6 B21 --c

```



等价结果。



并同步更新 Manager：



```text

B21 / 当前版本

```



不得创建新版本。



\---



\## Case 3：人工版本



B21 创建：



```text

默认

Support F2

```



切换到：



```text

Support F2

```



进行搜索。



不得影响：



```text

默认

```



配置。



\---



\## Case 4：Common 切换



G6 创建：



```text

默认

临时 Buff

```



节点搜索选择不同 Common 后，运行目录：



```text

map/g6/common.json

```



必须对应当前选择。



\---



\## Case 5：Galaxy 重跑



选择：



```text

Galaxy 6

```



执行：



```text

重跑当前 Galaxy

```



系统只搜索 G6。



每个节点使用：



```text

Node 默认版本

\+

G6 默认 Common

```



\---



\## Case 6：配置相同但数值变化



Common Damage Scale 提升。



B12：



```text

Used FR

40 → 35

```



但 Best Found 与当前 baseline：



```text

Formation 相同

Loadout 相同

```



最终“发现新方案”列表不得显示 B12。



\---



\## Case 7：配置变化



B13：



```text

Used FR

60 → 59

```



并且：



```text

A1 Frigate → Corvette

```



或 Loadout 发生变化。



最终列表必须显示：



```text

B13

```



\---



\# 36. 核心业务流程总结



最终 V1 的产品核心可以压缩成两条流程。



\### 单节点



```text

选择配置

&#x20;  ↓

搜索

&#x20;  ↓

查看 Best Found

&#x20;  ↓

在游戏中使用该方案

&#x20;  ↓

需要时执行“使用最优配置”

&#x20;  ↓

覆盖当前 baseline

&#x20;  ↓

继续搜索

```



\### 全局属性变化



```text

修改 Galaxy Common

&#x20;  ↓

设为默认

&#x20;  ↓

重跑当前 Galaxy

&#x20;  ↓

逐节点搜索默认版本

&#x20;  ↓

过滤 Formation / Loadout 未变化节点

&#x20;  ↓

得到“需要重新配置”的节点列表

&#x20;  ↓

逐个查看并处理

```



这两条流程构成 V1 的全部核心价值。



\---



\# 37. V1 产品定位



本程序最终定位为：



> \*\*Unnamed Space Idle Fleet Optimizer 的本地配置管理与搜索调度工具。\*\*



它负责：



```text

配置管理

状态版本管理

搜索执行

最佳结果查看

Baseline 更新

Galaxy 批量重算

```



而现有 Optimizer 继续负责：



```text

战斗模拟

候选生成

搜索

剪枝

排序

最佳结果计算

```



两者保持边界清晰，避免为了开发前端而破坏目前已经测试可用的搜索系统。
