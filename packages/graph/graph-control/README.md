---
description: "Durable control plane for the Agent Graph: schedule updates, exactly-once intent claims, operator provisions, and supervisor wakes."
kind: "package-reference"
---

# @deepseek-ai/dsh-graph-control

English | [中文](README.zh.md)

## Summary

`dsh-graph-control` is the durable decision store behind the Agent Graph. It records schedule updates, exactly-once intent claims, operator provisions, and supervisor wakes in one `KvUnit`, so replays are idempotent and retries reuse their activation identity. Mount it once per process: open the `agent_graph` unit after acquiring the storage backend, then commit schedule updates and claim intents at the observed revision. All mutations serialize on one write chain, and derived uniqueness indexes rebuild on open so torn writes heal instead of corrupting. It contributes no tool, prompt, or plugin row; the graph coordinator, executor adapter, and supervisor tools consume it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

```ts
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { GraphControlStore } from '@deepseek-ai/dsh-graph-control'

const backend = await ctx[storageBackendServiceKey('sqlite')]
const unit = await backend.kv.open(GraphControlStore.descriptor)
const store = await GraphControlStore.open(unit)

const { update, created } = await store.commitScheduleUpdate(request)
const { claim } = await store.claimIntentAtScheduleRevision(claimRequest, update.revision)
```

Open the unit exactly once per process: the storage layer rejects double-open, and the store is the single writer chain over the unit.

## Understand the implementation

- **Schedule log** (`schedule`): append-only decisions, revision = max+1, idempotent by `updateId` and by source triple `(session, run, toolCall)`; `finish` cannot combine with `add_work`; the graph is closed once a finish is committed.
- **Intent claims** (`claims`): keyed `graphId:intentId`, with activation-identity uniqueness (`(targetSessionId, targetTurnId)` and `(targetSessionId, targetRunId)`) enforced against derived indexes; transitions `claimed → executing → cancelled` are revision-conditional; fresh claims are rejected after closure while existing claims stay dispatchable.
- **Operator provisions** (`provisions`): deterministic `provisionId`/`operatorId` make retries adopt the same operator; revision-conditional and closure-blocked like claims.
- **Supervisor wakes** (`wakes` + `wake_attempts`): claim once, begin attempts (refused once delivered/superseded), complete with `waiting_permission | delivered | superseded | retryable_failed`; supersede by root session (+ optional graph filter); `recoverSupervisorWakes()` is deliberately a no-op — whether an interrupted attempt really completed is a Runtime fact, so the coordinator (P5) inspects run facts and completes accordingly. The store never guesses.

## Further Exploration

- Maka design note: `~/Documents/workspace/port_maka.md` — the port's design note and phase checklist.
- Maka reference: `docs/architecture/agent-graph-stream-scheduling-draft.md` (Chapter 7) in the Maka checkout.

## Model Experience

### Graph schedule records

#### What the model sees

Nothing. This package is host-side machinery; the model never receives its rows directly. The supervisor tools of slice P4 are what expose graph facts (`schedule updates`, `intent claims`, `operator provisions`, `supervisor wakes`) to the model.

#### Token effect

None — host-side rows never enter model context, so this package adds or consumes no tokens.

#### KV Cache effect

No KV cache effect: the store writes durable host rows and contributes nothing to model context.

## Known Limitations and Deferred Work

- No epoch table: one DSH session owns one graph per the design decision (multi-graph-per-root is deferred).
- Multi-row CAS is process-atomic (one write chain), not transaction-atomic; a crash mid-sequence heals on open because indexes are derived. Claims with a torn write are recovered by the coordinator inspecting run facts, as in Maka.
- Derived work status (`requested/stopped/superseded`), records, routes, readiness, and client snapshots belong to later slices and are not stored here.

### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>None.</details>
