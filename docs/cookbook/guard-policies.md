# Layering the guard family: repeat-tool-reminder × timeout-policy

English | [中文](guard-policies.zh.md)

DSH ships a family of small, single-purpose "guard" plugins that shape agent behavior at distinct moments of a turn. This page explains how `repeat-tool-reminder` and `timeout-policy` **compose into one policy stack** — they attach to different extension points, so they layer without conflict — and gives the one reference composition to copy, plus tuning guidance.

## The stack at a glance

| Guard | Extension point | Fires on | Action | Default state |
| --- | --- | --- | --- | --- |
| `timeout-policy` | `tools/execute` wrapper | a tool call whose `timeoutMs` passes | replaces the result with a structured `TOOL_TIMEOUT` error | mounted in the base bundle |
| `repeat-tool-reminder` | `tools/post-execute` | N consecutive calls of the same tool (default `[3, 5, 8]`) | enriches the context with a reminder (no veto) | mounted in the base bundle |

Time-of-turn ordering: `timeout-policy` wraps the dispatch lifetime (`tools/execute`) → `repeat-tool-reminder` observes each completed call (`tools/post-execute`). A hung call dies at the timeout first; a repeated-call anti-pattern is caught right after the call returns.

## The one composition to copy

Both rows below are already mounted in the base bundle with these exact config values — this block is the **baseline to tune**, not something you must add. To customize, overlay a patch layer on the base composition and re-declare only the keys you change.

```yaml
- id: timeout-policy
  name: '@deepseek-ai/dsh-tool-call-timeout-policy'

- id: repeat-tool-reminder
  name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # consecutive repeats that trigger a reminder
    argumentsPreviewChars: 500   # cap on quoted call arguments in the reminder
```

## How they compose (not conflict)

- **Timeouts make reminder retries cheap and bounded.** A tool that hangs hard dies at `timeoutMs` instead of pinning the turn; a churning call that survives is then caught by the reminder layer, so the model burns a bounded retry budget rather than an unbounded sequence.
- **Both guards speak through tool-call plumbing.** `repeat-tool-reminder` enriches `tools/post-execute` decisions with extra context; `timeout-policy` replaces a hung call's result with a structured error. The model sees layered advice — "you repeated `write` 3×" — and a dead call never silently stretches the turn.
- **Scoping takes the real seam.** Timeouts follow each tool's own `timeoutMs` declaration; reminders use wildcard tool-name predicates. Put *interaction-shape* policies (no hammering a tool, no unbounded calls) here.

## Tuning

- **repeat-tool-reminder:** stricter `thresholds: [2, 4, 6]`, or laxer `[5, 10]`; `include`/`exclude` are `*`-wildcard tool-name predicates (e.g. `exclude: [mcp_*]` stays legal even when no such tool is registered).
- **timeout-policy:** the deadline comes from the tool's `timeoutMs` declaration — it has no global knob. Extend a bundled tool's budget by re-declaring the tool, or set `timeoutMs` when you author one.

## When not to

- `timeout-policy` only arms for tools that declare `timeoutMs` and honor `exec.signal`; hand-written tools without a signal cannot be reigned in.
- `repeat-tool-reminder` observes completed calls, not the token stream; static output that is undesirable but never repeats a tool cannot be caught by either guard — use per-tool or per-step policy instead.
- These guards **observe and shape**, they do not sandbox: filesystem / network confinement stays in the `sandbox` / `sandbox-policy` family.
