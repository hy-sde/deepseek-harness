---
description: "Operator executor adapter for the Agent Graph: deterministic worktree leases, durable operator bindings, and serialized child runs that settle into terminal records."
kind: "package-reference"
---

# @deepseek-ai/dsh-graph-executor

English | [中文](README.zh.md)

## Summary

`dsh-graph-executor` is the child-operator executor adapter of the Agent Graph. It acquires deterministic worktree leases, binds operators durably, and runs one child per activation, settling each into exactly one terminal record. Provisioning is idempotent so retries adopt the same lease key, and execution is serialized per operator with child summaries truncated to 16 KiB before emission. Mount it with a worktree pool, a child runner, and a record sink; the control store stays the durable authority. It contributes no tool, prompt, or plugin row — the graph coordinator and supervisor tools consume it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

```ts ignore-check
import { GraphControlStore } from '@deepseek-ai/dsh-graph-control'
import { AgentGraphCoordinator } from '@deepseek-ai/dsh-graph-stream'
import { createGraphOperatorExecutor } from '@deepseek-ai/dsh-graph-executor'

const executor = createGraphOperatorExecutor({
  store,
  pool: worktreePool,       // GraphOperatorWorktreePool over the git worktree engine
  childRunner: childRunner, // GraphOperatorChildRunner over the subagent runtime
  recordSink: recordSink,   // commits AgentGraphRecordSourceEvent rows
  newId,
})

const coordinator = new AgentGraphCoordinator(graphId, {
  store,
  executor,
  recordSource,
  newId,
  maxNewActivations: 4,
})
```

## Understand the implementation

### Provision: lease key, binding, and the durable row

`provisionKey(request)` hashes `{ graphId, workId, provisionFingerprint }` with `stableHash32`, so retries of the same provision reuse one lease key. `provisionOperator` then acquires the lease (or adopts it), persists `bindOperatorWorktree({ graphId, workId, provisionId, leaseId, path, repoRoot, boundAt })`, and finally commits the provision row through the store — the same revision-conditional, closure-blocked write the P1 store already owns. Acquire failure returns `undefined`; the binding row is never written without a lease. Re-binding the same provision with a different lease id is rejected (`binding-conflict`), so a provision owns exactly one worktree.

### Run: admission, serialization, and settlement

`runClaimedAgentGraphIntent` queues the activation on a per-operator promise chain, so one operator never runs two children at once. Inside the queue it first evaluates `admitExecution` (post-serialization revision gate) and aborts when it returns `cancelled`; then it resolves the operator's binding — through the `${graphId}:${workId}` index when the intent's readiness id names the provisioning work (dynamic operators), or through the provision's `operatorId` for operator-targeted work, which re-runs a provisioned operator — and starts the child with `{ sessionId, instructions, workspace: binding.path, runId, labels, abortSignal }`. `concurrencyHint` optionally caps concurrently running child starts across operators.

After the child settles, one `AgentGraphRecordSourceEvent` is built (`runtimeEventId` from `newId`, `seq` 1, the claim's `targetRunId`, truncated summary) and handed to `recordSink`; the folded `AgentGraphRecord` is also returned. `recordSink` failure propagates — the terminal record is the commit point that stops the reconciler from re-dispatching the same claim.

### Bindings in the control store

The P1 store gained one authoritative table, `operator_bindings` (row key `provisionId`), with a derived `${graphId}:${workId}` index rebuilt at open. Methods: `bindOperatorWorktree` (idempotent same-lease rebind keeps the original `boundAt`; different-lease rebind throws `binding-conflict`), `readOperatorBinding`, `readOperatorBindingByWork`, `listOperatorBindings(graphId?)`.

## Runtime invariants

No runtime invariant companion is published: the executor delegates work rows to graph-control and graph-wakes, so a companion would duplicate the state machines instead of comparing across independently maintained components.

## Further Exploration

- `packages/graph/graph-control` (P1): the store rows (provisions, bindings) and their durability contract.
- `packages/graph/graph-stream` (P2): `AgentGraphExecutor`, the record fold (`readCommittedAgentGraphProjection`), `stableHash32`, `truncateUtf8`.
- Maka reference: `packages/storage/src/git-worktree-child-executor.ts` (lease identity, deterministic paths, worktrees surviving terminal runs) and `session-manager.ts` (`runClaimedAgentGraphIntent`).
- `tests/graph-executor.spec.ts`: fake pool/runner plus a real sqlite-backed store.

## Model Experience

### Operator run records

#### What the model sees

Nothing directly. The package is host-side machinery: it renders no prompt (the coordinator does), and every child run settles into one `AgentGraphRecordSourceEvent` whose truncated summary is what the P4 supervisor tools later present to the model.

#### Token effect

None — the package adds no tokens itself. The 16 KiB-truncated summary (`[operator failed] <message>` on a failed run without one) enters model context only if a supervisor tool renders the record.

#### KV Cache effect

None — the package writes durable host rows and never contributes to model context.

## Known Limitations and Deferred Work

- Lease idempotency is process-local: a real pool implementation adopts a previously leased worktree after a restart by matching `listWorktrees`; nothing here re-derives leases from the store binding (the binding is the durable hint, not the lease authority).
- Worktrees intentionally survive terminal runs (Maka contract); the executor never releases a lease. Pool release is wired in for graph teardown in a later slice.
- `recordSink` failures propagate as execution failures — the reconciler reports them and the host retries; there is no crash-consistent terminal-event log in this slice.
- `runClaimedAgentGraphIntent` observes the seam contract the P2 README documents (`provisionOperator` may return `undefined`); the P2 `AgentGraphExecutor` type in `packages/graph/graph-stream/src/types.ts` still declares a non-optional provision result and is expected to line up on integration.

### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>None.</details>
