---
description: "一种紧凑、以行为锚定的补丁语言与应用器，文件系统 I/O 可插拔，移植自 @oh-my-pi/hashline。"
kind: "package-reference"
---

# @deepseek-ai/dsh-hashline

[English](README.md) | 中文

## 概述

`dsh-hashline` 实现紧凑、以行为锚定的 hashline 补丁语言：把补丁解析为多个 section，并通过可插拔的 `Filesystem`（磁盘、内存或任何自定义后端）在快照／恢复支持下应用。当面向模型的工具需要该以行为锚定的编辑协议、且其指引由 `dsh-tool-edit` 注册时选择它。它是 MIT 许可原版的 1:1 算法移植，原生 tree-sitter 探测被 stub，`diffLineRuns`／xxHash 以纯 JS 重实现，因此语法探测优雅降级。主要边界：补丁必须锚定于先前的读取快照，且逐行哈希开销随文件大小增长。

## 目录

- [许可证](#license)
- [移植差异](#port-differences)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

Hashline：一种紧凑、以行为锚定的补丁语言与应用器，移植自[@oh-my-pi/hashline](https://github.com/can1357/oh-my-pi/tree/main/packages/edit/hashline)。

原包的描述仍然适用：

> Hashline：一种紧凑、以行为锚定的补丁语言与应用器。FS/IO 可插拔，因此可以运行在磁盘、内存或任何自定义后端之上。

<a id="license"></a>
## 许可证

MIT 许可代码的移植。原始版权：`Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük`。派生文件带有头部署名；请参见各文件的头部注释。

<a id="port-differences"></a>
## 移植差异

- - 原生 tree-sitter（`enclosingBlockBoundaries` / 解析探测）被 stub：`syntax.ts` 返回 `[]` / `false`，即文档所述的优雅降级路径。
- - `diffLineRuns` 与 xxHash 工具以纯 JS 重新实现（`src/line-diff.ts`、`src/hash.ts`），语义与原生实现一致。
- 小型 LRU 缓存以内联方式重新实现（`src/lru.ts`）。

除此之外，该移植与原源代码在算法上保持 1:1 一致。

包 API：

```ts
import { Patch, Patcher, applyEdits, InMemoryFilesystem } from '@deepseek-ai/dsh-hashline'
```

- `Patch.parse(input, { cwd })` — 把 hashline 补丁解析为多个 section。
- `Patcher` — 应用带快照／恢复支持的 section。
- `Filesystem` — 可插拔的文件 IO（自行实现 `writeText`/`readText`/… 以接入 harness）。
- 完整导出面请参见 `src/index.ts`。

<a id="model-experience"></a>
## 模型体验

### 编辑协议指引

#### 模型看到的内容

`hashline` 定义基于行锚点的 hashline 编辑协议；模型消费的读/写/编辑指引由 `dsh-tool-edit` 注册；其协议说明见工具目录中的 `dsh-tool-edit` 条目。

#### Token 影响

自身无每次请求的 Schema；其提供给编辑工具的指引增加一小段固定文本。

#### KV Cache 影响

指引段落为请求前缀文本；补丁不变时可复用前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- hashline 补丁需要先读取快照；非行锚定的 AI 生成内容会回退到字面或 patch 模式。
- 超大文件需要权衡逐行哈希开销。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
