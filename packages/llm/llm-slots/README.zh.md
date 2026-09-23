---
description: "主机级模型槽位准入控制（ctx.modelSlots）：为在单个本地推理端点后运行多个并发模型的部署提供每次模型调用的显式预算。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-slots

[English](README.md) | 中文

## 概述

`ctx.modelSlots` 为部署提供跨越每次模型调用的主机级槽位预算，在每条模型背书调用都会跨越的 `llm/stream` 水瀑布处按 FIFO 决定：主智能体循环、子智能体、worker 子节点、workflow 与标题/压缩旁路请求。当多个并发提供方共享一个本地推理端点、调用方会同时堆叠突发时选用本包；容量默认 3，可在运行时调整。每个逻辑调用在其整个生命周期内持有一个槽位；可取消的等待永远不会收到已释放的槽位。该闸门不读取 LLM 服务状态、不提供面向模型的工具，因此极易测试且可在任何地方安全挂载。

## 目录

- [工作原理](#how-it-works)
- [组合](#composition)
- [服务面](#service-surface)
- [开发](#development)
- [Model Experience](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

DeepSeek Harness 的主机级模型槽位准入控制（`ctx.modelSlots`）。当部署在单个本地推理端点后面使用少量并发模型（通常 2–3 个槽位，每个约 1M 上下文）时，需要为每次模型调用设定明确的预算——否则主智能体的回合、运行中的子智能体以及 workflow 的扇出会同时堆叠数十次请求，导致每次调用都慢到排队延迟。

<a id="how-it-works"></a>
## 工作原理

- **单一咽喉点。** 准入控制在 `llm/stream` 水瀑布处按 FIFO 决定——这是每个模型调用都会跨越的唯一边界（主智能体循环、进程内子智能体、worker 线程子节点、workflow、标题/压缩旁路请求），无论由哪个会话或上下文发起。
- **主机级预算。** 闩锁位于模块作用域，因此每个派生上下文与插件实例共享同一个池。容量在 `llm-slots` 行上配置（默认 3），并可在运行时调整：`ctx.modelSlots.setCapacity(n)`。
- **可取消的等待。** 等待槽位的调用会观察其 AbortSignal；排队期间被取消会以 AbortError 的形式暴露，且永远不会收到释放的槽位。
- **每个逻辑调用一个槽位。** 调用在其整个生命周期内持有槽位，包括适配器重试，这也阻止了故障端点扇出无界重试风暴。

<a id="composition"></a>
## 组合

`dsh-base` 包以中性默认值提供该行：

```yaml
- id: llm-slots
  name: '@deepseek-ai/dsh-llm-slots'
  config:
    enabled: true
    capacity: 3
```

<a id="service-surface"></a>
## 服务面

`ctx.modelSlots` 暴露：

- `stats()` — `{ enabled, capacity, running, waiting, acquiredTotal }`。
- `setEnabled(boolean)` — 在不动容量的情况下切换准入。
- `setCapacity(number)` — 修改预算；缩容在调用排空时生效。

<a id="development"></a>
## 开发

```sh
pnpm exec tsc -b packages/llm/llm-slots/tsconfig.json
pnpm exec vitest run packages/llm/llm-slots
```

这里不提供面向模型的工具；该包刻意不读取任何 LLM 服务状态（只监听共享事件总线），因此易于测试，并且可以在任何上下文中安全挂载。

<a id="model-experience"></a>
## Model Experience

无，该服务不添加任何面向模型的文本、schema 或消息；它只在共享的 `llm/stream` 总线上串行化对主机级槽位预算的访问。

#### KV Cache 影响

透传；闸门只延迟已准入调用的首个分块并持有一个主机级计数器，因此无论是否加载该插件，面向模型的请求与响应流都保持逐字节一致。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 槽位在组合加载时解析一次；不支持槽位内容热更新。
- 未知槽位在挂载时报错而非忽略，因此提供方插件需保持槽位名同步。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
