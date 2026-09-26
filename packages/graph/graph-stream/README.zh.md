---
description: "Agent Graph 的派生流层：确定性标识、记录/轨迹/就绪/调度投影、交接文本，以及进程内协调驱动器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-graph-stream

[English](README.md) | 中文

## 概述

`dsh-graph-stream` 是 Agent Graph 的派生层。它从控制存储的已提交行重算一切可派生内容——工作状态投影、记录折叠、轨迹与路由派生、就绪意图、有界输入交接——并驱动单飞式协调循环（`AgentGraphCoordinator`），对该存储执行预置、监督、选择、渲染与执行。所有标识为确定性 sha256 并截取前 32 个十六进制字符，因此重放在构造上即幂等、每个投影都是纯函数。本包不添加任何工具、提示词或插件行；由执行器适配器与主管工具消费。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

```ts ignore-check
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { GraphControlStore } from '@deepseek-ai/dsh-graph-control'
import { AgentGraphCoordinator } from '@deepseek-ai/dsh-graph-stream'

const backend = await ctx[storageBackendServiceKey('sqlite')]
const unit = await backend.kv.open(GraphControlStore.descriptor)
const store = await GraphControlStore.open(unit)

const coordinator = new AgentGraphCoordinator(graphId, {
  store,
  executor: { provisionOperator, runClaimedAgentGraphIntent, stopSession },
  recordSource,
  newId,
})

await coordinator.scheduleUpdate({ graphId, addWork: [work] }) // commits, then wakes the drive
const result = await coordinator.reconcileAndWait()             // runs one drive to idle
```

<a id="understand-the-implementation"></a>
## 理解实现

### 确定性标识与排序

`stableHash(value)` = `sha256:` + 规范化 JSON 的十六进制（对象键排序、`undefined`/函数/符号 → `"[undefined]"`、bigint → 数字字符串、`required`/`enum` 数组以 `localeCompare` 排序、Date → ISO）。所有标识取前 32 个十六进制字符。`compareAgentGraphIdentity` 使用 UTF-16 码元顺序——跨进程稳定，与 `localeCompare` 不同。

### 投影

- **调度投影**（`projectAgentGraphSchedule`）：把追加式更新日志折叠为模型可见的工作视图；校验修订号从 1 连续、finish 之后无更新、不重复 work id、图 id 不匹配即拒绝。`stopped` 优先于 `superseded`。
- **记录折叠**（`readCommittedAgentGraphProjection`）：按（操作员，会话）从已提交事件派生只引用记录；跳过 partial；每个激活至多一个 terminal；顺序确定。
- **轨迹**（`validateAgentGraphTraceTopology`、`buildAgentGraphTraceSnapshot`）：校验 DAG（重复 id/端点、自环、未知操作员、Kahn 判环），并为每条（记录 × 出边）派生一条路由。
- **就绪**（`buildAgentGraphReadinessSnapshot`）：map 策略——每条经声明的入边到达的路由产生一个意图，恰好密封触发它的记录（`policyFingerprint`、`readinessContextFingerprint`、稳定哈希生成 `graph_intent_…`）。
- **交接**（`hydrateAgentGraphInputHandoffs`、`renderAgentGraphScheduledWorkPrompt`）：解析有界结论文本（每条记录 16 KiB、总计 48 KiB，`…` 省略号，按码点二分），渲染操作员提示词：指令 + `GRAPH_OPERATOR_HANDOFF_PROTOCOL` + `<agent_graph_input_handoffs>`，`<` 转义为 `\u003c`。记录保持只引用；文本仅在渲染时解析。

### 协调与协调器

`reconcileAgentGraphSchedule` 执行 Maka 的各阶段：A 预置操作员 → B 派生主管意图 → C 选择（现有声明总会派发；新意图受 `maxNewActivations` 上限，超出 → `activation_limit`）→ D 渲染（全有或全无）→ E 执行（按修订号声明 → 运行时用 `admitExecution` 即按修订号开始执行）。状态：`reconciled | waiting | limit_reached | failed | cancelled | stale`。`applyScheduleStops` 执行替换（`status: 'superseded'`）、取消声明并按会话批量停止。

`AgentGraphCoordinator` 是进程内单飞驱动器：`scheduleUpdate` 提交一行后唤醒驱动器；`reconcileAndWait` 加入恰好一轮；`recover` 在重启后恢复非空调度的图；`stop`/`wake`/`isClosed` 暴露相同生命周期。只要还有工作或停止目标，一轮驱动就会再次运行；已有声明会被观察为已派发（执行器按声明 id 去重）。

### 执行器接缝

```ts ignore-check
export interface AgentGraphExecutor {
  provisionOperator(request: AgentGraphOperatorProvisionRequest): Promise<AgentGraphOperatorProvisionResult | undefined>
  runClaimedAgentGraphIntent(input: AgentGraphRunClaimedIntentInput): Promise<void>
  stopSession(sessionId: string, opts?: { reason?: string }): Promise<void>
}
```

协调器从不直接调用提供方——P3 提供基于子代理与工作树的实现。

<a id="further-exploration"></a>
## 运行时不变式

未发布运行时不变式伴生包：graph-stream 将图行投影为流安全增量，graph-control 已在写边界验证。

## 进一步探索

- `packages/graph/graph-control`（P1）：本层折叠的持久化行。
- `src/reconcile.ts` / `src/coordinator.ts`：驱动循环与状态推导。
- `src/hash.ts` / `src/identity.ts`：所有标识与指纹依赖的规范化与排序原语。
- `tests/graph-stream.spec.ts` / `tests/reconcile.spec.ts`：针对真实 sqlite 存储的投影、校验、交接与端到端驱动场景。

<a id="model-experience"></a>
## 模型体验

### 调度工作交接提示词

#### 模型看到什么

本包渲染操作员子运行收到的交接提示词：工作指令、`GRAPH_OPERATOR_HANDOFF_PROTOCOL` 与 `<` 转义为 `\u003c` 的 `<agent_graph_input_handoffs>` 块。有界结论文本只在渲染时解析。投影本身保持只引用；模型看到的是渲染后的提示词文本与 P4 主管工具呈现的折叠记录，从不看到原始记录或路由行。

#### Token 影响

交接提示词在此组装，因此其大小属于操作员的上下文预算：每条记录 16 KiB、总计 48 KiB，按码点二分命中上限时以 `…` 省略号截断。

#### KV Cache 影响

无——本包从不自行调用提供者；缓存上下文由子运行自己的会话构建。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 就绪策略种类：仅 `map`——`all_settled` 与主管就绪种类推迟到 P4。
- 尚无客户端投影/检查点（`onCheckpoint`）；无工具视图分页；驻留为空操作。
- map 策略意图只派生、不由 reconcile 自动派发——它们留给 P4 的主管工具。
- 记录形态为带来源的副本（精简），是有意偏离 Maka 的 18 面完整记录；流层绝不修改已存记录。
- 协调器为进程本地：另一进程持有同一图存储不会自动唤醒本驱动器（唤醒投递为 P5）。

<a id="dev-note"></a>
### 开发备注

<details><summary>维护者的工作上下文——点击展开</summary>无。</details>
