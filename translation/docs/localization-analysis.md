# Unnamed Space Idle 本地化结构分析

分析基准为原版备份 `backup/2026-09-06_47E161C7/SpaceIdle.pck`，SHA-256 为 `47E161C73741E11DF9C5F2B8FCB8DCB71B5930180D1A60407EAAAE8D85B4C5CC`。所有提取、转换和构建均在项目目录内完成。

## 已确认

### Godot 与 PCK

- PCK 头魔数为 `GDPC`，格式版本为 4，头部记录的引擎版本为 Godot 4.7.2。
- GDRETools 2.6.4 能在不提供密钥的情况下加载、列出、校验和提取该 PCK，因此该包未加密且可提取。
- 原包共有 7,359 个资源。存在 `.godot/exported`、`.import`、UID 和 remap 数据。
- 翻译导入配置明确使用 `compress=true`；这是翻译资源的压缩设置，不足以证明 PCK 中每个资源都采用同一种压缩方式。

### 本地化资源

主翻译导入源声明为 `res://Translation.csv`，英文单独声明为 `res://Translation_en.csv`。导出包未保留可直接使用的源 CSV，但保留了导入描述和下列编译资源：

- `res://Translation_en.en.translation`
- `res://Translation.de.translation`
- `res://Translation.pt_BR.translation`
- `res://Translation.ru.translation`
- `res://Translation.zh.translation`
- `res://Translation.zh_TW.translation`
- `res://Translation.tr.translation`
- `res://Translation.kr.translation`

英文 locale 为 `en`，简体中文为 `zh`，繁体中文为 `zh_TW`。资源类型为 Godot `OptimizedTranslation`。消息通过 key 的哈希表映射到各 locale 的字符串池；主表中的 key 本身通常就是英文 UI 文本。

导入元数据显示主 CSV 列顺序为 `key,de,pt_BR,ru,zh,zh_TW,tr,kr`，英文 CSV 为 `key,en`。GDRETools 的 translation-only 恢复报告显示主表 3,145 行中仅 988 个 key 可恢复，并明确警告多个 locale 不同步、行对齐可能不准确。因此没有把恢复结果写入 `translation/translations/official_current.csv`，避免将错位内容当作官方对应关系。

### 测试补丁与验证

测试项为 `Language`：简体中文从“语言”改为“【汉化测试】语言”，仅修改 `res://Translation.zh.translation`。

GDRETools Translation Patch 可以从单行 CSV 生成替换用的编译 Translation 资源。原资源与补丁资源的结构化差分显示：哈希表完全一致；桶表只在同一条消息记录中改变字符串偏移和长度；字符串池只追加了“【汉化测试】语言”的 UTF-8 字节。没有发现第二个 key 或其他翻译消息变化。

测试 PCK 可重新打开并校验全部 7,359 个资源，资源路径集合与原包完全相同。反向提取的目标资源 SHA-256 与构建输入一致，说明测试包内实际装入了预期 Translation 资源。

## 推断

- 游戏运行时会根据 locale 加载相应的编译 `.translation` 资源；`zh` 和 `zh_TW` 是两套独立资源。
- R3 后的中文缺失至少包含“各 locale 与主 key 集合不同步”和“导出包中部分 key 无法从编译资源可靠还原”两类结构问题。现有证据不足以把每条缺失文本进一步归类为中文值为空、仍为英文、官方误译或完全缺少 locale。
- 风险最低的修改方法是维护经过可靠匹配的 key/中文清单，用 GDRETools Translation Patch 生成单个 locale 资源，再以 PCK Patch 替换该资源；没有必要恢复并重建整个 Godot 项目。
- 游戏更新后的增量维护应以新版 PCK 的 SHA-256 建新备份，重新列出 Translation 资源，按 key 比较新增/删除/变化项，再把已审核自定义翻译迁移到新版资源。不能依赖行号对齐。

## 尚未验证

- 尚未运行游戏加载测试 PCK，因此还未动态证明“设置 → Language”界面显示测试文字。
- 尚未逐条分类 R3 后所有中文缺失文本。
- 尚未确认是否有少量运行时生成、脚本硬编码或不经过 Translation 资源的文本。
- 尚未证明 PCK 内所有资源的具体压缩算法；当前仅确认翻译导入启用了压缩。
- GDRETools 恢复出的源 CSV 不够可靠，不能直接作为完整官方翻译基线。

## 推荐流程与风险

推荐构建流程为：验证新版原包哈希 → 建立只读版本备份 → 生成目标 locale 的 Translation Patch → 在备份副本上执行 PCK Patch → 重新列出并校验全部资源 → 反向提取目标资源核对。安装仅在人工确认后使用安全安装脚本。

主要风险包括游戏更新导致 key/资源哈希变化、编译 Translation 无法完整反推源 key、不同 locale 不同步、PCK 重打包造成广泛二进制变化，以及 Steam 更新覆盖补丁。故正式翻译应保存独立、可审核的 key 数据，并始终保留按 SHA 标识的原版备份。
