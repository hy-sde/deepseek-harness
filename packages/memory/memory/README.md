---
description: "The host ctx.memory service and its provider registry: durable, project-scoped agent-curated memory that reloads through prompt injection at the start of the next session."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

## Summary

`dsh-memory` provides the host-plane `ctx.memory` service and its provider registry: durable, project-scoped memory an agent curates itself with `retain`/`recall`/`reflect`/`memory_edit`/`learn`, reloaded through prompt injection at the start of the next session. Choose it when a deployment wants cross-session answers to "what did we decide, prefer, or learn here?" — it complements session-query and compaction, which replay history instead of remembering. Only the `local` backend ships; the cost is one memory root per project under `<harness home>/memories` with heuristic deduplication, and storage is project-scoped, so cross-project facts need explicit export/import.

## Table of Contents

- [Layout](#layout)
- [Service API](#service-api)
- [Config](#config)
- [Tests](#tests)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

**Agent-curated long-horizon memory** for DeepSeek Harness — the `ctx.memory` service and its provider registry, ported from the [@oh-my-pi](https://github.com/oh-my-pi) coding-agent memory surface (see `port_omp.md` item 4). Memory is durable, **project-scoped** data the agent curates itself with the `retain`/`recall`/`reflect`/`memory_edit`/`learn` tools (shipped by `@deepseek-ai/dsh-tool-memory`), and it is **reloaded at the start of the next session** through prompt injection. It complements DSH's session-query and compaction instead of overlapping them: those replay conversation history, this bank answers "what did we decide / prefer / learn here?" across sessions.

Only the **`local` backend** ships. The registry keeps the seam open for Hindsight/Mnemopi-style providers later — a future provider registers one `MemoryBackend` and the same tools work unchanged.

## Layout

The service is host-plane: the store is durable project data that crosses sessions, so it mounts as a row in the base bundle (`packages/bundle/base/cordis.patch.yml`), and per-session tool packages resolve it. Data lives under `<harness home>/memories/<project>/` where `<project>` is an encoded absolute cwd — one memory root per project, shared by every session and tool on it.

Each project root holds three artifacts:

- - `bank.jsonl.zstd` — editable working entries written by `retain` (id, content, context, source, importance, timestamps, active flag). Backs `memory_edit`. By default the on-disk format is the same zstd frame container as session logs: each save batch is one checksummed frame, append-only and self-healing. The pre-rename plaintext `bank.jsonl` is still read and is migrated on the first write; set `compression: 'none'` in `LocalMemoryConfig` for the original line-append format.
- - `learned.md` — newest-first, deduped, capped (100) lesson bullets written by `learn`; the same format and normalization omp keeps. Survives consolidation; `learn` writes are injection-neutralized and secret-redacted.
- - `memory_summary.md` — optional consolidated summary (hand- or tool-maintained) that `recall`, `reflect`, and prompt injection surface.

## Service API

```ts ignore-check
await ctx.plugin(DshMemory, { root: '~/.dsh/memories' })

const memory = ctx.memory                       // MemoryService
await memory.save({ cwd }, { content, context, source, importance })
await memory.learn({ cwd }, { content, context })
await memory.search({ cwd }, 'query', { limit: 10 })
await memory.edit({ cwd }, 'update' | 'forget' | 'invalidate', { id, content, importance, replacementId })
await memory.summaries({ cwd })                 // { summary?, learned?, block }
await memory.status({ cwd })
await memory.clear({ cwd })
```

Backends register into the service: `memory.register(backend)` returns a disposer, and `memory.resolve()` returns the configured (default: first) backend. Mutations emit `memory/change` (`{ cwd }`) so in-process consumers can invalidate caches.

A `MemoryBackend` is a dozen methods over `@deepseek-ai/dsh-memory/types`; the shipped one, `LocalMemoryBackend`, is pure-node (`node:fs`) with an in-process per-file write chain so concurrent saves from sibling sessions can never drop each other's writes.

## Config

All keys are optional.

| Key | Default | Meaning |
|---|---|---|
| `root` | `<harness home>/memories` | Memory root (`~`/`$HOME` expand). |
| `backend` | first registered | Backend id the service delegates to. |
| `defaultImportance` | `0.7` | Baseline importance when a save omits it. |
| `searchLimit` | `10` | Default result cap for one search. |

Per-entry caps: bank content 4000 chars, bank context 800, lesson content 2000, lesson context 400, lessons capped at 100 newest-first. All stored text passes injection-neutralization (control chars, `<`/backticks, `~~~` fences) then secret-redaction, on write and on read.

## Tests

```sh
pnpm vitest run packages/memory/memory
```

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

## Known Limitations and Deferred Work

- Storage is project-scoped; cross-project facts require explicit export/import.
- Memory entries are deduplicated heuristically, so near-duplicate facts may both persist.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
