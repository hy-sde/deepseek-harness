---
type: Reference
title: Codebase Memory Tools
description: The codebase-memory package group — one-shot codebase-intelligence tools (index, search, query, trace, architecture) running against the local codebase-memory daemon through the CLI mode.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-2cc6fbd7ad78940c9bba3db2
    resource: repo://packages/codebase-memory/README.md
  - id: openwiki-source-4a0a7e179da92f7765e53c63
    resource: repo://packages/codebase-memory/tool-codebase-memory/README.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# Codebase Memory Tools

The `codebase-memory/` group provides `tool-codebase-memory`: model-facing codebase-intelligence tools that run one-shot queries against the local codebase-memory daemon from the terminal. The tools are the local alternative to the stdio MCP client row: instead of holding a long-lived MCP server inside every session, each call spawns `codebase-memory-mcp cli --json <tool>` once and parses the raw MCP result envelope — the same daemon the MCP server fronts, so indexes, project mutation locks and the index supervisor are fully shared.

## Tool surface

- `codebase_list_projects` — all indexed projects (name, root path, git state); the vocabulary source for `project` everywhere else.
- `codebase_index_repository [repoPath] [mode=full|moderate|fast|cross-repo-intelligence] [...]` — index a repo once, query it repeatedly.
- `codebase_index_status [project]` — node/edge counts, freshness, skipped and partially-parsed files, last run's logfile.
- `codebase_search_graph [...]` — the primary finder: definitions, implementations, relationships; pages with `limit`/`offset` until `has_more` is false.
- `codebase_query_graph [query] [maxRows]` — raw Cypher over the graph (multi-hop, aggregation, cross-service).
- `codebase_trace_path [...]` — callers/callees, value flow (`data_flow`), cross-service hops.
- `codebase_get_code_snippet [qualifiedName]` — source of one symbol.
- `codebase_get_graph_schema [project]` — node labels + edge types (Cypher vocabulary).
- `codebase_get_architecture [path] [aspects]` — packages/services/dependencies plus Leiden clusters over the call/import graph.
- `codebase_search_code [pattern] [...]` — grep-augmented, deduped into containing functions, ranked.
- `codebase_detect_changes [...]` — git diff mapped onto the graph: what a change touches.
- `codebase_manage_adr [...]` — read/write Architecture Decision Records.
- `codebase_ingest_traces [traces]` — fold `{caller, callee, count}` runtime traces into the graph.
- `codebase_delete_project [project]` — destructive; use only for superseded indexes.

## Why CLI over MCP

The MCP client row (`@deepseek-ai/dsh-mcp-client` with `command: codebase-memory-mcp`) keeps a long-lived stdio server running inside every session and exposes all tools verbatim with the `mcp__codebase__*` prefix. The CLI wrapper spawns per call and exits — nothing to recycle, nothing to crash, nothing warm in the session — with clean `codebase_*` names, tightened schemas, and per-preset configuration. Functionally identical: the `cli` mode executes through the same daemon. The MCP row can be kept around disabled as a zero-maintenance fallback.

## Configuration

```ts
ctx.plugin(toolCodebaseMemoryPackage, {
  cliPath: 'codebase-memory-mcp', // CLI executable (default: on PATH)
  project: 'deepseek-harness', // default project for tools that can omit it
  timeoutMs: 60000, // per-call process timeout (index calls use indexTimeoutMs)
  indexTimeoutMs: 600000, // timeout for codebase_index_repository
  maxChars: 200000, // cap on rendered JSON payload before explicit truncation
  enabled: true, // codebase:tools prompt section
})
```

Setting `project` makes every call explicit about its graph target while still allowing overrides. The plugin activation invariant fails fast with an install hint when the CLI is missing; verify at any time with `codebase-memory-mcp cli list_projects`.

## Model experience

- **Tool schemas.** Fourteen hand-authored `codebase_*` schemas encode the graph contract so the model prefers graph answers (`codebase_search_graph` / `codebase_trace_path` / `codebase_get_code_snippet`) over repeated grep/read cycles, pages with `limit`/`offset`, and indexes new repos before relying on answers. Fourteen static schemas are added once to the request prefix (~3–5 KB total), far smaller than streaming MCP schemas into every session.
- **Results.** Structured JSON payloads parsed out of the MCP result envelope — the model sees the same objects the MCP tools returned (e.g. `search_graph`'s `{total, results, has_more}` tree rows). Tool errors (`isError: true` in the envelope, exit 0 under `--json`) surface as `CodebaseMemoryCliError` with argv/exit code attached — never as fake success. Payloads are truncated only past the `maxChars` cap, with the CLI's own `limit`/`offset` paging as the primary cost control.
- **Prompt section.** One `codebase:tools` card: index before asking, prefer graph answers over repeated greps, page with `limit`/`offset`, use Cypher for what the curated tools cannot express, and remember `codebase_delete_project` is destructive.

## Known limitations

- The curated schemas are a hand-maintained mirror of the CLI's input schemas; a codebase-memory release that adds tools needs this package updated.
- `check_index_coverage` is declared by the binary's tool table but not dispatchable through `cli`, so it is intentionally not wrapped.
- There is no host-plane service or GUI surface; the binary ships its own graph visualizer at `localhost:9749`, and an in-GUI drawer is future work.

## Related pages

- [OpenWiki Engine (Fork Port)](openwiki.md) — the sibling evidence-wiki engine.
- [Tool Registry and Execution Pipeline](tools-pipeline.md) — how these tools register.
