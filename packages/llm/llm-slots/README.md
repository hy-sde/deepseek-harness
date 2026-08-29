# @deepseek-ai/dsh-llm-slots

English | [中文](README.zh.md)

Host-wide model-slot admission control (`ctx.modelSlots`) for the DeepSeek
Harness. A deployment that runs a handful of concurrent model providers behind
one local inference endpoint (typically 2–3 slots, ~1M context each) needs an
explicit budget over every model call — otherwise the main agent's turns,
running subagents, and workflow fan-out stack dozens of simultaneous bursts
against the endpoint and every call slows to queue latency.

## How it works

- **One chokepoint.** Admission decides FIFO at the `llm/stream` waterfall —
  the single boundary every model-backed call crosses (main agent loops,
  in-process subagents, worker-thread children, workflows, title/compaction
  side-requests), regardless of which session or context initiated it.
- **Host-global budget.** The gate lives in module scope, so every derived
  context and plugin instance shares one pool. Capacity is configured on the
  `llm-slots` row (default 3) and adjustable at runtime:
  `ctx.modelSlots.setCapacity(n)`.
- **Cancellable waits.** A call waiting for a slot observes its AbortSignal;
  cancellation while queued surfaces as an AbortError and never receives a
  freed slot.
- **One slot per logical call.** A call holds its slot for its full lifetime,
  including adapter retries, which also prevents a failing endpoint from
  fanning out an unbounded retry storm.

## Composition

The `dsh-base` bundle ships the row with neutral defaults:

```yaml
- id: llm-slots
  name: '@deepseek-ai/dsh-llm-slots'
  config:
    enabled: true
    capacity: 3
```

## Service surface

`ctx.modelSlots` exposes:

- `stats()` — `{ enabled, capacity, running, waiting, acquiredTotal }`.
- `setEnabled(boolean)` — toggle admission without touching capacity.
- `setCapacity(number)` — change the budget; a shrink applies as calls drain.

## Development

```sh
pnpm exec tsc -b packages/llm/llm-slots/tsconfig.json
pnpm exec vitest run packages/llm/llm-slots
```

No model-facing tools ship here; the package deliberately reads no LLM service
state (it only listens on the shared event bus), which keeps it trivially
testable and safe to mount in any context.

## Model Experience

None, as the service adds no model-bound text, schema, or message; it only serializes access to a host-wide slot budget on the shared `llm/stream` bus.

#### KV Cache effect

Pass-through; the gate delays only the first chunk of an admitted call and holds a host-level counter, so the model-facing request and response stream stay byte-identical with or without the plugin.
