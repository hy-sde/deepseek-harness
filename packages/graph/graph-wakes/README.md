---
description: "Host-side wake delivery for the Agent Graph: idle-gated delivery of durable supervisor wakes over the P1 control store."
kind: "package-reference"
---

# @deepseek-ai/dsh-graph-wakes

English | [中文](README.zh.md)

## Summary

`dsh-graph-wakes` delivers the Agent Graph's supervisor wakes at the root session's next idle boundary — never mid-turn — and settles every attempt durably through the control store's own begin/complete CAS. It supplies the process-local `GraphWakeRuntime` over a structural store seam plus a deliver hook and an injectable idle observer; delivery is idle-gated by construction, so the runtime starts nothing on its own. Mount it in host wiring, and let the P6 deliver hook re-drive the graph coordinator. It adds no tool, prompt, or plugin row.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

```ts ignore-check
import { GraphWakeRuntime } from '@deepseek-ai/dsh-graph-wakes'

const runtime = new GraphWakeRuntime({
  store, // GraphControlStore (structural seam)
  deliver: async ({ graphId, wakeId, rootSessionId, snapshotVersion }) => {
    await coordinator.wake() // P6: re-drive the graph, enqueue the checkpoint
    return { kind: 'delivered' }
  },
  onCompact: sessionId => ctx.compaction.compactIfNeeded({ session }, 'context-overflow', signal).then(() => {}),
  observeIdle: onIdle => {
    return ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') onIdle(agent.id)
    })
  },
})

runtime.start('session-root') // scope: one root; observe every root when omitted
await runtime.handleIdle('session-root') // the delivery entry point (and test hook)
await runtime.stop() // unsubscribe, cancel timers, await the in-flight sweep
```

```ts ignore-check
// Accessors
await runtime.pendingWakes('graph_g1') // pending + retryable wakes (terminal statuses excluded)
await runtime.wakeStatus('graph_wake_abc') // durable row, any status
```

## Understand the implementation

### Idle-gated delivery

Delivery runs only from `handleIdle(sessionId?)`. `start(rootSessionId?)` registers the injected `observeIdle` observer, which production wiring backs with `agent.ctx.on('agent/status', …)` guarded to `status === 'idle'` exactly like the Schedule plugin; the observer merely forwards to `handleIdle`. Idle signals fire between turns, so a wake is never delivered while a turn is running; the deliver hook itself must run the wake through the owning agent's maintenance/idle seam (P6), mirroring how `ScheduleRuntime` claims the idle phase with `runMaintenance` before `followup()`. `start` never delivers on its own. The observer reports only live roots, so enumeration is naturally scoped to sessions that can actually receive a turn; the re-arm timer is only a re-drive hint and still enters through `handleIdle`.

### Delivery attempts and the durable state machine

For every due wake the runtime calls the store's `beginSupervisorWakeAttempt` with a deterministic attempt id (`graphWakeAttemptId(wakeId, attemptIndex)`, `turnId` same value): the store increments `attemptCount` and moves the wake `pending → running` atomically under its write chain, refusing once the row is delivered or superseded. The deliver hook result is then settled through `completeSupervisorWakeAttempt`:

| deliver outcome | durable attempt status | re-armed? |
| --- | --- | --- |
| `delivered` | `delivered` | no |
| `waiting_permission` | `waiting_permission` | no (parked until host resumption) |
| `superseded` / `stopped` | `superseded` | no |
| `retryable_failed` | `retryable_failed` | yes, unless exhausted |

### Retries, backoff, and terminal failure

A `retryable_failed` outcome re-arms the wake at `outcome.nextAttemptAt` or `now + 30 s × attemptNumber` (defaults: `DEFAULT_RETRY_BACKOFF_MS`, `DEFAULT_MAX_DELIVERY_ATTEMPTS = 3`); the re-arm is process-local and a segmented timer re-drives `handleIdle` for the owning root. Once `attemptCount` reaches `maxAttempts` the runtime durably exhausts the wake (`exhausted`, with the last failure reason on the wake row): it leaves the unsettled/retryable listings, is never re-armed, and stays terminal across restarts.

### Context-overflow recovery

When a delivery returns `retryable_failed` with `overflow: true`, the runtime calls `onCompact(rootSessionId)` at most once per wake, then re-arms immediately for one bounded partial delivery (the deliver hook decides the partial shape and reports it with `partialResult: true`). If the partial attempt itself overflows, or the overflow arrives after the compact without declaring a partial, the runtime refuses a third identical full delivery: the wake is terminal (`exhausted` recovery state). With no `onCompact` wired, an overflowing wake terminates after the first attempt. The P1 attempt row has no `partialResult` column, so these markers stay process-local (see limitations).

### Stop suppression

A due wake is superseded **without delivery** when the graph's schedule log says the graph is stopped or closed: any update with a `finish` (graph closed — the coordinator's `isClosed` authority), or a log stop whose `targetId` is the root session or the graph id. The latter is the graph-level stop convention: this slice gives one session one graph, so a graph stop is recorded as a stop targeting the root identity, while work-item stops (work ids) never cancel wakes. The runtime mirrors the Schedule package's stop-cancels-due-record behavior by folding the durable log at every sweep instead of trusting process state.

### Single-flight and idempotency

Overlapping idle signals coalesce into one serial sweep (single-flight, re-requested when a signal lands during settlement), and the store CAS makes one attempt row one delivery: a second runtime or a retried sweep that begins the same attempt id observes `acquired: false` and delivers nothing. Store failures surface through `onError` and leave the attempt row `running` for host recovery; a throwing deliver hook settles as `retryable_failed` with the hook's message.

### Restart durability

All state the runtime needs is in the store: a fresh `GraphWakeRuntime` over the same store sees the same wake rows, re-arms orphaned `retryable_failed` wakes at the next idle (like Maka's `recover`), and durably exhausts any at-cap retryable row rather than leaving it unsettled. Backoff timestamps and overflow markers are process-local and are deliberately not persisted.

## Runtime invariants

No runtime invariant companion is published: wake rows are produced and consumed inside graph-control, so a companion would re-implement the same queue lifecycle.

## Further Exploration

- `packages/graph/graph-control` (P1): the durable wake rows and the begin/complete CAS this runtime settles.
- `packages/graph/graph-stream` (P2): `AgentGraphCoordinator`, re-driven by the P6 deliver hook.
- `packages/schedule/schedule` — the observation pattern (`agent/status === 'idle'` + `agent.whenIdle`) this runtime mirrors.
- Maka reference: `packages/runtime/src/agent-graph-supervisor-wake.ts` in the Maka checkout (authoritative wake semantics).
- `tests/graph-wakes.spec.ts`: real sqlite-backed store with a fake idle observer and deliver hook.

## Model Experience

### Idle-gated wake checkpoint

#### What the model sees

Nothing directly from this package. It is host-side machinery: the supervisor tools of slice P4 are what the model sees, and P6 wiring turns the `deliver` hook into the model-visible checkpoint turn that reaches the root session at the next idle boundary.

#### Token effect

None — the runtime assembles no prompt; the tokens for a delivered wake belong to the checkpoint turn the root session performs after `deliver` returns.

#### KV Cache effect

None — the package never invokes a provider itself; the wake checkpoint turn's cache belongs to that turn's own session.

## Known Limitations and Deferred Work

- The P1 attempt row has no `partialResult` (or overflow) column: the one-compact/one-partial markers are process-local. A restart clears them, so one more full attempt can occur before the `attemptCount` cap stops retries; exceeding the cap is still impossible.
- At the attempt cap the runtime exhausts the wake durably (`exhausted`); a crash between the last retryable completion and the exhaust call leaves the row `retryable_failed` at the cap, and the next idle sweep exhausts it.
- `running` wakes (crash between begin and complete) are not recovered here: whether an interrupted attempt really completed is a runtime fact, and the P1 `recoverSupervisorWakes` no-op keeps that fact with host wiring (P6).
- `waiting_permission` wakes are parked and never re-attempted; permission-response resumption (Maka `notifyPermissionResponse`) is deferred to P6.
- Cross-process coordination is out of scope: like the coordinator, the runtime is process-local, so another process holding the same store does not wake this runtime.
- The graph-level stop convention (log stop with `targetId` equal to the root/graph id) is defined here; a work-item stop never suppresses wakes. P4 must commit graph stops with the root identity for suppression to engage.

### Dev Note

<details><summary>Working context for maintainers — click to expand</summary>None.</details>
