---
type: Reference
title: Session, Step and Turn Lifecycle
description: The agent-loop lifecycle of DeepSeek Harness — a step is one model request plus the tools it calls, a turn is zero or more steps, and the session log is the single source of model context.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-a1cf509b7fd60dff7056946d
    resource: repo://docs/agent-lifecycle.md
  - id: openwiki-source-115b2dad781e2a2c5b5a980d
    resource: repo://docs/architecture.md
  - id: openwiki-source-25dae37e70b0e300a38163c5
    resource: repo://packages/core/agent-loop/README.md
  - id: openwiki-source-a0892679e67696a7f55b984d
    resource: repo://packages/core/session/README.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# Session, Step and Turn Lifecycle

A **step** is one model request plus the tools it calls. A **turn** is zero or more steps: it opens before its first input is claimed and closes once nothing is owed.

## The turn/step sequence

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                   reject | enter(messages, startsRequestSeries?)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     append entered messages as user/message
     derive model history from the log
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> claim -> next step
  -> agent/turn-stopping
turn/end
```

`turn/*`, `step/*`, `user/message`, `assistant/*`, and `tool/*` are durable session events; the rest are live extension points across the three domains. `agent/pre-step`, `agent/request`, `llm/stream`, and the three `tools/*` events are waterfalls whose listeners must call `next()` to delegate; `agent/turn-stopping` is serial and has no `next()`.

## Input and interception

Input reaches the driver through one inbox. Some messages wake it immediately; injected context waits in the inbox until another message does.

`agent/pre-step` decides what the model sees. Listeners may rewrite the claimed messages or reject them outright; a rejected or empty first claim still closes a durable turn that spent no step, so the log records the attempt. An enter decision may also set `startsRequestSeries` to begin a distinct model-message series: the loop then logs a fresh `request/header` (reason `series`, or `change` carrying `startsSeries: true` when the envelope changed too). A listener that rebuilds a downstream enter decision must spread it (`{ ...decision, messages }`) so the declaration survives. Each step reads the prompt sections and tool schemas that plugins registered.

## The session log is the source of model context

The session log is the source of the context the model sees. `deriveMessages()` projects model history from it, and raw `assistant/chunk` events preserve replay and UI fidelity. Fork, resume, transcripts, telemetry, and persistence all derive from this stream.

**Model-visible means logged.** Anything that reaches a model request must be reconstructable from the log, and a runtime invariant asserts it. This is why a new model-visible input requires a new session event: extend `SessionEventMap` and render from the log.

`dsh-session` provides the append-only session log — the single source of truth every model-visible fact flows through. The LLM message history is derived from the log, never stored separately, so replay is re-derivation from the same events and compaction can shadow older surface entries without deleting history. Surface events (`user/message`, `assistant/message`, `tool/result`) must declare how they join the ordered surface; raw chunks, boundaries, and other log-only events never produce a message. Persistence is deliberately a separate concern: backends subscribe to `session/event` and flush on `session/flush`.

## The driver

`dsh-agent-loop` creates agents — fresh or resumed from persisted history — and runs the turn and step lifecycle that claims prompts, assembles requests, streams model responses, dispatches tool calls, and appends every result back to the session log. As the default driver it implements the `Agent` interface from `dsh-agent` and registers its factory on `ctx.agents`, so plugins create and drive agents through `ctx.agents` without depending on this package. It is the harness's only concrete loop — everything beyond "call the model, run the tools, repeat" belongs to plugins listening on the event taxonomy. `maxParallelToolCalls` caps how many parallel-safe tool calls run at once.

The durable/live split is visible in the lifecycle: durable replay facts stay on `session/event` while live control and status stay on `agent/*`. SDK users that need replayable transcript data consume `session/event`; `agent/*` is the live coordination API.

## Related pages

- [Event Domains and Lifecycle Events](events.md) — the event vocabulary behind the sequence.
- [Capability Seams](seams.md) — the seams the loop consumes.
- [Tool Registry and Execution Pipeline](../platform/tools-pipeline.md) — the tool dispatch segment.
- [Session Data Plane](../platform/session-data-plane.md) — how the log is made durable.
