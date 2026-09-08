# Automatic memory extraction (opt-in)

English | [中文](README.zh.md)

Extract durable facts from what the user actually said, automatically, at the
same checkpoint where the conversation history is compacted. After each
`compaction/summary` event, `@deepseek-ai/dsh-memory-extraction` runs a
bounded, fail-open pipeline that writes into the same project memory bank
`retain`/`learn` use — additive to DSH's explicit memory surface.

## Applying the patch

```sh
dsh web --patch apps/cli/config/examples/memory-extraction/cordis.yml
```

The patch must load after the base composition (same convention as
[`../graph/cordis.yml`](../graph/cordis.yml)). It adds one host row for the
extraction runtime and the sqlite storage backend the control unit lives in.

## What it does

1. **Observes** every session's `compaction/summary` event through an unscoped
   host listener (per-session serialized runs; subagent/child sessions are
   excluded by default).
2. **Projects evidence** — only *user-authored* text of the checkpointed range
   (assistant text is interpretation-only, tool/results/checkpoints are opaque),
   bounded and fail-closed: a range that cannot fit the evidence budget is
   skipped rather than truncated silently.
3. **Proposes and canonicalizes** durable facts with up to 3 auxiliary model
   calls per range (proposal → [localization] → canonicalization), each bounded
   by `timeoutMs`. Admission verifies every quote verbatim against the bounded
   evidence and rejects secrets deterministically.
4. **Commits** admitted facts to the project memory bank with
   `source: memory_extract` and configurable importance (`0.5` default), after
   a dedupe probe against the bank.
5. **Advances only the committed boundary**: empty ranges still advance (with
   a no-op receipt, no model call); a failed range becomes one pending record
   retried by the next trigger and then discarded. Every run is idempotent by a
   deterministic operation id, so a crash between commit and receipt heals by
   dedupe instead of double-writing.

Failures never surface into the turn: the run is fire-and-forget after the
compaction listener, and every error is logged and contained.

## Planes

- **Host composition** (`cordis.yml` above): `memory-extraction` is a
  HOST row — one control unit per process, one global event observer. It
  injects the host `memory` and `llm` services and publishes nothing new.
- **No agent-preset contribution**: the explicit
  `retain`/`learn`/`memory_edit` surface remains the model-facing path
  (Maka's `memory_remember`/`memory_extract` verbs are reserved, not ported).

Full contract: the [memory-extraction subsystem doc](../../../../../docs/subsystems/memory-extraction.md)
and the package README of `packages/memory/memory-extraction`.
