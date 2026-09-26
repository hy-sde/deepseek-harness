# Agent Graph

English | [中文](graph.zh.md)

The agent-graph subsystem — a durable schedule authority for supervised fan-out runs, ported from Apache Maka's `agent_graph` runtime — lets one root session declare, supervise, and reconcile a graph of child operators that run in isolated worktrees through the harness's own subagent + git-worktree machinery. It is a multi-package capability: the graph control store ([dsh-graph-control](../../packages/graph/graph-control), `GraphControlStore`, a KvUnit over the storage hub), the stream derivations ([dsh-graph-stream](../../packages/graph/graph-stream): reconciliation phases A–E, handoffs, readiness, the `AgentGraphCoordinator`), the child executor ([dsh-graph-executor](../../packages/graph/graph-executor), the `AgentGraphExecutor` seam over subagent runs + worktree leases), the supervisor tools ([dsh-tool-graph](../../packages/graph/tool-graph): `view_agent_graph`, `update_agent_graph`, `yield_agent_graph`), wake delivery ([dsh-graph-wakes](../../packages/graph/graph-wakes)), and the client projection ([dsh-graph-projection](../../packages/graph/graph-projection), the `graph` session-projection unit). Design authority: the upstream Maka `agent_graph` runtime (the port tracker is an out-of-repo working doc); in-repo contracts are each slice's README.

Source: [`packages/graph/graph-stream/src/coordinator.ts`](../../packages/graph/graph-stream/src/coordinator.ts)

## The unit of work

A `AgentGraphScheduledWork` declares one operator ("child agent") bound to an operator id, a text instruction, and the ids of its inputs (records produced by other operators or raw session records); `replaces` edges turn sequential steps into chains while every work item stays addressable by its deterministic `workId`. The schedule update is the ONLY write surface: `commitScheduleUpdate` appends to the schedule log; each update carries a `source` triple (sessionId + runId + toolCallId) and is idempotent under retry, so a re-sent update returns the already-committed `revision` instead of double-applying.

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

## Reconciliation

The coordinator drives five phases — provision (A), supervisor intents (B), select (C), render (D), execute (E) — under one invariant: work is claimed exactly once per scheduled revision (claim-before-run, revision CAS), and every graph id, run id, and record id is a deterministic `sha256:` prefix so retries cannot fork. Reconciliation returns one of `reconciled | waiting | limit_reached | failed | cancelled | stale`; deferred work is recorded with its kind (`input_not_committed`, `graph_closed`, `activation_limit`, `operator_provision_unavailable`, …), and a deferred item is never failed. `maxNewActivations` caps per-drive new claims; the host sizes it against its llm-slots capacity. Quiescence is not closure: `finish` closes admission, but already-claimed work still dispatches.

## Execution and wakes

`AgentGraphExecutor` is the seam every host implements: `provisionOperator` returns the durable provision row — or `undefined` to defer — while `runClaimedAgentGraphIntent` executes one claimed intent and `stopSession` cancels it. The shipped executor maps provision to a deterministic worktree lease (`graph_operator_lease_<hash>`), persists the binding in the control store, serializes one activation per operator, and settles into a terminal record (`recordSink`). Wakes are the host's interrupt: `yield_agent_graph` parks the supervisor at the next idle point of the root session; the wake runtime delivers at most 3 attempts (`pending → running → delivered | waiting_permission | retryable_failed | superseded`) and never mid-turn. On context overflow the runtime compacts once and allows one bounded partial delivery. Every state change the client can see is published as a `graph/change` event on the root session log; the `graph` projection unit folds it into the standing snapshot.

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

## Configuration

`maxNewActivations` (graph-stream), `concurrencyHint` (graph-executor), wake `maxAttempts`/backoff (graph-wakes) and the tool bounds (≤32 work items, ≤64 inputs each, ≤60k instruction chars) are set through each package's plugin `config:` block — the verbatim declarations live in the [plugin config catalog](../config-catalog.md) once the packages are catalogued; the model-facing tools are in the [tool catalog](../tool-catalog.md). Related capability seams: [session projections](session-projection.md) (the `graph` unit), the schedule delivery pattern mirrored by `graph-wakes`, and the orchestration policy that sizes fan-out.
