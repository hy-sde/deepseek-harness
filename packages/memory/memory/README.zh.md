---
description: "宿主 ctx.memory 服务及其后端注册表：由代理自行策展的、按项目隔离的耐久记忆，在下一会话开始时经提示注入重新载入。"
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

[English](README.md) | 中文

## 概述

`dsh-memory` 提供宿主平面的 `ctx.memory` 服务及其后端注册表：由代理通过 `retain`/`recall`/`reflect`/`memory_edit`/`learn` 自行策展的、按项目隔离的持久记忆，并在下一会话开始时经提示注入重新载入。当部署需要跨会话回答"我们之前决定/偏好/学到了什么"时选择它——它与会话查询和压缩互补，后者回放历史而不是记忆。仅内置 `local` 后端；代价是每个项目一个记忆根（`<harness home>/memories`）与启发式去重，且存储按项目作用域，跨项目事实需显式导出/导入。

## 目录

- [布局](#layout)
- [服务 API](#service-api)
- [配置](#config)
- [测试](#tests)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

**面向代理的长期记忆**（DeepSeek Harness）——`ctx.memory` 服务与其后端注册表，移植自 [@oh-my-pi](https://github.com/oh-my-pi) 编程代理的记忆体系（见`port_omp.md` 第 4 项）。记忆是**按项目隔离**的持久化数据，由代理通过`retain`/`recall`/`reflect`/`memory_edit`/`learn` 工具自行策展（工具由`@deepseek-ai/dsh-tool-memory` 提供），并会在**下一会话开始时**通过提示注入重新载入。它与 DSH 的会话查询和压缩互补而非重叠：后者回放会话历史，而此记忆库回答跨会话的“我们之前决定/偏好/学到了什么？”。

仅内置 **`local`** 后端。注册表为后续 Hindsight/Mnemopi 式提供方保留了接缝——未来的提供方只需注册一个 `MemoryBackend`，同样的工具即可无缝使用。

<a id="layout"></a>
## 布局

服务位于宿主平面：存储是跨会话的持久化项目数据，因此挂载为`packages/bundle/base/cordis.patch.yml` 中的一行，按会话挂载的工具包解析它。数据存放于 `<harness home>/memories/<project>/`，其中 `<project>` 是编码后的绝对 cwd——每个项目一个记忆根，该项目的所有会话与工具共享。

每个项目根包含三个工件：

- - `bank.jsonl.zstd` — 由 `retain` 写入的可编辑工作条目（id、内容、上下文、来源、重要性、时间戳、活跃标志）。支撑 `memory_edit`。默认磁盘格式与会话日志相同的zstd 帧容器：每次保存批次是一帧带校验的帧，追加友好且可自愈。更名前的纯文本`bank.jsonl` 仍会被读取，并在首次写入时迁移；在 `LocalMemoryConfig` 中设置`compression: 'none'` 可恢复原逐行追加格式。
- - `learned.md` — 由 `learn` 写入的、新在前、去重、限容（100 条）的教训列表；与 omp 保持相同的格式和归一化。可经受整合；`learn` 写入会做注入中和与密钥脱敏。
- - `memory_summary.md` — 可选的整合摘要（手工或工具维护），`recall`、`reflect`与提示注入都会呈现它。

<a id="service-api"></a>
## 服务 API

```ts ignore-check
await ctx.plugin(DshMemory, { root: '~/.dsh/memories' })

const memory = ctx.memory                       // MemoryService
await memory.save({ cwd }, { content, context, source, importance })
await memory.learn({ cwd }, { content, context })
await memory.search({ cwd }, 'query', { limit: 10 })
await memory.edit({ cwd }, 'update' | 'forget' | 'invalidate', { id, content, importance, replacementId })
await memory.summaries({ cwd })                 // { summary?, learned?, block }
await memory.status({ cwd })
await memory.clear({ cwd })
```

后端注册进服务：`memory.register(backend)` 返回释放函数，`memory.resolve()`返回被选中（默认：首个注册）的后端。变更会发出 `memory/change`（`{ cwd }`），供进程内的消费方失效缓存。

`MemoryBackend` 是基于 `@deepseek-ai/dsh-memory/types` 的一打方法；内置的`LocalMemoryBackend` 纯 Node（`node:fs`）实现，并带有进程内按文件写链，因此来自并将会话的并发写入绝不会互相覆盖。

<a id="config"></a>
## 配置

所有键均可选。

| 键 | 默认 | 含义 |
|---|---|---|
| `root` | `<harness home>/memories` | 记忆根（`~`/`$HOME` 会展开）。 |
| `backend` | 首个注册 | 服务委托的后端 id。 |
| `defaultImportance` | `0.7` | 保存未提供重要性时的基线值。 |
| `searchLimit` | `10` | 单次搜索的默认结果上限。 |

条目级上限：银行内容 4000 字符、银行上下文 800、教训内容 2000、教训上下文400，教训按最新在前上限 100 条。所有存储文本在写入与读取时都会先做注入中和（控制字符、`<`/反引号、`~~~` 围栏），再脱敏。

<a id="tests"></a>
## 测试

```sh
pnpm vitest run packages/memory/memory
```

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 存储按项目作用域；跨项目事实需显式导出/导入。
- 记忆条目按启发式去重，近似重复的事实可能同时保留。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
