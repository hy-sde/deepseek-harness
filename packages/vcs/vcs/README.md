# @deepseek-ai/dsh-vcs

English | [中文](README.zh.md)

Native vcs plumbing for the DeepSeek Harness: `ctx.vcs`, a host-plane service over the `pi-vcs` CLI — the narrow native slice of the oh-my-pi vcs surface — via the `ctx.subprocess` seam. Modeled on `ctx.av`.

The service resolves the `pi-vcs` executable (config → `DSH_VCS_PATH` → PATH), probes it with `pi-vcs --version`, and exposes the narrow slice: git rev-diffs and staged diffs rendered **in-process by gitoxide** (git-compatible unified patch text, byte-compatible with the git service's rendering), repository discovery, and a HEAD-change watch companion.

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
| `revDiff` | `pi-vcs rev-diff <dir> <base> [<head>]` | git-compatible unified patch between revisions |
| `stagedDiff` | `pi-vcs staged-diff <dir>` | git-compatible unified staged patch |
| `watch` | `pi-vcs watch <dir> [--interval-ms N]` | long-running JSON-lines HEAD-change companion |

All commands run through `ctx.subprocess` with bounded stdout/stderr collection, a wall-clock timeout, and SIGTERM→SIGKILL grace. A non-zero exit is returned as data on the run with a structured `code` (the VcsError taxonomy: `NotARepository`, `RefNotFound`, `ObjectNotFound`, `Backend`, `Unsupported`, …) parsed from the CLI's JSON stderr; only launch failure, signal kill, or timeout throws `VcsCommandError`. `watch` returns a disposer that terminates the process tree.

## Security boundary

- **Read-only slice** — `ctx.vcs` never mutates a repository: no commits, no staging, no ref writes. All verbs render existing state.
- No command is shell-interpreted; argv is passed verbatim through the subprocess seam.
- Discovery is a pure filesystem walk (no subprocess); gix opens with ambient `GIT_*` location overrides denied, binding every operation to the discovered repository.

## Configuration

```ts
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
- **Worktree diffs stay on the git service** — `pi-vcs` covers revisions and the index; uncommitted worktree diffs still route through `ctx.git`.
- **No jj backend** — the harness fork is git-only (`isPureJj=false`); jj-lib compiled into omp's native addons is not a callable binary and is deliberately out of scope.
- **Per-call shell-out** — no persistent native process for batch verbs; each call spawns `pi-vcs` and collects bounded output. `watch` is the one long-lived companion.
