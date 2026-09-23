---
description: "内部 URL scheme handler，把 harness 会话历史以文件形态暴露给移植的 read 与 grep 工具：目录列表、渲染后的对话记录、单事件 JSON 与基于 FTS 的跨会话搜索。"
kind: "package-reference"
---

# dsh-session-url

[English](README.md) | 中文

## 概述

`dsh-session-url` 注册 `session://` 内部 URL scheme，把 harness 自身的会话历史以文件形态暴露给移植的 `read` 与 `grep` 工具：目录列表、渲染后的对话记录、精确的单事件 JSON，以及基于 FTS 的跨会话搜索。当代理需要用它已熟悉的文件形态工具检查或检索过往会话时选择它。它不新增工具代码：`read` 与 `grep` 经 `ctx.internalUrls` 路由任何已注册 scheme，handler 读取的语料与 session-query 工具相同、live 优先。其边界是只读历史：资源不可变，内容搜索被禁用时 `session://search` 降级。

## 目录

- [URL 形态](#url-surface)
- [行为说明](#behavioral-notes)
- [挂载](#mounting)
- [包结构](#package-layout)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

`session://` — 一个内部 URL scheme，把 harness 自身的会话历史以**文件**形态暴露给移植过来的 `read` / `grep` 工具。

该 handler 注册进共享的内部 URL 注册表（`ctx.internalUrls`），读取与session-query 工具相同的、live 优先的逻辑语料（`ctx.sessionQuery`）。无需改动任何工具代码：`read` 与 `grep` 本来就会把所有已注册 scheme 通过`ctx.internalUrls` 路由。

<a id="url-surface"></a>
## URL 形态

| URL | 结果 |
| --- | --- |
| `session://*`（或 `session://list`） | 已知会话的目录列表（新的在前）。 |
| `session://<id>` | 渲染后的对话记录——每个事件 `seq \| type \| time` 加缩进的语义文本。 |
| `session://<id>/event` | 该会话事件 seq 的目录索引。 |
| `session://<id>/event/<seq>` | 单个事件的精确 JSON。 |
| `session://search?q=<terms>`（或 `session://search/<terms>`） | 基于 FTS 的跨会话命中（内容搜索被禁用时降级）。 |

示例：

```
read session://0a1b2c3d4e
grep tsconfig session://0a1b2c3d4e
read session://0a1b2c3d4e/event/42
list session://*
```

<a id="behavioral-notes"></a>
## 行为说明

- **不可变：** 每个资源都是只读历史——代理永远不能通过文件形态的 URL 改写日志。
- **有界：** 对话记录展示上限 600 个事件（`read`），搜索消费方（`grep` 经 `pathOnly`）上限 12 000；列表上限 200 个会话；单个事件 JSON 上限 128 KiB（超大的事件降级为一段文本提示）。每个上限都是模块导出常量。
- **搜索降级：** 禁用内容搜索（`openAt: 'never'`）的部署会让 `session://search` 返回一段说明；精确读取（`session://<id>`、`/event`）从不依赖索引。
- **安全：** 会话 id 是未经验证的品牌化字符串，只用作 URL host；绝不当作文件系统路径段使用，该 handler 不做任何文件系统访问。

<a id="mounting"></a>
## 挂载

与它所扩展的注册表同在 host 平面（base bundle），且置于`@deepseek-ai/dsh-internal-urls` **之后**：

```yaml
- id: session-url
  name: '@deepseek-ai/dsh-session-url'
```

需要 `ctx.internalUrls` 与 `ctx.sessionQuery`；任缺一个就在 apply 时响亮报错，所以挂载该行的装配必须同时拥有这两个服务。

<a id="package-layout"></a>
## 包结构

- `src/handler.ts` — `SessionProtocolHandler`（该 scheme 的 resolve/complete）。
- `src/index.ts` — 插件 `apply`，把 handler 注册进注册表。
- `tests/handler.spec.ts` — handler 与路由器集成测试。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- `session://search` 需要启用内容搜索的 session-query 引擎（FTS）。禁用内容搜索（`openAt: 'never'`）的部署收到一段说明性降级，而非跨会话命中——精确读取（`session://<id>`、`/event`）从不依赖索引。
- 对话记录渲染语义事件投影（`extractSessionEventText`）；原始逐事件负载只能经 `/event/<seq>` JSON 读取，且一次一个事件。
- 会话标题是最佳努力：标题服务捕获到时才显示，否则缺席。
- handler 需要 `ctx.internalUrls` 与 `ctx.sessionQuery` 已挂载；apply 时缺失就响亮报错，绝不半服务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
