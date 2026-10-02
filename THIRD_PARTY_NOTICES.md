# MergeGraph 第三方声明

## Archify

MergeGraph 的架构图中间表示、证据约束和交付工作流参考并适配了 Archify：

- 项目地址：<https://github.com/tt-a1i/archify>
- 分析提交：`d5a1333d7447c866a765adac7d4d062f2f02e4d2`
- 许可证：MIT
- 版权：Copyright (c) 2026 tt-a1i (Archify); Copyright (c) 2025 Cocoon AI

当前 MergeGraph 通过 `lib/architecture-ir.mjs` 保持自己的
`ArchitectureDiagramIR` 数据模型，并提供到 Archify
`architecture.schema.json` 的适配函数。该目录没有复制 Archify 的渲染器源码；
如果后续将 Archify 作为运行时依赖或复制其代码，必须随发行物保留上游 MIT
许可文本及 Archify 仓库中的 `THIRD_PARTY_NOTICES.md`。

Archify 的品牌向量、字体和商标材料有各自的来源与使用条件。MergeGraph
首轮不打包这些材料；未来若启用，应同时保留对应的许可证、来源和商标说明。


## Vue

The browser shell vendors the Vue 3.5.22 global production build in `public/vendor/vue.global.prod.js` for an offline local-first startup. Vue is distributed under the MIT License; the bundled file retains its upstream license header. Source: <https://github.com/vuejs/core>.
