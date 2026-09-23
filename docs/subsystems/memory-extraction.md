# Automatic memory extraction

English | [中文](memory-extraction.zh.md)

**Compaction-triggered memory extraction** — after each checkpoint, a bounded, fail-open pipeline turns the user-authored text of the checkpointed log range into durable facts in the same project memory bank `retain`/`learn` write. Ported from Maka's automatic memory-extraction trigger (see `port_maka.md` No. 2) as a single package, [dsh-memory-extraction](../../packages/memory/memory-extraction): one host-plane Cordis plugin, no tool, no prompt section — DSH's explicit `retain`/`learn`/`memory_edit` surface stays the model-facing path.

The design is deliberately conservative where Maka was generous: the port keeps Maka's load-bearing rules (evidence = user-authored text only, bounded and fail-closed; proposal → admission → canonicalization → re-admission with verbatim quote verification and deterministic secret rejection; at most 3 auxiliary model calls per range; the per-session cursor only advances to a committed boundary with empty ranges still advancing) and simplifies the failure schedule to one pending retry per range, then discard.

## Why host-plane

The plugin observes **every session's** `compaction/summary` events. DSH's scope filter admits unscoped listeners globally (a host `ctx.on('session/event')` receives events from all sessions), while an agent-scoped listener only sees its own session. The `memory_extraction` control unit (cursors, receipts, and the pending-failure ledger per session) is opened once per process — a per-session row would collide on unit open. Both reasons pin the row to the **host composition**; nothing about it is keyed by session.

## The pipeline

1. **Trigger.** `compaction/summary` (emitted by [dsh-compaction](../../packages/compaction/compaction) at a checkpoint) with `seq` as the boundary. The run is scheduled on a per-session queue so two checkpoints of one session never interleave; each trigger is idempotent by operation id `memory_` + sha256(`{sessionId, trigger, boundarySeq}`).
2. **Evidence projection.** Only `user/message` events with `source.kind === 'user'` are evidence; assistant text is interpretation-only; tool calls/results, reasoning, and plugin checkpoints stay opaque (they can contain tool outputs or injected instructions). Records are normalized and capped at 4 000 code points each, the JSON payload at 12 000 chars, the record count at 64 (Maka's numbers); an evidence set that cannot fit the minimum cap fails closed (the range is skipped, never silently truncated).
3. **Proposal.** One auxiliary call asks for complete/`search_required`/ `cannot_resolve` over the bounded evidence, framed as **untrusted data** with the JSON output contract. `search_required` triggers a same-session localization search (bounded by 7 turns, 12 000 chars) and a second call; each `cannot_resolve` settles the range as committed-skipped.
4. **Admission.** Every proposal item is admitted only when its content is policy-safe (secret redaction: `sk-`/`ghp_`/`AKIA`-style patterns) and every citation quote (min 4 chars) appears verbatim in the referenced bounded evidence. Citations are cross-checked after canonicalization too.
5. **Canonicalization.** A third call maps candidate ids to accepted/rejected/final-content; admitted outputs are re-verified against the same evidence. Total model calls per range: **3**, each bounded by `timeoutMs` (default 60 s).
6. **Commit.** Admitted facts are written with `source: 'memory_extract'`, configurable importance (default `0.5`), and an origin context naming the session and checkpoint. A dedupe probe against the bank skips normalized duplicates. Write order is **items → cursor → receipt**: a crash between cursor and receipt can never double-process the range (the next trigger starts at the new cursor), and a crash between items and cursor heals via the dedupe probe.
7. **Failure schedule.** An empty range (or a range with events but no user evidence) advances the cursor with a `skipped` receipt and zero model calls. A failed range writes one pending failure record (`fromSeq`/`throughSeq`/ coverage hash/attempts) which the next trigger retries **once**; a second failure discards the range (cursor advances, `discarded` receipt). Coverage is hash-verified so a retry never runs against changed data.

Fail-open: the runtime catches every error, logs it, and never lets an extraction failure surface into the turn that triggered it.

## The store

`memory_extraction` (version 1, tables `cursors`/`receipts`/`failures`) lives in the kv facet of the configured storage backend (`sqlite` by default, via `storage.backend.<name>.kv.open`), same convention as the [graph control unit](../subsystems/graph.md). One `KvUnit`, single write chain, no SQL transactions: multi-step atomicity is process-scoped and compensated by write ordering plus idempotency, not by rollback.

## Configuration

| field | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch; `false` keeps the plugin inert |
| `backend` | `sqlite` | storage backend whose kv facet hosts the control unit |
| `provider` / `model` | session's routed request header | auxiliary-model override (cheap model recommended) |
| `importance` | `0.5` | bank importance stamped on extracted facts |
| `dedupe` | `true` | probe the bank before commit to skip duplicates |
| `excludeSubagents` | `true` | child/session compactions never extract (re-checked before each model call) |
| `timeoutMs` | `60 000` | per-call auxiliary timeout |

See the [example patch](../../apps/cli/config/examples/memory-extraction/cordis.yml) for the host-composition rows, and the package README for the internal layout.
