# MergeGraph 第二阶段主计划：本地项目智能分析器

> 版本：v0.1（计划评审稿）  
> 日期：2026-10-02  
> 状态：计划已评审并完成 P1–P4 首轮实现；P5 连接器留作后续迭代。

## 0. 当前交付状态

- 已完成：本地项目登记、只读扫描快照、敏感文件排除、全项目 Provider、证据打包、架构图 IR 校验、Archify 适配、HTML 预览、画布投影和 Vue 侧栏。
- 已验收：隔离 fixture 的扫描、密钥不回显、架构图生成、证据范围校验、HTML 预览和外部 Provider 模拟调用。
- 待迭代：Git commit 级证据、增量扫描、SVG 交付、last-good/stale 完整状态、MCP/ComfyUI/Seedance 连接器。

## 1. 结论与产品边界

这次调整是合理的，但需要把产品单位从“上传素材”改成“本地项目”。图片、视频、文档等素材继续作为项目资产；源码目录、扫描快照、AI 分析结果和架构图要单独建模，不能把一个仓库拆成大量普通素材。

第二阶段的产品名称可以暂定为 **MergeGraph Local Project Intelligence**：

```text
本地项目目录
  → 只读扫描与快照
  → 证据打包
  → AI 结构化分析
  → 架构图校验与渲染
  → 无限画布投影
  → 发展建议、风险和可追溯复核
```

默认行为是本机优先。源目录不被修改，也不被复制到资产目录；只有用户明确导入或导出时才复制文件。外部 AI 调用前显示实际发送的文件范围，并排除密钥、私钥、二进制和超大文件。

## 2. 前端预期格式

### 2.1 桌面布局

```text
┌────────────────────────────────────────────────────────────────────────┐
│ 项目标题 / Git 状态 / 扫描状态 / 保存状态 / 快捷键                      │
├──┬──────────────────────────────────────────────────┬───────────────────┤
│  │  画布工具栏：架构图 · 文件图 · 研究图 · 搜索      │                   │
│左│──────────────────────────────────────────────────│  上下文检查器     │
│侧│                                                  │  当前节点/文件    │
│栏│                 无限画布                         │  证据/建议/运行    │
│  │                                                  │                   │
│  │  架构节点、关系、文件证据、建议卡片               │                   │
├──┴──────────────────────────────────────────────────┴───────────────────┤
│ 当前任务进度 / 错误 / 重试 / 最近一次通过验证的图                         │
└────────────────────────────────────────────────────────────────────────┘
```

- 收缩状态：左侧 44px，只显示图标、当前项目状态点、任务徽标。
- 展开状态：248–288px，覆盖画布左边缘，不重新计算画布视口。
- 右侧检查器可折叠；窗口宽度低于 960px 时变成抽屉，低于 720px 时左栏改成显式菜单或底部工具栏。
- 迁移技术：Vue 3 + TypeScript + Vite + Pinia；画布优先使用 Vue Flow 或等价 Vue 组件，领域数据仍由 MergeGraph 服务端保存。

### 2.2 左侧边框栏的自动展开

1. 光标进入左侧 14px 热区，或键盘聚焦任一侧栏按钮时展开。
2. 光标在侧栏、触发按钮或表单控件内时保持展开。
3. 离开后等待 420ms 再收回；输入框、拖拽、菜单和弹窗打开时暂停收回。
4. 点击图钉锁定展开；再次点击或按 `[` 解除锁定；`Esc` 收回。
5. `prefers-reduced-motion` 时取消滑动动画。触屏没有 hover，使用显式展开按钮。
6. 隐藏面板不得进入 Tab 顺序；图标必须有 `aria-label` 和 tooltip，不能只靠颜色传达状态。

## 3. 左侧功能分类

| 分组 | 首轮入口 | 主要功能 |
|---|---|---|
| **项目** | 当前项目 | 新建/打开项目、切换最近项目、项目根目录、Git 分支与提交、只读状态 |
| **扫描** | 扫描项目 | 扫描预览、文件树、包含/排除规则、敏感文件命中、快照历史、重新扫描 |
| **架构分析** | 一键生成架构图 | 架构/工作流/数据流/时序/生命周期模式、上下文预算、外部 AI 授权、进度、重试、发展建议 |
| **架构图** | 当前图 | last-good 图、候选版本、证据跳转、上游/下游聚焦、绑定画布、HTML/SVG/JSON 导出 |
| **文件与资产** | 项目文件 | 相对路径文件树、图片/视频/音频预览、标签、sidecar、重复项、分析输出资产 |
| **画布** | 当前视图 | 架构图、文件依赖图、研究图、添加节点、保存/撤销/重做、视图版本 |
| **工作流** | 运行中心 | 分析任务、AI 调用、运行记录、失败重试、输出归档；后续接 MCP、ComfyUI、Seedance |
| **设置** | 项目设置 | 全局 Provider、全项目 API Key、扫描默认排除、数据目录、导出/备份、开源声明 |

首轮每个分组只放 3–5 个高频动作；低频选项进入检查器或“更多”，避免侧栏变成第二个设置页。

## 4. 本地目录输入与扫描规则

### 4.1 输入模式

首轮支持两种模式，并在界面上明确区分：

- **本地路径模式**：本机服务绑定 `127.0.0.1`，用户输入或选择目录路径，服务端执行 `realpath` 并登记根目录。适合当前本地项目管理器。
- **目录选择/上传模式**：浏览器使用 `webkitdirectory` 或 File System Access API，提交文件内容和相对路径。它是兼容模式，不等同于直接读取本机目录。

后续桌面壳（Tauri/Electron）再接入原生目录选择器。未完成身份认证、CSRF 和审计前，不允许为方便目录访问而绑定 `0.0.0.0` 或反代到公网。

### 4.2 扫描原则

- 源目录只读，不执行仓库中的脚本、安装命令、构建命令或测试。
- 默认排除 `.git`、`.hg`、`.svn`、
ode_modules`、`vendor`、`dist`、`build`、`.next`、`target`、缓存、临时目录和嵌套仓库。
- 默认排除 `.env*`、私钥、证书、token 文件和明显凭据目录；排除项仍记录原因。
- 每个文件保存项目内相对路径、语言、MIME、大小、mtime、哈希、行数、是否文本、是否疑似密钥、是否纳入上下文。
- 默认不跟随指向根目录外的符号链接；读取前重新 `realpath` 并检查路径仍在根目录内。
- AI 只接收相对路径、结构摘要和受预算限制的代码片段，不接收绝对路径和原始密钥。

## 5. 修改后的工作架构格式

### 5.1 分层工作流

```text
ProjectImporter
  ↓
PathGuard（realpath、越界、符号链接、loopback）
  ↓
RepoSnapshot（根指纹、远端、commit、dirty、manifestHash）
  ↓
RepositoryScanner（文件、清单、入口、依赖候选、密钥命中）
  ↓
EvidencePacker（相对路径、行范围、预算、脱敏、contextHash）
  ↓
ArchitecturePrompt + 全项目 Provider
  ↓
ArchitectureDiagramIR（MergeGraph schema）
  ↓
ArchitectureValidator
  ↓
ArchifyAdapter：validate → render → deliver → check
  ↓
ArchitectureArtifact（IR + HTML/SVG + receipts + evidence）
  ↓
CanvasProjector（投影到无限画布，保留图版本与证据引用）
```

### 5.2 一键架构图的用户行为

1. 选择或粘贴项目目录，显示根目录、Git 状态、扫描范围和隐私状态。
2. 先做快速扫描预览，用户确认排除规则和外部 AI 范围。
3. 生成不可变快照，记录文件清单和 `manifestHash`。
4. 生成 `EvidencePack`，按 token/字节预算分块并脱敏。
5. AI 只返回严格 JSON：架构节点、关系、边界、建议、未决问题和证据范围。
6. 服务端校验节点、边、证据路径和行号；失败候选不替换上一次通过验证的图。
7. 校验通过后生成 HTML/SVG/JSON 交付物，并自动投影到画布。
8. 用户可以查看源文件、证据行、上游/下游关系、建议和风险；代码变化后旧图标记为 stale。

### 5.3 数据对象

| 对象 | 关键字段 | 作用 |
|---|---|---|
| `projects` | `id`, 
ame`, `root_path`, `policy_json`, `privacy_mode`, `last_snapshot_id` | 登记本地项目；根路径只在本机数据库使用 |
| `project_snapshots` | `project_id`, `manifest_hash`, `scanner_version`, `stats_json`, `status` | 保存可复核的扫描版本 |
| `project_files` | `snapshot_id`, `relative_path`, `language`, `content_hash`, `included`, `exclusion_reason` | 文件索引，不复制源码 |
| `analysis_runs` | `project_id`, `snapshot_id`, `mode`, `context_hash`, `status`, `error` | 记录扫描、AI、校验和渲染过程 |
| `architecture_documents` | `analysis_id`, `ir_json`, `validation_json`, `artifact_path`, `is_last_good` | 保存架构图真相与交付物 |
| `architecture_evidence` | `document_id`, `project_file_id`, `line_start`, `line_end`, `excerpt_hash` | 连接图节点与源码证据 |
| `canvas_nodes/edges` | `projectId`, `snapshotId`, `analysisId`, `architectureNodeId` | 保存用户可编辑的画布投影 |
| `provider_profiles` | `provider_id`, `base_url`, `model`, `api_key_ref`, `enabled` | 全项目共享 Provider 配置 |

### 5.4 API 草案

```text
POST /api/projects
GET  /api/projects
GET  /api/projects/:id
PATCH /api/projects/:id
POST /api/projects/:id/scans
GET  /api/scans/:scanId
GET  /api/projects/:id/snapshots/:snapshotId/files
POST /api/projects/:id/analyses
GET  /api/analyses/:id
GET  /api/analyses/:id/documents
POST /api/analyses/:id/refine
POST /api/analyses/:id/commit
GET  /api/architecture-documents/:id/source
GET  /api/architecture-documents/:id/preview
GET/PUT /api/settings/provider
```

## 6. 全项目 API Key 设计

- 用户只在“设置 → Provider”配置一次；普通 AI 运行、架构分析和未来连接器都引用同一个 profile。
- 前端只收到 `hasApiKey`、Provider、模型和验证状态；不把完整 key 写入 Pinia、localStorage、画布、sidecar、ContextBundle、运行日志或响应记录。
- 服务端运行时解析 `api_key_ref`；首轮可以使用本机受限密钥文件或现有设置迁移，后续迁移 Windows Credential Manager/系统密钥环。
- `PUT` 支持更新和显式清除；不能把掩码值 `••••••••` 当作新 key 保存。
- 项目默认继承应用 Provider；需要覆盖时单独标记来源，切换项目不得串用前一项目的密钥。

## 7. Archify 参考、变量适配与开源声明

Archify 的可复用价值是“仓库证据 → typed JSON IR → 校验 → 渲染 → 原子交付 → 可追溯收据”的业务链路。它本身是 Agent Skill 与 Node 渲染/校验工具的组合，不是 MergeGraph 的仓库扫描后端，因此 MergeGraph 仍需自己的项目导入、扫描、证据打包和 AI 编排。

| Archify 概念 | MergeGraph 名称 |
|---|---|
| `meta.repository` | `RepoSnapshot` |
| `components[]` | `architectureNodes[]` |
| `connections[]` | `architectureEdges[]` |
| `sources[]` | `evidenceRefs[]` |
| typed JSON IR | `ArchitectureDiagramIR` / `diagramIr` |
| `validate` receipt | `validationReceipt` |
| `deliver` receipt | `artifactReceipt` |
| last-good artifact | `is_last_good` / `activeDocumentId` |
| `cards[]` | `insightCards[]` / 发展建议 |

第一版采用独立 `ArchifyAdapter`，只转换 MergeGraph IR 与 Archify 架构图 IR，不把 Archify 的字段散落到 Vue 组件和数据库中。若复制代码或资源，必须保留 MIT 文本、上游 commit 和第三方声明；若只采用公开业务设计，也在开源声明中点名归因：

> 架构图生成与交付逻辑参考并调用 Archify：<https://github.com/tt-a1i/archify>。分析基于 commit `d5a1333d7447c866a765adac7d4d062f2f02e4d2`；Archify 采用 MIT License。具体复制文件和第三方资源另列于 `THIRD_PARTY_NOTICES.md`。

## 8. 分阶段实施

### P0：冻结契约

- 评审本计划、`ArchitectureDiagramIR v1`、目录隐私边界和侧栏信息架构。
- 决定首轮只支持本机路径、目录上传，还是同时支持两种模式。
- 建立 JSON Schema、API 类型和 Archify NOTICE。

### P1：Vue 壳与侧栏

- 建立 Vue 3/Vite/TypeScript/Pinia 工程。
- 复刻当前资产、画布、运行和设置功能，保持原 Node API 可用。
- 完成 44px 收缩、248–288px 展开、自动弹出、锁定、键盘和窄屏降级。

### P2：项目登记与扫描

- 增加 `projects/project_snapshots/project_files` 和项目 API。
- 实现路径校验、只读扫描、排除策略、密钥检测、增量哈希和扫描进度。
- 把项目文件与普通资产分离，保留相对路径和证据。

### P3：全局 Provider 与分析编排

- 将现有 provider 设置迁移为全项目通用 profile。
- 建立 `EvidencePack`、ContextBundle、分析状态机和失败重试。
- 加入结构化 AI 输出和 `ArchitectureDiagramIR` 校验。

### P4：架构图交付与画布投影

- 实现 `ArchifyAdapter`、HTML/SVG/JSON/receipt 交付和 last-good。
- 将通过验证的架构节点、关系和证据映射到无限画布。
- 支持证据跳转、建议卡片、快照比较、stale 标记和导出。

### P5：软件生态连接器

- 在工作流分组接入 MCP、ComfyUI、Seedance 等连接器。
- 每个连接器单独定义权限、输入输出 schema、许可证和失败重试。
- 连接器不改变项目扫描和架构图核心模型。

## 9. 验收门槛

- 输入不存在路径、文件路径、`..` 越界路径和根目录外符号链接时被拒绝；源目录未被修改。
- 扫描包含 `.git`、缓存、超大文件、Unicode 路径和伪密钥的 fixture，排除原因可见。
- 同一目录重复扫描不重复建项目文件；快照有稳定 manifest hash。
- 外部 AI 只收到用户确认的相对路径和脱敏证据；绝对路径和 API Key 不出现在请求、日志、sidecar 或画布。
- AI 返回坏 JSON、悬空边、重复节点、越界行号时不会覆盖 last-good 图。
- 成功图能打开 HTML/SVG、回到源码证据，并投影到画布；源代码变化后旧图显示 stale。
- 侧栏在 hover、键盘、触屏和窄屏下都有等价入口，表单展开时不会自动收回。
- `THIRD_PARTY_NOTICES.md` 和产品“关于/开源声明”点名 Archify、MIT 和实际复用范围。

## 10. 当前不纳入

- 不在第一步同时完成 ComfyUI、Seedance、MCP 全部连接器。
- 不执行仓库脚本、安装依赖或构建命令来“推断架构”。
- 不把 AI 自由文本直接当作画布或数据库真相。
- 不允许为目录扫描把本地服务开放到公网。

