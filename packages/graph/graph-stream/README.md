---
description: "Derived stream layer for the Agent Graph: deterministic identities, record/trace/readiness/schedule projections, handoffs, and the process-local reconciliation coordinator."
kind: "package-reference"
---

# @deepseek-ai/dsh-graph-stream

English | [中文](README.zh.md)

## Summary

`dsh-graph-stream` is the derivation layer of the Agent Graph. It recomputes everything derivable from the control store's committed rows — work-status projection, record folding, trace and route derivation, readiness intents, bounded input handoffs — and drives the single-flight reconciliation loop (`AgentGraphCoordinator`) that walks provision, supervise, select, render, and execute against that store. All ids are deterministic sha256 cut to 32 hex chars, so replays are idempotent and every projection is pure. It adds no tool, prompt, or plugin row; the executor adapter and supervisor tools consume it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

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

## Understand the implementation

### Deterministic identities and ordering

`stableHash(value)` = `sha256:` + hex of canonical JSON (sorted object keys, `undefined`/function/symbol → `"[undefined]"`, bigint → numeric string, `required`/`enum` arrays sorted with `localeCompare`, Date → ISO). All ids use the first 32 hex chars. `compareAgentGraphIdentity` is UTF-16 code-unit order — stable across processes, unlike `localeCompare`.

### Projections

- **Schedule projection** (`projectAgentGraphSchedule`): folds the append-only update log into the model-visible work view; validates contiguity (revisions from 1), no updates after a finish, no repeated work ids, wrong graph ids rejected. `stopped` wins over `superseded`.
- **Record fold** (`readCommittedAgentGraphProjection`): derives reference-only records from committed events per (operator, session); partial events skipped; at most one terminal record per activation; deterministic order.
- **Trace** (`validateAgentGraphTraceTopology`, `buildAgentGraphTraceSnapshot`): validates the DAG (duplicate ids/endpoints, self-loops, unknown operators, cycles via Kahn) and derives one route per (record × outgoing edge).
- **Readiness** (`buildAgentGraphReadinessSnapshot`): map policy — one intent per route received through a declared incoming edge, sealed against exactly the triggering records (`policyFingerprint`, `readinessContextFingerprint`, `graph_intent_…` via stable hashes).
- **Handoff** (`hydrateAgentGraphInputHandoffs`, `renderAgentGraphScheduledWorkPrompt`): resolves bounded conclusion text (16 KiB/record, 48 KiB total, `…` ellipsis, binary search over code points) and renders the operator prompt: instruction + `GRAPH_OPERATOR_HANDOFF_PROTOCOL` + `<agent_graph_input_handoffs>` with `<` escaped as `\u003c`. Records stay reference-only; text is resolved only at render time.

### Reconciliation and the coordinator

`reconcileAgentGraphSchedule` walks Maka's phases: A provision operators → B derive supervisor intents → C select (existing claims always; new capped by `maxNewActivations`, excess → `activation_limit`) → D render (all-or-fail) → E execute (claim at revision → run with `admitExecution` = begin-execution at revision). Statuses: `reconciled | waiting | limit_reached | failed | cancelled | stale`. `applyScheduleStops` replaces (`status: 'superseded'`), cancels claims, and stops sessions in batches.

`AgentGraphCoordinator` is the process-local single-flight driver: `scheduleUpdate` commits a row then wakes the drive; `reconcileAndWait` joins exactly one drive; `recover` resumes graphs with a non-empty schedule after restart; `stop`/`wake`/`isClosed` surface the same lifecycle. A drive re-runs while work or stopped targets remain, and observes existing claims as already-dispatched (executor dedupes by claim id).

### Executor seam

```ts ignore-check
export interface AgentGraphExecutor {
  provisionOperator(request: AgentGraphOperatorProvisionRequest): Promise<AgentGraphOperatorProvisionResult | undefined>
  runClaimedAgentGraphIntent(input: AgentGraphRunClaimedIntentInput): Promise<void>
  stopSession(sessionId: string, opts?: { reason?: string }): Promise<void>
}
```

The coordinator never calls a provider directly — P3 supplies the subagent/worktree-backed implementation.

## Runtime invariants

No runtime invariant companion is published: graph-stream projects graph rows into stream-safe deltas that graph-control already validates at the write boundary.

## Further Exploration

- `packages/graph/graph-control` (P1): the durable rows this layer folds.
- `src/reconcile.ts` / `src/coordinator.ts`: the drive loop and status derivation.
- `src/hash.ts` / `src/identity.ts`: the canonicalization and ordering primitives every id and fingerprint depends on.
- `tests/graph-stream.spec.ts` / `tests/reconcile.spec.ts`: projection, validation, handoff, and end-to-end drive scenarios against a real sqlite-backed store.

## Model Experience

### Scheduled work handoff prompt

#### What the model sees

The package renders the operator handoff prompt an operator child run receives: the work instruction, `GRAPH_OPERATOR_HANDOFF_PROTOCOL`, and an `<agent_graph_input_handoffs>` block with `<` escaped as `\u003c`. Bounded conclusion text is resolved only at render time. Projections themselves stay reference-only; the model sees the rendered prompt text and the folded records the supervisor tools of P4 present, never raw record or route rows.

#### Token effect

The handoff prompt is assembled here, so its size is part of the operator's context budget: 16 KiB per record and 48 KiB total, with an `…` ellipsis when the binary search over code points hits the cap.

#### KV Cache effect

None — the package never invokes a provider itself; cached context is whatever the child run's own session builds.

## Known Limitations and Deferred Work

- Readiness policy kinds: `map` only — `all_settled` and supervisor-readiness kinds are deferred to P4.
- No client projection/checkpointing (`onCheckpoint`) yet; no tool-view pagination; residency is a no-op.
- Map-policy intents are derived but not auto-dispatched by reconcile — they surface for supervisor tools in P4.
- Record shape is copy-with-origin (slim), a deliberate deviation from Maka's 18-facet full record; the stream layer never mutates stored records.
- The coordinator is process-local: another process holding the same graph store will not wake this driver automatically (wake delivery is P5).

### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>None.</details>
