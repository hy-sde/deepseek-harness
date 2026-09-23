---
type: Reference
title: Memory and Retrieval
description: The memory package group of DeepSeek Harness — the host ctx.memory service with its project-scoped local backend, the model-facing retain/recall/reflect/learn/memory_edit tools, and the memory:project prompt section.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-62500a0e62639fdb07f2851e
    resource: repo://docs/subsystems/memory.md
  - id: openwiki-source-4490c6a64cc3fdcb16ec790f
    resource: repo://docs/tool-catalog.md
  - id: openwiki-source-d53067eb0fa764c085ad0614
    resource: repo://packages/memory/README.md
  - id: openwiki-source-165a1b410910b86e82f5ddfd
    resource: repo://packages/memory/tool-memory/README.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# Memory and Retrieval

The `memory/` group provides agent-curated long-horizon memory — durable, project-scoped memory the agent curates itself. Two packages compose it: `memory/` owns `ctx.memory`, a host-plane service with a backend registry and a shipped `local` backend that persists files under `<harness home>/memories/<project>/`, and `tool-memory/` provides the model-facing `retain`/`recall`/`reflect`/`memory_edit`/`learn`/`mine_sessions` tools plus a `memory:project` system-prompt section.

Memory is complementary to session-query and compaction rather than overlapping them: those replay the conversation ledger, while this bank answers "what did we decide / prefer / learn here?" across sessions. It lives host-plane because the store is durable project data that easily outlives one session. `ctx.memory` delegates to the selected backend (default: the first registered; the shipped `local` provider mounts when `backend` is unset or `local`). Only `local` ships in this port — the registry keeps the seam open for Hindsight/Mnemopi-style providers later.

## Layout and data model

Each project (encoded absolute cwd) gets one memory root with three artifacts:

- `bank.jsonl.zstd` — editable working entries written by `retain` (id, content, context, source, importance, timestamps, active flag); backs `memory_edit`. By default the on-disk format is the same zstd frame container as session logs: each save batch is one checksummed frame, append-only and self-healing. The pre-rename plaintext `bank.jsonl` is still read and migrated on the first write; set `compression: 'none'` for the original line-append format.
- `learned.md` — newest-first, deduped, capped (100) lesson bullets written by `learn`.
- `memory_summary.md` — optional consolidated summary (hand- or tool-maintained) surfaced by `recall`, `reflect`, and prompt injection.

Stored text is injection-neutralized (control chars, `<`/backticks, `~~~` fences) and secret-redacted on both write and read. Search is lexical IDF scoring with light stemming over all three artifacts. `memory_edit` can `update`/`forget`/`invalidate` bank entries, while lesson and summary entries are read-only facts. The `local` backend is pure `node:fs` with an in-process per-file write chain, so concurrent saves from sibling sessions can never drop each other's writes. Mutations emit `memory/change` (`{ cwd }`) so in-process consumers can invalidate caches.

## The service and the tool surface

`MemoryService` (`ctx.memory`) owns the registry (`register`/`unregister`/`resolve`/`backendIds`) and thin delegation of `status`/`save`/`learn`/`search`/`edit`/`summaries`/`clear` to the selected backend, emitting `memory/change` after each mutation. `dsh-memory`'s plugin mounts the service and, when selected, the `local` backend. `dsh-tool-memory` contributes only the model-facing surface: five tools over `ctx.memory` and the `memory:project` system-prompt section (order 150, empty when the project has no memory yet).

- `retain` — store one or more durable facts (user preferences, project decisions, architectural choices); batch related facts, self-contained, normalized, deduplicated.
- `recall` — relevance-ranked search over bank + lessons + summary; returns ids that round-trip through `memory_edit`.
- `reflect` — synthesize an answer across many stored memories (blends, unlike `recall`); grounding is memory-only.
- `memory_edit` — `update` (replace content/importance), `forget` (hard delete), `invalidate` (soft supersede, optional `replacement_id`); lesson and summary entries are read-only facts.
- `learn` — capture one durable lesson (what/when/why) into `learned.md`; the write path strips prompt-injection markers and secrets.

When the harness `sessionQuery` service is mounted alongside (the tool-session-query row), `recall`/`reflect` merge past-session hits (source `session`, read-only, sessionId/seq origin), and `mine_sessions` harvests lessons from completed session logs — digests from compaction summaries, failures from turn/end error reasons, all-completed todos — stored as `learn` entries attributed to the session and deduped per run; without the service every session feature degrades to a no-op.

## Prompt injection

`apply()` registers `systemPrompt.section({ name: 'memory:project', order: 150 })` whose text is evaluated at each assembly and returns the calling session's project memory — `memory_summary.md` + `learned.md`, combined and head-tail truncated to `injectionMaxChars` (default 16000 chars) — or `''` for a project with no memory yet. The session identity comes from `context.agent.session.header.cwd`, so each project sees its own bank.

## Related pages

- [Capability Seams](../architecture/seams.md) — the seam pattern behind `ctx.memory`.
- [Session Data Plane](session-data-plane.md) — the ledger memory complements.
- [Subagent Capability Family](subagents.md) — how memory origin crosses sessions.
