---
description: "内嵌 LLM-wiki: the logseq-graph host service backed by the logseq CLI and the model-facing logseq 工具; GUI 抽屉位于 dsh-client-ui-wiki."
kind: "package-group"
---
# packages/logseq

[English](README.md) | 中文

## 摘要

`logseq/` 组提供[`logseq-graph/`](logseq-graph/README.zh.md)、[`tool-logseq/`](tool-logseq/README.zh.md)。二者共同为 agent 提供由 logseq CLI 支撑的无头 LLM-wiki，浏览器抽屉位于 dsh-client-ui-wiki。

## 目录

- [相关文档](#related-documentation)

-----

<a id="related-documentation"></a>
## 相关文档

[子系统参考文档](../../docs/subsystems/wiki.zh.md)拥有穷尽式约定；下方每个包的 README 都会从各自的页面链接到它。

| 包 | 职责 |
|---|---|
| [`logseq-graph/`](logseq-graph/README.zh.md) | 以已安装的 `logseq` CLI 为支撑的 Host 图服务 |
| [`tool-logseq/`](tool-logseq/README.zh.md) | 面向模型的 `logseq_*` 工具（list/show/search/query/upsert/remove/graph/server） |
