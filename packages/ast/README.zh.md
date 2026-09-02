---
description: "ast/ 包组：基于内置 ast-grep 原生二进制的语法感知结构化搜索与重写，供选择或浏览该能力家族的读者使用。"
kind: "package-group"
---

# ast/ - 结构化代码能力家族

[English](README.md) | 中文

## 概述

`ast/` 组提供 [`tool-ast/`](tool-ast/README.zh.md)。与富编辑器（`edit/`）和语言服务器能力（`lsp/`）并置，它补齐了模型驱动代码工作的“文本 → AST → 语义”阶梯：`ast_grep` 通过带元变量的树模式寻找节点（`$NAME` 绑定一个节点、`$_` 匹配任意单一节点、`$$$NAME` 捕获零个或多个节点），`ast_edit` 在预览变更块后把每个匹配重写为模板。全部为**产品**包，移植自 @oh-my-pi coding-agent 工具套件。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx 键 |
|---|---|---|
| `tool-ast/` | 面向模型的 `ast_grep`（结构化搜索）与 `ast_edit`（预览／应用结构化重写）工具，基于经 `ctx.subprocess` 启动的打包 `@ast-grep/cli` 二进制 | （注册到 `ctx.tools`） |

`ast_grep` 通过带元变量的树模式寻找节点；`ast_edit` 将匹配重写为模板，并总是先预览，再以 `apply: true` 经 `ctx.fs` 写入（观察＋版本校验＋沙盒策略）。设计上与富编辑器（`edit/`）和语言服务器能力（`lsp/`）并置：文本形状 → ast 结构化能力 → 语义导航。

<a id="related-documentation"></a>
## 相关文档

- [结构化 AST 搜索与重写 Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-structural-ast-search-and-rewrite-tools.zh.md) — 设计依据，包括为何重写经文件系统 seam 而非 `-U` 就地更新，以及退出码如何映射到稳定的 `AST_*` 词汇。
