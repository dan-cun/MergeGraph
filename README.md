# MergeGraph_v0.1

MergeGraph 是一个本地优先的科研上下文与 AI 资产管理原型。当前版本把“本地项目目录”作为主要工作单位：先建立只读扫描快照，再生成可复核的证据包、架构图和发展建议，并将结果投影到画布。

> 发布范围：`MergeGraph_v0.1` 仅包含可公开的源码、Schema、运行说明和脱敏后的计划文档。运行数据、API Key、用户目录、测试夹具和内部评审记录不属于发布内容。

## 当前完成内容

### 本地项目工作区

- 通过本地目录地址创建、切换和刷新工作区：`POST/GET/PATCH /api/workspaces`
- 首次打开工作区快速返回，后台扫描文件、生成快照和五类图谱；状态可通过 `GET /api/workspaces/:id/status` 查询
- 文件索引包含相对路径、语言、大小、哈希、行数和扫描摘要：`GET /api/workspaces/:id/files`
- 工作区监听使用 `fs.watch`，任务执行器产生的变化事件会进入图谱和任务上下文
- `AGENTS.md` 按目录发现、排序和合并，任务读取有效指令：`GET /api/instructions?workspaceId=...`
- AI 补丁和 `fs.watch` 外部变更都会记录逐文件变化事件；任务结束后主体流程图重生成并发布 `graph_updated` 事件

### 五类图谱与 Archify 工作流

```text
ProjectImporter
  -> PathGuard
  -> RepoSnapshot
  -> RepositoryScanner
  -> EvidencePacker
  -> ArchitectureDiagramIR
  -> Validator
  -> ArchifyAdapter
  -> HTML/JSON artifact
  -> CanvasProjector
```

- `main_flow`、`asset_call`、`execution`、`agent_relation`、`deployment_ownership` 五类图谱分别保存节点、边、证据、状态和版本
- `lib/archify-bridge.mjs` 将五类图谱适配到 Archify 的 `workflow`、`dataflow`、`sequence`、`lifecycle`、`architecture` 类型
- 图谱生成时直接调用 `lib/archify-renderer-api.mjs` 的纯函数 renderer，输入内存中的 Archify JSON 并返回 SVG/卡片数据；HTML 写入和回执由 MergeGraph 负责，不再依赖 CLI 子进程或 `process.argv`
- `vendor/archify/` 固定可复现版本，渲染后保存 HTML/SVG、输入哈希、输出哈希和回执
- 无证据的关系不会被补成虚假连线；没有足够数据时界面显示明确空状态
- Archify 失败时保留上一份可用图谱元数据；复用范围见 `THIRD_PARTY_NOTICES.md`

### Vue 工作台

左侧功能栏分为工作区、文件扫描、AI 任务、项目指令、网址与域名和 Provider 设置。中央区域是 SVG 白板，顶部为五类图谱页签，右侧是节点检查器，底部是 AI 编程任务栏。侧栏支持缩进、悬停展开、固定和窄屏布局；检查器打开时五个页签和任务发送按钮仍保持可操作。白板支持鼠标滚轮缩放，缩放中心跟随光标位置；拖拽平移和顶部缩放按钮继续可用。

Provider/API Key 通过 `/api/settings/provider` 全项目共享。页面只显示是否已配置，不回显完整密钥；留空 API Key 保存时会保留已有值。

### 首轮资产与画布能力

- 文件资产导入、SHA-256 去重、媒体信息和 JSON sidecar
- 画布节点与边持久化
- 自引用边和孤儿边校验
- 普通 AI 运行记录、输入输出关系和错误记录
- 本地 mock Provider，便于无外部网络运行

## 当前进度

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 资料、环境与许可证审查 | 已完成 | 已固定参考仓库提交并记录运行边界 |
| P1 数据模型与 Schema | 已完成 | SQLite、sidecar、ArchitectureDiagramIR 已建立 |
| P2 Vue 工作台与项目扫描 | 已完成首轮 | 项目登记、扫描、隐私开关和左侧栏已可用 |
| P3 Provider 与架构分析 | 已完成首轮 | 本地确定性分析和授权外部 Provider 已打通 |
| P4 架构图交付与画布投影 | 已完成首轮 | HTML/JSON 文档、证据校验和画布投影已打通 |
| P5 工作区重构与 AI 编程 | 已完成首轮 | Vue 工作区、SVG 白板、五类图谱、任务步骤、补丁应用、检查、回滚和文件高亮已接通 |
| P6 MCP/ComfyUI/Seedance/协作权限 | 后置 | 仅保留扩展接口，待工作区核心流程稳定后接入 |

## 环境要求

### MergeGraph MVP

- Node.js 22 或更高版本
- 现代浏览器
- 不需要独立 SQLite 服务；服务端使用 Node.js 内置 `node:sqlite`
- 不需要安装 npm 依赖，当前浏览器使用本地 vendored Vue 3 构建；Archify 运行时已固定在 `vendor/archify/`

已验证的参考环境：Node.js 24.15、npm 11.12、Go 1.27、Docker 29、Python 3.14、pnpm 12。Go、Docker、Python 和 pnpm 只用于参考仓库分析，不是 MVP 启动的必需项。

## 启动

```powershell
cd <PROJECT_ROOT>\mergegraph-mvp
npm start
```

本轮生产路径验收命令：

```powershell
node --check server.mjs
node --check public/app.js
node --test test/tasks.test.mjs test/graphs.test.mjs test/http-integration.test.mjs
```

当前结果：任务、图谱和 HTTP 联调共 `9/9` 通过；本地页面已实测工作区加载、五个页签切换、文件索引、任务历史和 Provider 设置入口。工作区创建接口返回初始化状态，扫描和图谱生成在后台完成。

默认监听 `127.0.0.1:4310`。如端口冲突，可以在当前 PowerShell 会话指定：

```powershell
$env:PORT = '4311'
npm start
```

数据目录默认为项目下的 `data/`。如需改到其他本地目录：

```powershell
$env:MERGEGRAPH_DATA_DIR = '<MERGEGRAPH_HOME>\data'
npm start
```

浏览器打开服务输出的本地地址即可。

## Provider 配置

在工作台左侧打开“Provider 设置”，填写 Base URL、模型和 API Key 后保存。普通编码任务和图谱分析共用该配置。Base URL 留空时使用本地只读规划，不发送项目内容；填写 OpenAI-compatible 地址后，任务执行器会请求 `/chat/completions` 并只接受结构化计划与文件操作。

## API 入口

```text
GET/PUT /api/settings/provider
POST/GET/PATCH /api/workspaces
GET /api/workspaces/:id/status
POST /api/workspaces/:id/close
POST /api/workspaces/:id/scan
GET /api/workspaces/:id/files
GET /api/workspaces/:id/file?path=...
GET /api/graphs?workspaceId=...&type=...
POST /api/graphs
GET/PUT /api/graphs/:id
GET /api/graphs/:id/nodes/:nodeId
POST /api/tasks
GET /api/tasks/:id
GET /api/tasks/:id/steps
GET /api/tasks/:id/events
GET /api/tasks/:id/patches
GET /api/conversations/:id/messages
POST /api/tasks/:id/start|cancel|rollback
GET /api/instructions?workspaceId=...
GET/POST /api/deployments
POST /api/deployments/discover
```

项目和文件 API 只接受 loopback 请求。扫描上限和 Evidence Pack 预算在服务端受控，避免一次性读取整个仓库。

## 安全与发布边界

不要提交以下内容：

- `data/`、SQLite、WAL/SHM、assets、sidecars
- `.env*`、API Key、Bearer Token、证书和私钥
- 运行日志、测试夹具、mock 响应和内部评审记录
- 绝对路径、用户名、主机名、磁盘结构和原始项目文档

发布包中的计划文档使用 `<PROJECT_ROOT>` 和 `<MERGEGRAPH_HOME>` 占位符。真实密钥只应保存在本地受限存储中，不应写入画布、ContextBundle、sidecar、日志或 Git。

## 当前限制与后续计划

- 当前画布为 SVG MVP，支持鼠标滚轮缩放（光标锚点）、拖拽平移、适配视图和位置持久化；后续可替换为 Canvas/WebGL
- Provider 返回的结构化操作会被路径校验、任务备份和白名单检查包住
- 多用户、团队权限、远程同步和在线部署执行尚未纳入本轮
- MCP、ComfyUI、Seedance 连接器尚未实现
- 本地 mock Provider 只生成可追踪的只读步骤；真实文件修改需要配置 OpenAI-compatible Provider

总体实施任务见 `docs/总体实施任务.md`；前端盘点和联调记录见 `docs/前端占位与待接通功能.md`、`docs/前后端联调验收.md`。

## 参考项目

- [Archify](https://github.com/tt-a1i/archify)：架构图 IR、证据、校验和交付流程
- [infinite-canvas](https://github.com/tigerowo/infinite-canvas)：画布与任务入口
- [Refly](https://github.com/refly-ai/refly)：运行审计、Skill/MCP 方向
- [ComfyUI-Majoor-AssetsManager](https://github.com/MajoorWaldi/ComfyUI-Majoor-AssetsManager)：资产索引和工作流数据
- [ComfyUI-Meld](https://github.com/HappyOnigiri/ComfyUI-Meld)：元数据与谱系
- [TagStudio](https://github.com/TagStudioDev/TagStudio)：文件身份、标签和检索

许可证和实际复用范围记录在 `THIRD_PARTY_NOTICES.md`。
