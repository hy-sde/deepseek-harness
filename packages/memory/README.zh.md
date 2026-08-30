---
description: "agent 维护的项目记忆: Host 记忆服务 (retain/recall/reflect/learn/memory_edit/mine_sessions) and its model-facing 工具."
kind: "package-group"
---
# packages/memory

[English](README.md) | 中文

## 摘要

`memory/` 组提供[`memory/`](memory/README.zh.md)、[`tool-memory/`](tool-memory/README.zh.md)。二者共同为 agent 提供跨会话、经注入中和的持久项目记忆。

## 目录

- [相关文档](#related-documentation)

-----

<a id="related-documentation"></a>
## 相关文档

[子系统参考文档](../../docs/subsystems/memory.zh.md)拥有穷尽式约定；下方每个包的 README 都会从各自的页面链接到它。

| 包 | 职责 |
|---|---|
| [`memory/`](memory/README.zh.md) | Host 记忆服务：retain、recall、reflect、learn、memory_edit、mine_sessions |
| [`tool-memory/`](tool-memory/README.zh.md) | 基于记忆服务的面向模型工具 |
