# MergeGraph MVP 实现对照

| 用户目标 | MVP 位置 | 当前状态 | 下一步 |
|---|---|---|---|
| 无限画布 | `mergegraph-mvp/public/app.js` + `styles.css` | 已支持拖拽、缩放、节点位置持久化 | 增加显式连线交互、视图版本和撤销重做 |
| 图片/文件资产库 | `server.mjs` `assets` 表 | 已支持浏览器导入、重复哈希去重、媒体类型、大小和预览 URL | 增量文件夹扫描、独立缩略图队列、移动/断链事件 |
| 标签和上下文 | `assets.tags_json`、侧栏检查器 | 已支持标签、提示词、备注、项目和许可字段 | 命名空间、别名、父标签和查询 AST |
| 可迁移上下文 | `schemas/context-sidecar.schema.json`、`data/sidecars/*.context.json` | 已支持 sidecar 写入和读取 | 导出完整 graph context、Schema 校验、幂等导入 |
| AI 资产谱系 | `runs` 与 `run_links` 表 | 已记录请求、输入资产、结果、状态、错误 | 输出资产版本、工作流哈希、置信度和人工审核 |
| 第三方 API | `POST /api/runs` | 已支持 OpenAI 兼容 `/chat/completions`；未配置时提供本地演示 | 统一 provider 状态机、图片/视频异步任务；ComfyUI/Seedance 放到第二阶段 |
| MCP / Skill | 尚未接入 | 有数据模型预留方向，符合首轮跳过 agent 网络的计划 | 先定输入输出契约，再接 MCP server 和版本化 Skill |

## 选型结论

第一版采用浏览器 Web 画布 + Node 本地 API + Node 内置 SQLite + JSON sidecar。它保留了 infinite-canvas 的画布入口、TagStudio 的稳定索引、Meld/Majoor 的生成资产谱系思路、Refly 的运行审计方向，同时把每个参考项目的运行时和许可证隔离开。SQLite 是图和检索的真相源；画布节点只引用实体；sidecar 是交换格式而不是唯一数据库。
