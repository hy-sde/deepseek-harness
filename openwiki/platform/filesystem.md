---
type: Reference
title: Filesystem Capability Family
description: The filesystem package group of DeepSeek Harness — the ctx.fs provider contract, local and sandbox-enforcing backends, the read-before-edit policy, the model-facing file and search tools, and the archive engine.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-956f6374461e5f9812cb8529
    resource: repo://docs/subsystems/filesystem.md
  - id: openwiki-source-e7e216015fa1230cdb000ce4
    resource: repo://packages/fs/fs-archive/README.md
  - id: openwiki-source-0edee7a3db0357055ec26381
    resource: repo://packages/fs/fs/README.md
  - id: openwiki-source-4e396c9d0a5dac310f29a82e
    resource: repo://packages/fs/README.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# Filesystem Capability Family

The `fs/` group gives agents durable, policy-governed access to files: the `ctx.fs` service contract in `fs/`, the host-filesystem and sandbox-enforcing backends in `fs-local/` and `fs-sandbox/`, the read-before-edit policy in `fs-observation-policy/`, and the model-facing tools in `tool-fs/` (`read`, `read_image`, `write`, `edit`) and `tool-fs-search/` (`glob`, `grep`). A deployment mounts one backend, loads the policy for freshness-guarded mutations, and registers the tool packages the model should see; backends swap without touching the tools or the policy. File I/O takes no timeout by design: a deadline would kill work the OS still finishes, so cancellation is a best-effort signal at syscall boundaries.

## Packages

| Package | Role | ctx key |
| --- | --- | --- |
| `fs/` | `ctx.fs` service contract: execution-world paths, bounded text I/O, atomic mutations with an optional version guard | `ctx.fs` |
| `fs-local/` | Host-filesystem backend: reads, writes, and edits real files on the local machine | registers on `ctx.fs` |
| `fs-sandbox/` | Sandbox-enforcing backend: fences writes and edits by the per-call sandbox mode while reads pass through | registers on `ctx.fs` |
| `e2b/fs-e2b` | E2B-backed backend: file state lives in the remote execution world shared with the E2B subprocess provider | registers on `ctx.fs` |
| `fs-observation-policy/` | Read-before-edit policy: records observed presence or absence and guards write/edit through the `fs/*` events | `fs/*` listeners |
| `tool-fs/` | Model-facing `read`, `read_image`, `write`, and `edit` tools plus their executor | registers on `ctx.tools` |
| `tool-fs-search/` | Model-facing `glob` and `grep` discovery tools backed by the packaged ripgrep binary | registers on `ctx.tools` |

## The service contract

`dsh-fs` defines the `ctx.fs` filesystem service: a compact, backend-neutral contract for one execution world that resolves paths to stable identities, maps shared host files when supported, reads text and raw bytes within bounds, lists directories, and applies atomic writes and literal edits. Both mutations take an optional version guard: omit it for unconditional create-or-overwrite, or supply it to fail when the file changed since last observed. Every operation returns data or a typed `FsError` carrying a stable code such as `FS_NOT_FOUND`, `FS_STALE_VERSION`, or `FS_AMBIGUOUS_EDIT`, so callers branch on the code, never on message text. Text reads are bounded by line window, byte cap, and backend limits, and a stat returns metadata (never content), so consumers choose `readText` vs `streamText` from `size` without probing by failure.

## The policy plugin

`dsh-fs-observation-policy` is optional but expected: without it, the `FileSystem` Service Definition, a provider, and the `tool-fs` Consumer form the complete, unconstrained filesystem seam — `write` unconditionally creates or overwrites, and `edit` unconditionally replaces literal text. The policy plugin changes these operations by deciding the `fs/*` waterfalls. Removing it does not break the tool, because the tool calls `ctx.fs` and dispatches events; it does not call policy methods. The policy is a plugin, not a service the tools inject.

Three events form the vocabulary. `fs/write-intent` and `fs/edit-intent` are **single-slot decision waterfalls**: the tool dispatches each with a default thunk returning `undefined` (the bare provider), and a listener fully decides without calling `next()`. `fs/observed` is a fire-and-forget recording event carrying an `FsObservation` — present at a version or confirmed absent; its listener MUST be synchronous and side-effect-only, because the tool does NOT guard the emit.

## Read rendering and authorization

The result the model-facing `read` tool renders is purely presentational; there is no `full`/`partial` view. Authorization is freshness-based: the tool emits a present `fs/observed` directly with the stat's version, so any windowed read can authorize a later write/edit when the file is unchanged. A metadata miss emits an absent observation before the tool returns `FS_NOT_FOUND`, allowing a later guarded write to recreate an externally deleted target without authorizing edit.

## Search and archives

`tool-fs-search` provides `glob` and `grep` as unconditional discovery tools that spawn the packaged ripgrep binary (`@vscode/ripgrep`) through `ctx.subprocess` as ordinary foreground calls — no host `rg` install and no shell layer. Search deliberately does not extend the provider contract: filesystem backends stay free of a universal search API.

`fs-archive` is a pure-TS multi-format archive engine — zip, tar, tar.gz, rar, 7z, iso, deb, rpm, cpio, cab, arj, asar — plus the codec layer behind them. It is the durable core of the `read` tool's multi-format support: `foo.zip` lists an archive's root, `foo.zip:dir` lists a directory, and `foo.zip:dir/file.txt` reads one member as text. Format detection sniffs content signatures and falls back to extension inference, and member reads are bounded by `ArchiveLimits` so attacker-controlled archives cannot drive unbounded allocation.

## Related pages

- [Capability Seams](../architecture/seams.md) — the seam pattern behind `ctx.fs`.
- [Sandbox, Subprocess and Terminal Execution](sandbox-execution.md) — the shared execution world.
- [Tool Registry and Execution Pipeline](tools-pipeline.md) — how the file tools execute.
