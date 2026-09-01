---
type: "Reference"
title: "Session Data Plane: Persistence, Projections, Retrieval"
openwiki_generated: true
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-df946fed21b4b34eb373dc40
    resource: repo://packages/session-query/README.md
  - id: openwiki-source-97745b7a2d51482174f60766
    resource: repo://packages/session/README.md
  - id: openwiki-source-c7ae11d3c642a53f3eeeb309
    resource: repo://packages/session/session-persistence-jsonl/README.md
  - id: openwiki-source-36c59463c0bf978f15e7bf9d
    resource: repo://packages/session/session-projection/README.md
  - id: openwiki-source-51b44e6ccff3c46c41e0e41e
    resource: repo://packages/session/session-title/README.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---


# Session Data Plane: Persistence, Projections, Retrieval

The session group makes an agent's conversation durable and reusable outside the live loop: the persistence seam stores the event log and restores it on resume, the checkpoint policy keeps requests, tool side effects, and completed steps durable before the next action, projections serve whole log-derived values to client carriers, titles name each session from its content, and telemetry reports session activity outbound. Pick a persistence backend first — JSONL is the shipped default, SQLite an opt-in single-database backend — then add the checkpoint policy and any projection, title, or telemetry packages the deployment needs. `session-query/` is a sibling group whose read/tool surface consumes persistence independently.

## Persistence

| Package | Role | ctx key |
| --- | --- | --- |
| `session-persistence/` | Defines the durable session-storage service and the shared write coordination every backend composes | `ctx.sessionPersistence` |
| `session-persistence-jsonl/` | Shipped backend: one append-only JSONL log per session, optionally Zstandard-compressed | registers on `ctx.sessionPersistence` |
| `session-persistence-sqlite/` | Opt-in backend: every session's log in one SQLite database with packed physical rows | registers on `ctx.sessionPersistence` |
| `session-checkpoint-policy/` | Makes model requests, top-level tool side effects, and completed steps durable before the next action | wraps `ctx.llm` and `ctx.tools` |
| `session-log-deepseek/` | Uploads the incremental canonical log as optional official DeepSeek request metadata | contributes `dsh_session_log` |

`dsh-session-persistence-jsonl` stores each session in its own append-only JSONL log — checksummed Zstandard frames by default, raw newline-delimited lines when compression is disabled. It serves the same logical `SessionEvent` stream as any persistence backend, so choosing it changes nothing for the agent loop, the model, or replay; compression, packing, and crash recovery are storage-internal details. `locate(meta)` returns the transcript path, and the logs are readable as plain lines when `compression: 'none'` is selected. A root directory is the one required configuration; durability, lazy materialization, and interrupted-turn recovery come with the backend.

## Projection

Projections serve whole current values of log-derived per-session state to client carriers — the history tail page and the `session/projection` push frame — through a registry (`ctx.sessionProjections`) that folds every committed session event through registered projection units. A domain registers a pure computation unit (initial state, a fold over events, and an optional client view); the framework owns the subscription, the drive, and change notification. Every served value is plain JSON validated against a schema, and a per-unit `stateVersion` anchors persisted-cache invalidation. `session-projection-cache` persists projection checkpoints so cold reads skip full log loads, and `session-stats` serves whole-log conversation counts and wall times through the `sessionStats` unit.

## Titles

`dsh-session-title` gives every session a title clients can display: a deterministic fallback from the first eligible human message, an optional asynchronous provider (such as a model-backed one), or an explicit user rename. Every accepted revision is a log-only `session/title` event, so titles survive replay, resume, and paging exactly like any other session event and never enter the model surface. The service owns scheduling and acceptance; the optional provider owns generation; automatic work never delays the main agent response. Provider packages include `session-title-first-prompt-llm` (titles from the first eligible human message) and `session-title-all-prompts-llm` (all eligible human messages).

## Retrieval: session-query

The `session-query/` group provides retrieval over live and durable session history, independent of compaction: programmatic callers query one unified service for exact logs, filtered lists, relationship traces, and full-text search; a SQLite backend (FTS5 index) powers the search; the model gets five workspace-authorized tools; and the Web UI gets an `/export` command that downloads a session ZIP. Search results agree with the conversation history the model sees.

## Related pages

- [Event Domains and Lifecycle Events](../architecture/events.md) — the event vocabulary that is being persisted.
- [Session, Step and Turn Lifecycle](../architecture/turn-flow.md) — how the log is written and read.
