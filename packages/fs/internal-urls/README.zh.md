---
description: "本 harness 内部引用（冲突、issue-PR 链接、工作区路径）的语法与解析器，供读取/搜索工具使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-internal-urls

[English](README.md) | 中文

## 概述

`dsh-fs-internal-urls` 定义本 harness 用于内部引用的语法，并针对当前打开的工作区解析它们：`conflict://` 跨度、`pr://owner/repo/…` issue 与拉取请求链接，以及 read/grep 工具使用的 URL 形式。它是词法级解析器——负责规范化并打开被引用的资源，但不做内容决策；这些引用的所有模型可见效果由 read/grep 工具承担。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当宿主应接受模型对 `read`、`write`、`search` 调用中出现的本 harness 内部引用时加载本插件。每个已注册 scheme 将引用字符串解析为解析后的文件跨度或外部文档。

### 已注册 scheme

| Scheme | 解析为 |
|---|---|
| `conflict://<source>/<line>` | 工作树中的冲突跨度，带来源归属。 |
| `pr://owner/repo/<kind>/<num>` | 当前仓库的 GitHub 拉取请求或 issue 文档。 |
| `fs://…` | 针对当前工作目录规范化后的工作区或宿主路径。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

解析纯粹是词法级的：插件匹配 scheme、规范化路径，并把解析后的引用交给消费工具。它不接触网络凭据或宿主机密；上游文档获取由拥有该 scheme 的工具委托完成。

-----

<a id="further-exploration"></a>
## 进一步探索

- [读取与搜索](../../fs/tool-fs/README.zh.md) — 消费这些解析后引用的工具。
- [Git 历史](../../git/git/README.zh.md) — `conflict://` 跨度背后的工作树来源。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 解析为词法级；符号链接与非 UTF-8 路径可能使解析结果与实际文件不一致。
- 语法针对本 harness 自身的引用调整；第三方 URL 约定需新增模式。

**运行时不变量：** 未发布 companion。本包没有同一进程内可观测的持续运行时关系；其行为由包的测试套件保障。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
