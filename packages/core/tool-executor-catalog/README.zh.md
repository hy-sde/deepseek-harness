---
description: "目录呈现：设备工具不进入提示词，仅通过 dyn 桥接可达。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-executor-catalog

[English](README.md) | 中文

## 概述

目录工具执行器将本 fork 的设备目录模式挂载为 `ToolExecutor` 插件：设备工具的完整 schema 不进入提示词，只能通过保留的 `dyn` 桥接工具触达。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在需要目录呈现的地方挂载该执行器，并在旁边挂载本 fork 的 `dyn` 桥接。最近作用域的执行器决定工具行为；同一作用域只允许一个执行器。

```yaml
- name: '@deepseek-ai/dsh-tool-executor-catalog'
```

设备工具声明 `device: true`；执行器拒绝对它们的直接调用，并通过 `dyn` 的 `search` / `docs` / `invoke` 提供服务。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

该执行器包装一个 `ToolExecutionPipeline`，其 source 只放行 `dyn` 桥接，并以 `ToolNotFoundError` 拒绝对设备工具的直接调用。它的提示词 section 按 `CATALOG_ONLY` 顺序配合本 fork 的目录指引列出已挂载设备；`dyn` 调用会作为目标设备工具的嵌套执行分派进 pipeline。

- [`src/index.ts`](src/index.ts) — 目录执行器注册、桥接 transport 接线、设备列表。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具注册表](../tools/README.zh.md)
- [原生执行器](../tool-executor-native/README.zh.md)
- [PTC 执行器](../tool-executor-ptc/README.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

### 目录呈现（catalog presentation）

#### 模型看到什么

一个 `dyn` 桥接工具加上目录指引 section；设备 schema 只在需要时通过 `dyn` `docs` 提供。

#### Token 效应

请求成本由桥接 schema 与目录列表决定，而不是各设备 schema 之和；新挂载一个设备只增加一行列表，而不是它的 JSON Schema。

#### KV Cache 效应

已挂载设备集合稳定时缓存稳定；挂载或卸载设备只重写目录列表行，不重写桥接 schema。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些约束适用于目录部署。

- 执行器要求通过 `createDynTool`（本 fork 的 `catalog.ts` 桥接）挂载 `dyn` transport；没有该桥接的目录部署会让 `dyn` 调用失败，而不是降级为直接执行。
- 设备发现与 docs 渲染反映本 fork 的目录摘要格式；upstream stock harness 没有目录执行器，上游的 executor 形态变更需要手工重新移植。
- 嵌套的 `dyn` 调用复用父执行的 call identity 并加 `:catalog:` 后缀；假设 call id 全局唯一的追踪工具可能渲染异常。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

Fork 独有包：upstream stock harness 没有目录执行器。

</details>
