---
description: "Host-plane ctx.wikiGraph service exposing the Logseq CLI's db-worker-node graph operations as structured JSON calls for the wiki drawer and model-facing tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-logseq-graph

English | [中文](README.zh.md)

## Summary

`ctx.wikiGraph` exposes the Logseq CLI's `db-worker-node` graph operations as structured JSON calls, independent of any agent tools: page/block trees, tags, properties, Datalog queries, upserts/removals, and the `logseq_server` lifecycle. The web GUI's wiki drawer serves reads/writes through this service; model-facing `logseq_*` tools call the same CLI directly. Choose it when a composition needs wiki-graph storage behind a host service with one logical change per call. Its cost is one fresh CLI process per method call; graph writes need a running db-worker-node server, and the invariant fails fast at boot when the CLI binary is unreachable.

## Table of Contents

- [Service surface](#service-surface)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Host-plane graph service exposing the [Logseq](https://github.com/logseq/logseq) CLI's `db-worker-node` graph operations as structured JSON calls, independent of any agent tools: page/block trees, tags, properties, Datalog queries, upserts/removals, and the `logseq_server` lifecycle. The web GUI's embedded wiki drawer serves its reads/writes through this service via the apiproxy `wiki` domain; the model-facing `logseq_*` CLI tools (see `@deepseek-ai/dsh-tool-logseq`) use the same CLI directly.

## Service surface

One Cordis service `ctx.wikiGraph` (`LogseqGraphService`) with methods:

- `listPages({ includeBuiltIn, limit, offset })` → flat page rows
- `getPage({ page | id | uuid })` → nested block tree + linked references
- `listTags`, `listProperties`
- `search({ type, content, limit })`, `query({ query, inputs, limit })` (Datalog)
- `upsert(args)`, `remove(args)` — one logical change per call, forwarded flag-for-flag
- `server(action, { name })` — `list` / `start` / `stop` / `restart` / `cleanup`

Every method spawns the `logseq` CLI once (`--graph <name>` when configured) with `--output json`, validates the envelope, and projects the raw rows into the wire view types (`WikiTagRef`, `WikiBlockNode`, `WikiPageRoot`, …). The `@deepseek-ai/dsh-logseq-graph/invariant` companion fails fast at boot when the CLI binary is unreachable.

## Model Experience

None, as the host service registers no tool schema, prompt section, or result of its own; the wiki content it serves reaches the model only through `@deepseek-ai/dsh-tool-logseq` and the human's wiki drawer.

#### KV Cache effect

No prompt-shaping data comes from this package.

## Known Limitations and Deferred Work

- - **CLI must be installed** — the service spawns `logseq`; there is no bundled binary (built from the logseq repo: `opam exec -- dune build @bundle`). The invariant companion gives an install hint and `cliPath` supports a non-PATH binary.
- - **Per-call process spawn** — each method starts a fresh CLI process. Fine for interactive drawer use and one-shot agent edits; a high-frequency integration should batch via `upsert`.
- - **Graph server required** — graph writes need a db-worker-node server; the service reuses a running one (including the desktop app's) or `logseq_server start` launches a headless one. Requests against a stopped server surface as CLI errors.
- - **JSON shapes are read at runtime** — `list/search/query` fields follow the CLI's JSON contract and are projected defensively; a future CLI shape change degrades rows rather than crashing.
- - **`user.property/*` values are db-id refs** — property values appear as separate value blocks; editing property values through the service writes the value block, not inline `key:: value`.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
