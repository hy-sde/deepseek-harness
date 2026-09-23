---
description: "Model-facing agentsview access tool: one-shot queries against the local agentsview archive that the agentsview CLI maintains directly from the DeepSeek Harness session store — session intelligence, analytics, costs, semantic search, recall and export."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agentsview

English | [中文](README.zh.md)

## Summary

`dsh-tool-agentsview` exposes the local [agentsview](https://github.com/kenn-io/agentsview) archive as one model-facing `agentsview` tool with ten actions. Each call spawns `agentsview <command> --format json` once and parses the JSON document. The agentsview CLI already parses DeepSeek Harness session logs itself (multi-frame, torn tails, compaction duplicates), so the seam is read-only over the same files the harness writes. It is the analytics complement to `tool-session-query` (the in-process transcript pager): health grades, windowed statistics, token-cost reports, transcript search, the recall brief, and content-free export. The boundary is the hand-maintained argv mapping: a release that changes flags needs this package updated.

## Table of Contents

- [Tool surface](#tool-surface)
- [Why a CLI wrapper over DSH-native session tools](#why-a-cli-wrapper-over-dsh-native-session-tools)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Model-facing [agentsview](https://github.com/kenn-io/agentsview) access: session intelligence, analytics, costs, transcript search, recall and export over the same DeepSeek Harness session store the harness writes. One tool, one spawn per action, JSON in/out.

## Tool surface

- `agentsview action=list [limit] [project] [agent] [includeAutomated] [includeOneShot] [includeChildren]` — recent sessions with health grade + outcome columns.
- `agentsview action=get [sessionId]` — one session's metadata and signal counts.
- `agentsview action=sessionUsage [sessionId] [ownOnly]` — token usage and cost estimate attributed to a session.
- `agentsview action=health [sessionId] [limit]` — grade/outcome list, or the detailed signal panel for one session.
- `agentsview action=stats [since] [until] [agent] [includeProjects]` — windowed workspace analytics (archetypes, duration, context peak, tool/model mix, git outcomes).
- `agentsview action=usage [since] [until] [agent] [all] [breakdown]` — daily token usage and estimated cost report.
- `agentsview action=search [query] [mode=substring|regex|fts|semantic|hybrid] [limit] [excludeSession]` — transcript content search (semantic/hybrid need the vector index built).
- `agentsview action=recallQuery [query]` / `action=recallBrief [query]` — experimental distilled-knowledge query and packed task brief (human text).
- `agentsview action=exportSessions [limit] [cursor] [project] [outcome] [healthGrade] [minToolFailures] [since] [until]` — content-free JSON session summary export (schema_version 6).

## Why a CLI wrapper over DSH-native session tools

`tool-session-query` reads the live session store in-process and stays the right tool for paging transcripts and searching messages with DSH semantics. What it does not compute is derived analytics: health grades and outcome classification, windowed statistics, token/cost accounting, semantic search over an embedding index, the recall corpus, and content-free export. AgentsView computes all of that in Go (MIT) and already understands the DSH format — including multi-frame `.zstd` and compaction duplicates — so wrapping its CLI gives the fork the whole analytics surface with zero porting, following the exact pattern that made `tool-codebase-memory` and `tool-logseq` CLI-first pivots viable. The wrapper keeps the model surface small: one tool with an action enum instead of ten verbose subcommands, one JSON schema, per-preset `cliPath`/`sessionDirs`, and an activation invariant that fails fast with an install hint when the binary is missing.

## Configuration

```ts
import { Context } from '@deepseek-ai/cordis'
import toolAgentsviewPackage from '@deepseek-ai/dsh-tool-agentsview'

const ctx = new Context()
ctx.plugin(toolAgentsviewPackage, {
  cliPath: 'agentsview', // CLI executable (default: on PATH)
  sessionDirs: ['/Users/me/.dsh/sessions'], // optional DSH session roots (DEEPSEEK_HARNESS_SESSIONS_DIR)
  timeoutMs: 120000, // per-call process timeout (first calls sync the archive)
  maxChars: 200000, // cap on rendered JSON payload before explicit truncation
})
```

Without `sessionDirs` the CLI applies its own defaults: it honors `DSH_HOME` (falling back to `<home>/sessions`) and re-roots the DSH session path accordingly, so a stock deployment needs no configuration. When a deployment keeps sessions elsewhere, pass the roots; the tool forwards them as `DEEPSEEK_HARNESS_SESSIONS_DIR` (path-delimiter separated). The plugin activation invariant fails fast with an install hint when the CLI is missing. Verify at any time with `agentsview version --json`.

## Model Experience

### Tool schemas

#### What the model sees

One hand-authored `agentsview` schema ([catalog entry](../../../docs/tool-catalog.md#deepseek-aidsh-tool-agentsview)) with a required `action` enum plus per-action optional fields. Descriptions state which fields apply to which action, so the model picks the action by intent (session triage → `list`/`health`; costs → `usage`; finding evidence → `search`; packing context → `recallBrief`) rather than memorizing CLI flags.

#### Token effect

One static schema (~2 KB) replaces ten subcommand schemas; results are JSON payloads capped by `maxChars` (default 200000), so a wide `stats` or `exportSessions` cannot blow the context.

#### KV Cache effect

The schema is static; per-call args vary but never condition the request prefix. Cached prefixes stay valid across calls.

### Result values

#### What the model sees

Structured JSON documents parsed from the CLI's `--format json` output for the eight structured actions (`list`, `get`, `sessionUsage`, `health`, `stats`, `usage`, `search`, `exportSessions`), so fields like `health_grade`, `outcome`, `cost_usd`, and `hits` are first-class. `recallQuery`/`recallBrief` return the CLI's human text as-is (those surfaces do not promise JSON). CLI errors surface as `AgentsviewCliError` with argv/exit code attached — never as fake success.

#### Token effect

Payloads pass through and are truncated only past the `maxChars` cap with an explicit marker; the CLI's own `limit`/`cursor` paging is the primary cost control.

#### KV Cache effect

Results are per-call snapshots; no read-back that would change the model's rerun prefix.

### Prompt section

#### What the model sees

One `agentsview:tools` card: what the archive is, the action list, first-call sync latency, `config.cliPath`/`sessionDirs` overrides, and that `semantic`/`hybrid` search needs the vector index (`agentsview embeddings build`) while `fts` always works.

#### Token effect

Four short lines added once to the request prefix; negligible per turn.

#### KV Cache effect

Static section text — no invalidation.

## Known Limitations and Deferred Work

- The curated argv mapping is a hand-maintained mirror of the agentsview CLI flags; a release that renames commands or flags needs this package updated (the failure mode is a per-call CLI error, not silent corruption).
- The first call against a fresh archive may take noticeably longer: the CLI syncs the session store on demand (its commands that need fresh data auto-start the daemon). A warm archive is local-SQLite-fast.
- `search` with `mode=semantic|hybrid` requires the vector index and `[vector]` configuration; without it the CLI errors — fall back to `fts`/`substring`.
- Recall is experimental by upstream definition: the corpus schema may be rebuilt on upgrades and model-backed extraction additionally requires `[recall.extract]`; `recallQuery`/`recallBrief` work only when the corpus is populated (extraction enabled or entries imported).
- AgentsView reads the DSH default JSONL persistence (plain `session.jsonl` and multi-frame `session.jsonl.zstd`); deployments that switch the harness to the optional SQLite persistence backend are not ingested.
- No host-plane service or GUI surface: the tool is pure CLI access; the agentsview web UI (`http://127.0.0.1:8080`) remains the human-facing dashboard.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
