# MergeGraph_v0.1

MergeGraph 是一个本地优先的科研上下文与 AI 资产管理原型。当前版本把“本地项目目录”作为主要工作单位：先建立只读扫描快照，再生成可复核的证据包、架构图和发展建议，并将结果投影到画布。

> 发布范围：`MergeGraph_v0.1` 仅包含可公开的源码、Schema、运行说明和脱敏后的计划文档。运行数据、API Key、用户目录、测试夹具和内部评审记录不属于发布内容。

## 当前完成内容

### 本地项目分析

- 项目登记：`POST/GET/PATCH /api/projects`
- 本地路径校验：`realpath`、根目录边界检查、外部符号链接拒绝
- 只读扫描：不执行仓库脚本、安装命令、构建命令或测试
- 扫描快照和文件索引：相对路径、语言、MIME、大小、哈希、行数和排除原因
- 默认排除 Git 元数据、依赖目录、构建缓存、`.env`、证书、私钥和疑似凭据
- Evidence Pack：只使用相对路径、结构摘要和受预算限制的代码片段

### 架构图工作流

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

- 本地模式下使用确定性结构图，不发送项目内容
- 项目明确授权且隐私模式为 `external_ai_opt_in` 时，才调用 OpenAI-compatible `/chat/completions`
- 服务端校验节点、边、证据路径和行号
- 生成 HTML/JSON 文档，并把通过校验的节点和关系投影到画布
- 支持 Archify 风格的 typed IR、证据约束和交付边界；详见 `THIRD_PARTY_NOTICES.md`

### Vue 工作台

左侧功能栏分为：

1. 项目
2. 扫描
3. 架构分析
4. 文件与资产
5. 画布
6. 工作流
7. 设置

侧栏支持缩进状态、光标自动展开、延迟收回、固定、键盘快捷键和窄屏布局。Provider/API Key 在“设置”中全项目共享，API 响应只返回 `hasApiKey`，不会回显完整密钥。

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
| P5 MCP/ComfyUI/Seedance | 未开始 | 需要先冻结连接器输入输出 Schema 和权限边界 |

## 环境要求

### MergeGraph MVP

- Node.js 22 或更高版本
- 现代浏览器
- 不需要独立 SQLite 服务；服务端使用 Node.js 内置 `node:sqlite`
- 不需要安装 npm 依赖，当前浏览器使用本地 vendored Vue 3 构建

已验证的参考环境：Node.js 24.15、npm 11.12、Go 1.27、Docker 29、Python 3.14、pnpm 12。Go、Docker、Python 和 pnpm 只用于参考仓库分析，不是 MVP 启动的必需项。

## 启动

```powershell
cd <PROJECT_ROOT>\MergeGraph_v0.1
npm start
```

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

进入“设置”，填写 Base URL、模型和 API Key 后保存。普通任务和架构分析共用该 Provider。

外部架构分析还需要同时满足：

- 项目隐私模式为“允许外部 AI”
- 当前分析请求显式授权
- Provider Base URL 可访问
- 如设置 `MERGEGRAPH_ALLOWED_HOSTS`，Provider 主机必须在允许列表中

本机模式不需要外部网络，也不会发送源文件内容。

## API 入口

```text
GET/PUT /api/settings/provider
POST/GET/PATCH /api/projects
POST /api/projects/:id/scans
GET /api/scans/:scanId
GET /api/projects/:id/snapshots/:snapshotId/files
POST /api/projects/:id/analyses
GET /api/projects/:id/analyses
GET /api/analyses/:id/documents
GET /api/architecture-documents/:id/source
GET /api/architecture-documents/:id/preview
POST /api/runs
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

- 尚未实现项目删除、导出、权限系统和增量扫描
- Git commit 级证据、完整 last-good/stale 状态和 SVG 导出待补充
- 当前画布为 MVP 自动布局，不等同于完整生产级无限画布
- 外部 AI 目前只支持通用 OpenAI-compatible 接口
- MCP、ComfyUI、Seedance 连接器尚未实现
- 分析请求目前同步等待 Provider，尚未提供流式进度

详见 `docs/PHASE2-PLAN.md`、`docs/PROJECT-PLAN-PUBLIC.md` 和 `docs/SOURCES.md`。

## 参考项目

- [Archify](https://github.com/tt-a1i/archify)：架构图 IR、证据、校验和交付流程
- [infinite-canvas](https://github.com/tigerowo/infinite-canvas)：画布与任务入口
- [Refly](https://github.com/refly-ai/refly)：运行审计、Skill/MCP 方向
- [ComfyUI-Majoor-AssetsManager](https://github.com/MajoorWaldi/ComfyUI-Majoor-AssetsManager)：资产索引和工作流数据
- [ComfyUI-Meld](https://github.com/HappyOnigiri/ComfyUI-Meld)：元数据与谱系
- [TagStudio](https://github.com/TagStudioDev/TagStudio)：文件身份、标签和检索

许可证和实际复用范围记录在 `THIRD_PARTY_NOTICES.md`。