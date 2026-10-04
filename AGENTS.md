# 项目协作与交付规范

## 任务计划与并行协作

- 接到任务后，先形成简要计划，写明目标、范围、依赖、验收标准、风险和验证方式。
- 仅在子任务边界清晰、彼此独立且并行确实有收益时委派子 agent。小任务或高度耦合任务可以跳过委派，并在计划中说明原因。
- 每个子任务必须明确输入、输出、可修改范围、时限和失败回退方案。尽量避免多个 agent 同时修改同一文件。
- 主 agent 负责整合结果、处理冲突、检查差异、运行验证并承担最终交付责任。

## 数据、事实与结果核验

- 包含外部事实、数据或计算结果的交付物，交付前由独立、只读的监督 agent 进行核验。
- 核验应检查来源、引用日期、原始数据、转换过程、代码与版本、可复现命令，以及抽样、哈希、单位和约束的一致性。
- 生成数据、模拟数据和示例数据必须明确标注；无法确认的内容必须标明未知、推测或待核实，不得伪装成已验证事实。
- 监督结果分为“通过”“有条件通过”“不通过”。重大未解决问题不得交付，监督范围、证据和未解决项应随交付物留档。
- 纯创意或纯格式任务可跳过数据真实性核验，但仍需进行适用的格式和一致性检查。

## 可复现性

- 代码、数据和结果应提供可复现命令、依赖版本和必要的环境说明。
- 结果说明应指出输入数据、关键参数、生成或计算步骤，以及已知限制和不确定性。

## 文档命名

- 面向用户的说明文档，标题和新增文件名默认使用中文并采用 UTF-8 编码。
- `AGENTS.md`、`README.md`、`CHANGELOG.md`、`LICENSE`、`GLOSSARY.md`、`docs/agents/*.md`，以及配置、脚本、API 所需的标准路径和已有公开文件名属于固定例外，不得为中文命名而改动。
- 改动文件名时，必须同步更新链接、目录索引和构建配置；没有必要时优先保留已有路径。

## 交付前检查

- 主 agent 交付前检查验收标准、工作区差异、测试或验证结果、文档链接和未解决问题。
- 涉及个人信息、密钥或敏感数据时，先脱敏，禁止写入日志或交付物。
- 任务范围、验收标准或数据来源发生变化时，更新计划并重新检查受影响结果。

## Agent skills

### Issue tracker

Issues and specs are tracked as local Markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout with a root `GLOSSARY.md` and `docs/adr/` when those documents exist. See `docs/agents/domain.md`.
