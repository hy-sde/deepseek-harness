# Agent Graph（智能体图）

[English](graph.md) | 中文

agent-graph 子系统——面向受监督 fan-out 运行的持久化调度权威，移植自 Apache Maka 的 `agent_graph` 运行时——让一个根会话可以声明、监督并调和一组在隔离 worktree 中运行的子算子，且通过本 harness 自身的 subagent + git-worktree 机制完成。它是一个多包能力：图控制存储（[dsh-graph-control](../../packages/graph/graph-control)，`GraphControlStore`，存储 hub 之上的 KvUnit）、流推导（[dsh-graph-stream](../../packages/graph/graph-stream)：调和阶段 A–E、handoff、就绪度、`AgentGraphCoordinator`）、子执行器（[dsh-graph-executor](../../packages/graph/graph-executor)，基于 subagent 运行与 worktree 租约的 `AgentGraphExecutor` seam）、监管工具（[dsh-tool-graph](../../packages/graph/tool-graph)：`view_agent_graph`、`update_agent_graph`、`yield_agent_graph`）、唤醒投递（[dsh-graph-wakes](../../packages/graph/graph-wakes)）与客户端投影（[dsh-graph-projection](../../packages/graph/graph-projection)，`graph` 会话投影单元）。设计权威：上游 Maka `agent_graph` 运行时（移植跟踪文档在仓库之外）；仓内契约以各切片的 README 为准。

源码：[`packages/graph/graph-stream/src/coordinator.ts`](../../packages/graph/graph-stream/src/coordinator.ts)

## 工作单元

一个 `AgentGraphScheduledWork` 声明一个算子（「子智能体」）：绑定到一个算子 id、一段文本指令，以及其输入的 id（其他算子产生的记录或原始会话记录）；`replaces` 边把顺序步骤变成链，同时每个工作项保持由其确定性 `workId` 可寻址。调度更新是唯一写入面：`commitScheduleUpdate` 向调度日志追加；每次更新携带 `source` 三元组（sessionId + runId + toolCallId）并在重试下幂等，因此重发更新返回已提交的 `revision` 而非重复应用。

```ts ignore-check
/** One schedule update: add/supervise/stop/finish in a single commit. */
interface AgentGraphScheduleUpdateRequest {
  graphId: string
  source: { sessionId: string; runId: string; toolCallId: string }
  addWork?: readonly AgentGraphScheduledWork[]
  stop?: readonly string[]
  finish?: boolean
}
```

## 调和

协调器驱动五个阶段——provision（A）、supervisor intents（B）、select（C）、render（D）、execute（E）——并遵守一条不变量：每个调度修正在每个调度版本下恰好被 claim 一次（claim-before-run、revision CAS），且每个图 id、run id、记录 id 都是确定性 `sha256:` 前缀，重试不会分叉。调和的返回值为 `reconciled | waiting | limit_reached | failed | cancelled | stale` 之一；被延迟的工作记录其类型（`input_not_committed`、`graph_closed`、`activation_limit`、`operator_provision_unavailable` 等），延迟项绝不判失败。`maxNewActivations` 限定单次驱动的新的 claim 数量；宿主以其 llm-slots 容量为基准定值。静止（quiescence）不等于关闭：`finish` 关闭准入，但已 claim 的工作仍会调度。

## 执行与唤醒

`AgentGraphExecutor` 是每个宿主实现的 seam：`provisionOperator` 返回持久化 provision 行——或返回 `undefined` 以延迟——而 `runClaimedAgentGraphIntent` 执行一个已 claim 的 intent，`stopSession` 取消它。随附执行器把 provision 映射为确定性 worktree 租约（`graph_operator_lease_<hash>`），在控制存储中持久化绑定，按算子串行化激活，并以终结记录收尾（`recordSink`）。唤醒是宿主的打断：`yield_agent_graph` 把监管者停驻在根会话的下一个空闲点；唤醒运行时最多投递 3 次（`pending → running → delivered | waiting_permission | retryable_failed | superseded`），绝不在回合中途投递。上下文溢出时，运行时压缩一次并允许一次有界部分投递。客户端可见的每次状态变化都以 `graph/change` 事件发布到根会话日志；`graph` 投影单元把它折叠为常驻快照。

```ts ignore-check
/** The client-visible graph snapshot, published whole. */
interface SessionGraphProjection {
  schemaVersion: 1
  graphId: string
  status: 'active' | 'closed'
  revision: number
  closed: boolean
  work: readonly { workId: string; status: string; instruction: string; inputCount: number }[]
  omitted: { work: number; records: number; inputs: number }
  pendingWake: boolean
  updatedAt: number
}
```

## 配置

`maxNewActivations`（graph-stream）、`concurrencyHint`（graph-executor）、唤醒 `maxAttempts`/退避（graph-wakes）与工具边界（≤32 个工作项、每项 ≤64 个输入、≤60k 指令字符）通过各包插件的 `config:` 块设置——原始声明见[插件配置目录](../config-catalog.zh.md)（这些包入目后）；面向模型工具见[工具目录](../tool-catalog.zh.md)。相关能力 seam：[会话投影](session-projection.zh.md)（`graph` 单元）、由 `graph-wakes` 镜像的调度投递模式，以及为 fan-out 定容的编排策略。
