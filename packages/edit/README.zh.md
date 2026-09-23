---
description: "edit 包组：Hashline 以行锚定的补丁语言与面向模型的富 edit 工具，供选择或接线编辑器能力家族的部署方参考。"
kind: "package-group"
---
# edit/ - 富编辑器能力家族

[English](README.md) | 中文

一种紧凑的、以行锚定的补丁语言，以及基于文件系统 seam 的、面向模型的富 `edit` 工具。移植自 @oh-my-pi coding-agent 工具套件。全部为**产品**包。

## 概述

edit 包组为部署提供富编辑器能力家族：一种紧凑的以行锚定补丁语言，以及基于文件系统 seam 的面向模型的 `edit` 工具，二者移植自 @oh-my-pi coding-agent 工具套件。本组全部为**产品**包。`hashline/` 是以行锚定补丁背后的纯计算库；`tool-edit/` 拥有面向模型的工具（replace／patch／apply_patch／hashline 模式）与可选的 LSP 写入时格式化。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

`edit` 名称由部署决定：将 `tool-edit` 与 `tool-fs` 一起挂载，并禁用 `tool-fs` 的 `edit` 注册（`enableEdit: false`），使富编辑器拥有该名称。写入经 `ctx.fs` 并遵循观察与沙盒策略，与普通编辑完全一致。

| 包 | 角色 | ctx 键 |
|---|---|---|
| `hashline/` | Hashline：紧凑的以行锚定补丁语言与应用器（纯计算库） | （无） |
| `tool-edit/` | 面向模型的 `edit` 工具（replace／patch／apply_patch／hashline 模式），基于 `ctx.fs`，可选 LSP 写入时格式化与诊断 | （注册到 `ctx.tools`） |

`edit` 名称由部署决定：将 `tool-edit` 与 `tool-fs` 一起挂载，并禁用 `tool-fs` 的 `edit` 注册（`enableEdit: false`），使富编辑器拥有该名称。写入经 `ctx.fs` 并遵循观察与沙盒策略，与普通编辑完全一致。

<a id="related-documentation"></a>
## 相关文档

- [文件系统子系统](../../docs/subsystems/filesystem.zh.md) — 编辑器 seen-line 检查所依赖的读取／搜索／快照语义。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
