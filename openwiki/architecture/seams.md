---
type: Reference
title: Capability Seams
description: The seam pattern of DeepSeek Harness — a swappable capability with a Service Definition, Service Provider and Consumer — and the seams that let a single provider swap change the whole product.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-115b2dad781e2a2c5b5a980d
    resource: repo://docs/architecture.md
  - id: openwiki-source-ef0554d6880aea39b799bda2
    resource: repo://docs/capability-seams.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# Capability Seams

A **seam** is a swappable capability with three roles: a **Service Definition** declaring the interface, a **Service Provider** implementing it, and a **Consumer** using it — commonly a model-facing tool. A package may combine roles, but one role alone is not a seam; adding a capability means designing all three. Seams are why one provider swap changes the whole product. Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks. Subagent providers vary just as widely behind one interface.

## The three roles

- **Service Definition** — the package owning the `ctx.<key>` interface declaration (for example `ctx.llm` in `llm`, `ctx.subprocess` in `subprocess`, `ctx.fs` in `fs`).
- **Service Provider** — the package that registers an implementation on the seam (for example `llm-pi-ai`, `subprocess-local`, `fs-local`, `sandbox-local`). A seam may have several providers registered side by side.
- **Consumer** — the package that uses the interface, commonly a model-facing tool (for example `tool-bash`, `tool-fs`, `tool-subagent`).

A service can also be a core spine service (such as `ctx.sessions` or `ctx.tools`) or a bundle/composition point (`ctx.agentLoop`); the generated capability graph marks every service with its role.

## Example seams

| Seam | Owner | Providers | Direct consumers |
| --- | --- | --- | --- |
| `ctx.llm` | `llm` | `llm-deepseek`, `llm-pi-ai`, `llm-replay` | `agent-loop`, `compaction-basic` |
| `ctx.subprocess` | `subprocess` | `subprocess-local`, `subprocess-e2b` | `bash-local`, `bash-sandbox`, `terminal-bash`, `lsp-stdio`, `subagent-acp`, `subagent-codex`, `subagent-claude-code` |
| `ctx.shell` | `shell` | `bash-local`, `bash-sandbox`, `pwsh-local` | `tool-bash`, `tool-pwsh`, `hooks-claude-code`, `hooks-codex` |
| `ctx.fs` | `fs` | `fs-local`, `fs-sandbox`, `fs-e2b` | `tool-fs` (plus `fs-observation-policy` via the `fs/*` event gate) |
| `ctx.sandbox` | `sandbox` | `sandbox-local` | `bash-sandbox`, `terminal-bash` |
| `ctx.subagents` | `subagent` | `subagent-spawn-in-process`, `subagent-fork-in-process`, `subagent-acp`, `subagent-codex`, `subagent-claude-code`, `subagent-dsh-sdk` | `tool-subagent`, `tool-subagent-control`, `tool-ralph` |
| `ctx.web` | `web` | `web-search-public`, `web-fetch-http` | `tool-web` |
| `ctx.sessionPersistence` | `session-persistence` | `session-persistence-jsonl`, `session-persistence-sqlite` | `agent-loop`, `tool-bash`, `session-query` |

## Why provider swaps move the whole product

Because consumers depend only on the interface, one provider swap changes every model-facing surface that consumes the seam:

- **Execution world.** The filesystem and subprocess providers share one execution world; pointing subprocess and filesystem at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks and no consumer changes.
- **Shell.** The model-facing shell tools and hook bridges consume `ctx.shell`; sandboxed, remote, or PowerShell executors replace `bash-local` without touching them.
- **Subagents.** One `ctx.subagents` interface covers transports from a fresh child agent to a delegated turn in another product; providers implement the transport, while `tool-subagent` selects one-shot or continuable delegation.
- **Persistence.** Backends persist the same `SessionEvent` vocabulary; applications choose a JSONL or SQLite backend at composition time.
- **Filesystem policy.** `tool-fs` executes read/write/edit through `ctx.fs`; `fs-sandbox` fences mutations by the shared sandbox mode, and `fs-observation-policy` contributes observed-state checks through the `fs/*` event gate.

## Core spine services are not seams

A service with only the interface role — such as `ctx.sessions` (the in-memory session store and durable event feed), `ctx.tools` (the tool registry and guarded execution pipeline), or `ctx.agents` (live Agent handles) — is a core spine service rather than a swappable seam. The generated capability graph labels each service as `seam`, `core`, or `bundle` so the distinction is explicit.

## Related pages

- [Plugin Architecture and Composition](overview.md) — how seams and services are composed into profiles.
- [LLM Capability Family](../platform/llm.md) — the `ctx.llm` seam in detail.
- [Sandbox, Subprocess and Terminal Execution](../platform/sandbox-execution.md) — the execution-world seams in detail.
