# Layering the guard family: stream-rules × repeat-tool-reminder × timeout-policy

English | [中文](guard-policies.zh.md)

DSH ships a family of small, single-purpose "guard" plugins that shape agent behavior at three distinct moments of a turn. This page explains how `stream-rules`, `repeat-tool-reminder`, and `timeout-policy` **compose into one policy stack** — they attach to different extension points, so they layer without conflict — and gives the one reference composition to copy, plus tuning guidance.

## The stack at a glance

| Guard | Extension point | Fires on | Action | Default state |
| --- | --- | --- | --- | --- |
| `timeout-policy` | `tools/execute` wrapper | a tool call whose `timeoutMs` passes | replaces the result with a structured `TOOL_TIMEOUT` error | mounted in the base bundle |
| `repeat-tool-reminder` | `tools/post-execute` | N consecutive calls of the same tool (default `[3, 5, 8]`) | enriches the context with a reminder (no veto) | mounted in the base bundle |
| `stream-rules` | `session/event` `assistant/chunk` + `agent.cancel` | a regex matches the **live token stream** | aborts, injects the rule, retries the same point | mounted in the base bundle |

Time-of-turn ordering: `timeout-policy` wraps the dispatch lifetime (`tools/execute`) → `repeat-tool-reminder` observes each completed call (`tools/post-execute`) → `stream-rules` observes generation itself and, on a violation, cancels the partial turn and regenerates it with the rule injected as a plugin-sourced reminder. A stream-rules retry therefore goes through the timeout/reminder layers again like any other attempt.

## The one composition to copy

All three rows below are already mounted in the base bundle with these exact config values — this block is the **baseline to tune**, not something you must add. To customize, overlay a patch layer on the base composition and re-declare only the keys you change.

```yaml
- id: timeout-policy
  name: '@deepseek-ai/dsh-tool-call-timeout-policy'

- id: repeat-tool-reminder
  name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # consecutive repeats that trigger a reminder
    argumentsPreviewChars: 500   # cap on quoted call arguments in the reminder

- id: stream-rules
  name: '@deepseek-ai/dsh-stream-rules'
  config:
    contextMode: keep            # keep rules in context after a match
    interruptMode: always        # always abort+inject+retry on match
    repeatMode: once             # one retry per rule scope per turn
```

## How they compose (not conflict)

- - **Timeouts make stream-rules retries cheap and bounded.** A tool that hangs hard dies at `timeoutMs` instead of pinning the turn; combined with a stream-rule whose regex matches an anti-pattern, a chatty model burns a bounded retry budget rather than an unbounded sequence.
- - **Both reminder layers speak the same context channel.** `repeat-tool-reminder` enriches `tools/post-execute` decisions with extra context; `stream-rules` non-interrupting matches fold into the matched tool's result the same way. The model sees layered advice — "you repeated `write` 3×" plus "and the file should be at most N lines" — without either guard stepping on the other.
- - **Scoping takes the real seam.** `stream-rules` are per-repo (`.dsh/rules/**/*.md` under the workspace, re-scanned per turn); tool reminders and timeouts are global. Put *project* invariants in stream-rules, *interaction-shape* policies (no hammering a tool, no unbounded calls) in the other two.

## Tuning

- - **stream-rules:** `interruptMode: never` turns the guard into an observability layer (log-only); `contextMode: forget` drops the rule after one retry; `repeatMode: always` allows a rule to fire repeatedly within a turn. Inline rules (`config.rules`) work for machine-generated policy.
- - **repeat-tool-reminder:** stricter `thresholds: [2, 4, 6]`, or laxer `[5, 10]`; `include`/`exclude` are `*`-wildcard tool-name predicates (e.g. `exclude: [mcp_*]` stays legal even when no such tool is registered).
- - **timeout-policy:** the deadline comes from the tool's `timeoutMs` declaration — it has no global knob. Extend a bundled tool's budget by re-declaring the tool, or set `timeoutMs` when you author one.

## When not to

- - `timeout-policy` only arms for tools that declare `timeoutMs` and honor `exec.signal`; hand-written tools without a signal cannot be reigned in.
- - `stream-rules` match the *live* assistant stream — pure `assistant/message` static output that never streams is not observable by it; use `repeat-tool-reminder` or `tools/result` observations for those.
- - These guards **observe and shape**, they do not sandbox: filesystem / network confinement stays in the `sandbox` / `sandbox-policy` family.
