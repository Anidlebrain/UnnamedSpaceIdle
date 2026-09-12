# Unnamed Space Idle 中文补丁项目规则

## 当前阶段

项目目前处于 `pck_localization_validation` 阶段。允许在项目目录中的原版副本上提取、分析和构建测试 PCK；不得自动安装 PCK，也不得修改 Steam 游戏目录或存档。

## 主智能体职责

主智能体负责：

- 项目架构与维护规则
- PCK / Godot 资源分析
- 游戏更新版本差异分析
- 提取、合并与构建脚本
- 翻译质量、术语与占位符审核
- `NEED_REVIEW` 处理
- 最终构建、安装与回滚

普通文本的批量翻译应优先交给 `translator` 子智能体。

## translator 权限边界

`translator` 只能：

- 读取 `translation/glossary/glossary.csv`
- 读取主智能体明确指定的待翻译文件
- 修改主智能体明确指定的翻译中间文件
- 翻译普通 UI 与描述文本
- 对不确定内容标记 `NEED_REVIEW`

`translator` 禁止：

- 修改或复制 `SpaceIdle.pck`
- 修改 Steam 游戏目录
- 修改 `scripts/` 或 `AGENTS.md`
- 修改原始官方翻译备份
- 执行构建、安装或回滚
- 创建其他子智能体

## 翻译规则

1. `translation/glossary/glossary.csv` 中的术语优先级最高。
2. 不确定的游戏机制术语不得猜测，必须标记 `NEED_REVIEW`。
3. 不得删除、增加或修改占位符、标签和转义字符。
4. 必须保留 `%s`、`%d`、`%.2f` 等 printf 格式、`{0}`、`{1}`、`{name}`、BBCode / Godot 标签、`\n` 与其他转义字符。
5. 不得擅自修改数字或公式。
6. 中文应符合游戏 UI 表达，不要求逐字直译。
7. 同一英文术语必须保持一致。

## 安全规则

- 不修改游戏安装目录，不替换 `SpaceIdle.pck`。
- 不解包或重新打包 PCK，不创建假的 PCK。
- 不下载或运行来源不明的工具。
- 需要分析游戏文件时，除明确允许的只读检测外，应先将必要文件复制到项目工作目录，再在副本上操作。
- 不删除或覆盖未知文件；脚本必须可安全重复运行。
- 所有 PowerShell 脚本应兼容 Windows PowerShell 5.1 和 PowerShell 7，并尽量只使用系统自带功能。
