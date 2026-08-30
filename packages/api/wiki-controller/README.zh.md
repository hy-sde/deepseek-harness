---
description: "主机 wiki 控制器：把 logseq-graph 线路投影到声明的形状、供内嵌 LLM-wiki 使用的 Typert `wiki` Remote 命名空间。"
kind: "package-reference"
---
# Wiki 控制器

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-wiki-controller` 拥有 Host `ctx.wikiController` 服务：GUI 客户端用来访问内嵌 LLM-wiki 图的 Typert `wiki` Remote 命名空间。其方法把 logseq-graph 线路（`ctx.wikiGraph`，参见 [dsh-logseq-graph](../../logseq/logseq-graph/README.zh.md)）投影到声明的请求/值形状——页面行、带反向链接的嵌套块树、标签与属性列表、文本搜索、原始 Datalog 查询行，以及 upsert/remove/server 动作。控制器还对失败进行分类（缺少 graph seam 时为 `wiki-unavailable`，携带 CLI 详情时为 `wiki-cli-error`，否则为 `internal`）。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 web 组合中与 graph seam 及客户端 UI（[dsh-client-ui-wiki](../../client/ui-wiki/README.zh.md)）一起挂载本包。每个 Remote 方法与 `ctx.wikiGraph` 的一项能力一一对应：`wiki.listPages` / `wiki.getPage`（页面行与带反向链接的块树）、`wiki.listTags` / `wiki.listProperties`、`wiki.search`（文本搜索）、`wiki.query`（原始 Datalog 行）、`wiki.upsert` / `wiki.delete`（变更），以及 `wiki.server`（图/服务器生命周期状态）。值形状在此声明，因此浏览器端永远不依赖 logseq-graph 的线路类型。

-----

<a id="model-experience"></a>
## 模型体验

无——wiki 控制器是面向 GUI 客户端的 Host RPC 表面（面向模型的工具由 [dsh-tool-logseq](../../logseq/tool-logseq/README.zh.md) 包拥有）。

#### KV Cache 影响

无直接影响；wiki RPC 流量不会改变模型请求。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 搜索与查询只覆盖已挂载的图；跨图联合不在范围内。
- 失败分为三类记录在案的类别；CLI stderr 详情以文本形式呈现而非结构化。

<a id="dev-note"></a>

### 开发备注

控制器扩展 `TypertRemoteService`，命名空间为 `wiki`（参见 Typert 协议）。其声明的请求/值类型即 Cordis 目录策略中点名的投影契约。
