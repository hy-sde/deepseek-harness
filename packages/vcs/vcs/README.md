---
description: "Read-only VCS plumbing for the harness: the ctx.vcs host service over the user-installed pi-vcs CLI, exposing gitoxide-backed diff, status, discovery, and watch surfaces byte-compatible with git and additive to the git service."
kind: "package-reference"
---

# @deepseek-ai/dsh-vcs

English | [中文](README.zh.md)

## Summary

`dsh-vcs` exposes `ctx.vcs`, a host-plane service over the user-installed `pi-vcs` CLI giving the harness narrow read-only VCS surfaces (rev, staged, and worktree diffs with `--name-only`/`--numstat` modes, status counts, branch name, repository discovery, a HEAD-change watch), every text surface byte-compatible with `git diff`. Choose it when a caller wants the native gitoxide slice without changing the default TS/git-CLI path: the service is purely additive and degrades to the git service when `pi-vcs` is unreachable. Its costs are feature detection and a per-call shell-out, with bounded output and binary patches rendered as markers only.

## Table of Contents

- [Additive and feature-detected](#additive-and-feature-detected)
- [The `pi-vcs` CLI](#the-pi-vcs-cli)
- [Executed commands](#executed-commands)
- [Security boundary](#security-boundary)
- [Configuration](#configuration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Native vcs plumbing for the DeepSeek Harness: `ctx.vcs`, a host-plane service over the `pi-vcs` CLI — the narrow native slice of the oh-my-pi vcs surface — via the `ctx.subprocess` seam. Modeled on `ctx.av`.

The service resolves the `pi-vcs` executable (config → `DSH_VCS_PATH` → PATH), probes it with `pi-vcs --version`, and exposes the narrow slice: changeless read surfaces over gitoxide — rev-diffs, staged diffs, worktree diffs, `--name-only`/`--numstat` modes, status summary counts, branch name, and repository discovery — plus a HEAD-change watch companion. Every text surface is byte-compatible with the corresponding `git diff` output, so existing diff parsers keep working.

## Additive and feature-detected

`ctx.vcs` is **purely additive** under the harness convention: the git service (`ctx.git`, TS/git-CLI) stays the default path and is unchanged. These surfaces resolve only when a `pi-vcs` binary is reachable and probing clean; `probe()` reports `available: false` otherwise, and callers degrade to the git service. No jj backend and no mutation verbs — those remain on the git service.

## The `pi-vcs` CLI

The CLI is **user-installed like `av`** — build it from `native/pi-vcs-cli/` in this repository (a Rust crate over gitoxide):

```sh
cargo build --release --manifest-path native/pi-vcs-cli/Cargo.toml
```

Install `native/pi-vcs-cli/target/release/pi-vcs-cli` as `pi-vcs` on PATH.

It is a faithful, MIT-attributed port of oh-my-pi's `crates/pi-vcs` git backend restricted to the narrow slice. Its diff renderer emits git-compatible unified text (verified byte-identical to `git diff` for text, binary, rename/copy, and staged surfaces).

## Executed commands

| Method | CLI invocation | Purpose |
|---|---|---|
| `probe` | `pi-vcs --version` | reachability + version, never throws |
| `repoInfo` | `pi-vcs repo-info <dir>` | repository discovery (JSON); `NotARepository` returns `null` |
| `revDiff` | `pi-vcs rev-diff <dir> <base> [<head>]` | git-compatible unified patch between revisions (`base`→worktree when `<head>` omitted) |
| `stagedDiff` | `pi-vcs staged-diff <dir>` | git-compatible unified staged patch |
| `worktreeDiff` | `pi-vcs worktree-diff <dir>` | git-compatible unified worktree patch (index vs worktree) |
| `diff` | `rev-diff`/`staged-diff`/`worktree-diff` + `--name-only`/`--numstat` | one surface for any range in any output mode |
| `changedFiles` | `--name-only` | changed paths, rename destination, git C-quoting |
| `numstat` | `--numstat` | raw added/removed/path rows for `parseNumstat` |
| `status` | `pi-vcs status <dir>` | staged/unstaged/untracked counts like `ctx.git.status` |
| `branch` | `pi-vcs repo-info <dir>` | current branch (undefined on detached HEAD) |
| `watch` | `pi-vcs watch <dir> [--interval-ms N]` | long-running JSON-lines HEAD-change companion |

All commands run through `ctx.subprocess` with bounded stdout/stderr collection, a wall-clock timeout, and SIGTERM→SIGKILL grace. A non-zero exit is returned as data on the run with a structured `code` (the VcsError taxonomy: `NotARepository`, `RefNotFound`, `ObjectNotFound`, `Backend`, `Unsupported`, …) parsed from the CLI's JSON stderr; only launch failure, signal kill, or timeout throws `VcsCommandError`. `watch` returns a disposer that terminates the process tree.

## Security boundary

- **Read-only slice** — `ctx.vcs` never mutates a repository: no commits, no staging, no ref writes. All verbs render existing state.
- No command is shell-interpreted; argv is passed verbatim through the subprocess seam.
- Discovery is a pure filesystem walk (no subprocess); gix opens with ambient `GIT_*` location overrides denied, binding every operation to the discovered repository.

## Configuration

```ts
import { Context } from '@deepseek-ai/cordis'
import vcsPackage from '@deepseek-ai/dsh-vcs'

const ctx = new Context()
ctx.plugin(vcsPackage, {
  vcsPath: '/usr/local/bin/pi-vcs',
  timeoutMs: 120000,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  graceMs: 5000,
  watchIntervalMs: 1000,
})
```

## Known Limitations and Deferred Work

- **Binary patches render as the marker only** — the `GIT binary patch` body machinery (delta/base85) is dropped; binary changes emit `Binary files … differ`, matching the harness diff parser's expectations.
- **Conflicted merged states** — during an in-progress merge, `git diff` switches to a combined (`diff --cc`) form; the native renderer matches omp by skipping conflict entries, so review of a conflicted tree best targets the staged/range surfaces. Status still reports `UU` exactly like git.
- **No jj backend** — the harness fork is git-only (`isPureJj=false`); jj-lib compiled into omp's native addons is not a callable binary and is deliberately out of scope.
- **Per-call shell-out** — no persistent native process for batch verbs; each call spawns `pi-vcs` and collects bounded output. `watch` is the one long-lived companion.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
