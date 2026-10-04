# MergeGraph 第三方声明

## Archify

MergeGraph 的架构图中间表示、证据约束和交付工作流参考并适配了 Archify：

- 项目地址：<https://github.com/tt-a1i/archify>
- 分析提交：`d5a1333d7447c866a765adac7d4d062f2f02e4d2`
- 许可证：MIT
- 版权：Copyright (c) 2026 tt-a1i (Archify); Copyright (c) 2025 Cocoon AI

当前 MergeGraph 通过 `lib/archify-bridge.mjs` 将五类工作区图谱适配到 Archify
的 architecture、workflow、sequence、dataflow 和 lifecycle 输入，并在同一 Node
进程中调用 `lib/archify-renderer-api.mjs` 导出的纯函数 renderer 完成真实校验与渲染，
不再为每张图启动 `vendor/archify/bin/archify.mjs` 子进程。运行时随发行物复制了
Archify 的 `renderers/`、`schemas/`、`assets/` 和 CLI 依赖文件；复制内容固定于
上述提交，未复制 `.git`、测试目录或 `node_modules`。上游许可证和完整第三方声明
保存在 `vendor/archify/LICENSE` 与 `vendor/archify/THIRD_PARTY_NOTICES.md`。

为支持进程内调用，MergeGraph 在五个 `render-*.mjs` 文件中增加了纯函数导出，并
保留原有的独立 CLI 薄适配层；纯函数只接收内存中的 Archify JSON，返回 SVG、元数据
和卡片数据，不负责写文件。

Archify 的品牌向量、字体和商标材料有各自的来源与使用条件。MergeGraph
首轮不打包这些材料；未来若启用，应同时保留对应的许可证、来源和商标说明。


## Vue

The browser shell vendors the Vue 3.5.22 global production build in `public/vendor/vue.global.prod.js` for an offline local-first startup. Vue is distributed under the MIT License; the bundled file retains its upstream license header. Source: <https://github.com/vuejs/core>.
