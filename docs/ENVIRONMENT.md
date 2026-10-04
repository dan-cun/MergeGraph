# MergeGraph 环境说明（公开版）

本文件只记录可复现的工具版本和运行边界，不记录用户名、主机名、磁盘路径、密钥或本机环境变量值。

## MVP 必需环境

| 工具 | 已验证版本 | 用途 |
|---|---:|---|
| Node.js | 24.15 | 本地 API、静态前端、内置 SQLite |
| npm | 11.12 | 启动脚本 |
| 浏览器 | 现代浏览器 | Vue 工作台 |

MVP 使用 Node.js 内置 `node:sqlite`，不需要独立数据库服务，也不需要安装 npm 依赖。

## 参考仓库分析环境

| 工具 | 已验证版本 | 用途 |
|---|---:|---|
| Go | 1.27 | 阅读和复现部分画布后端 |
| Docker | 29 | 参考仓库容器化运行 |
| Python | 3.14 | TagStudio 等参考项目的运行前置 |
| pnpm | 12 | JavaScript 参考仓库依赖 |

这些工具不是 MergeGraph MVP 的启动前置。

## 启动

```powershell
cd <PROJECT_ROOT>\mergegraph-mvp
npm start
```

默认地址为 `http://127.0.0.1:4310`。端口冲突时：

```powershell
$env:PORT = '4311'
npm start
```

可选数据目录：

```powershell
$env:MERGEGRAPH_DATA_DIR = '<MERGEGRAPH_HOME>\data'
npm start
```

## 运行边界

- 服务默认只绑定 loopback。
- 扫描只读，不执行项目脚本、安装命令、构建命令或测试。
- 项目扫描与文件 API 拒绝根目录外路径和外部符号链接。
- 外部 Provider 只在项目授权和请求授权同时成立时调用。
- 参考仓库的完整构建、桌面打包和宿主服务不属于本版本验收范围。