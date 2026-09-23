---
description: "Host ctx.git service for the agentic commit and review workflow: stateless git-CLI wrappers over ctx.subprocess, diff-parsing primitives, and split-commit execution verbs."
kind: "package-reference"
---

# @deepseek-ai/dsh-git

English | [中文](README.zh.md)

## Summary

The host `ctx.git` service gives the agentic commit and review workflow a stateless wrapper around the `git` CLI through the `ctx.subprocess` seam, plus the diff-parsing primitives and split-commit execution verbs the model-facing tools need. It reads repository state and captured diffs, slices recorded `--cached` diffs back onto the index by hunk selection, and commits, pushes, and logs through the same bounded subprocess path. Choose it when a composition needs git plumbing for `@deepseek-ai/dsh-tool-git`; the model never consumes it directly. The boundary is the commit/review subset, with no interactive history rewriting or credential plumbing.

## Table of Contents

- [What it does](#what-it-does)
- [Execution model](#execution-model)
- [Partial-hunk staging](#partial-hunk-staging)
- [Worktree pool](#worktree-pool)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

The host `ctx.git` service for the agentic commit + review workflow (ported from omp / oh-my-pi): a stateless, thin wrapper around the `git` CLI through the [`ctx.subprocess`](../../subprocess/subprocess/README.md) seam, plus the diff-parsing primitives and split-commit execution verbs the model-facing tools need. Intended to be consumed by [`@deepseek-ai/dsh-tool-git`](../tool-git/README.md), never by the model directly.

## What it does

Registers one host service on the composition (`ctx.git`). The surface:

- **Repository state** — `isRepo`, `root`, `branch`, `status`, `hasStaged`.
- **Diff reads** — `diffText`, `fileDiffs`, and a `diff` namespace with the derived read shapes (`changedFiles`, `numstat`, `has`). Diffs are captured with `--binary` so binary changes survive staging round-trips.
- **Staging** — `addAll` (`git add -A`), `resetIndex` (`git reset`), and `stageHunks`: slices a recorded `--cached` diff back onto the index by hunk selection (omp `stage.hunks` port).
- **Commit / push / log** — `commit` (message via stdin), `push` (`--no-follow-tags`; optional `remote`/`branch`/`setUpstream` so a fresh named branch can record `origin/<branch>` tracking), `log`.

The `./worktree` subpath additionally exposes a **worktree pool with durable leases** — the firstmate/treehouse `get --lease` model natively in TypeScript (per-repository pool of isolated worktrees under a configurable root, default `~/.treehouse`, with restart-proof lease ownership, dry-run prune/destroy and corrupt-state recovery). See [Worktree pool](#worktree-pool).

The diff vocabulary lives in [`types.ts`](src/types.ts)` and `diff.ts` (numstat with rename handling, hunk parsing/selection/validation); the split machinery mirrors omp (topological commit ordering, lock-file autoplacement).

## Execution model

Every git invocation runs through `ctx.subprocess`: its own wall-clock timeout (`timeoutMs`, default 120s), a `SIGTERM→SIGKILL` grace (`graceMs`, default 5s), bounded collected stdout/stderr (`maxStdoutBytes`/`maxStderrBytes`), and an abort signal forwarded to the spawned process. A non-zero exit is returned as data on `run` for probe commands and thrown as a readable [`GitCommandError`](src/service.ts) for everything else.

## Partial-hunk staging

`stageHunks` rebuilds a patch from the recorded diff and applies it with `git apply --cached` **without** `--binary` for text patches: with `--binary`, a header carrying `index <old>..<new>` makes `git apply` find both blobs and stage the *whole* new blob, silently defeating hunk granularity. Binary-embedding patches still apply with `--binary`.

## Worktree pool

`import { acquireWorktree, releaseWorktree, listWorktrees, pruneWorktrees, destroyWorktree } from '@deepseek-ai/dsh-git/worktree'` — a per-repository pool of `git` worktrees modeled on treehouse (`get --lease`):

- **Pool layout** — `<root>/<repo>-<hash6>/<n>/<repo>` where `root` is configurable (`~/.treehouse` default) and the hash is sha256 over the canonical primary root (linked worktrees resolve to the main checkout via `--git-common-dir`, so one repository = one pool even after `realpath` differences).
- **Durable leases** — `acquireWorktree` returns a `path` + random `leaseId` persisted in a per-pool `treehouse-state.json` (atomic temp+rename commits, cross-process `withFileLock`, in-process `withRepoLock` on the primary root); a leased slot is never handed out or pruned until `releaseWorktree` clears it with the matching id.
- **Safety** — reuse only when unleased + clean (`--untracked-files=all`) + HEAD already merged into the exact reset target; release refuses dirty unless `force` (`git clean -fdqx`); prune/destroy are dry-runs and refuse leased/dirty/unmerged slots without the explicit flags; corrupt/truncated state is rebuilt from `git worktree list --porcelain` as leased-unverified.
- **Named branches (D1)** — `acquireWorktree({ branch })` cuts `git worktree add -b <branch>` so `commit_apply --push`/PR flows have a branch HEAD (git rejects `--detach -b`); the slot is reusable only for the same branch name. Default remains detached (treehouse-compatible).

Ownership is recorded per lease in the state file (holder label), not by PID: DSH children are host processes, so a restart-proof lease — not a process scan — is the ownership record. This engine never terminates processes. See `firstmate-worktree-scope.md` (workspace) for the full design record, deviations D1–D5, and safety invariants.

## Configuration

- `gitPath` — executable name (default `git`), resolved through the subprocess seam.
- `timeoutMs`, `guarded` by the cap above — per-command wall-clock budget.
- `maxStdoutBytes`, `maxStderrBytes` — collection caps.
- `graceMs` — process-tree termination grace.

## Model Experience

Indirectly, through Consumers (`@deepseek-ai/dsh-tool-git` owns the `commit`/`commit_apply`/`review` schemas, the `git:` prompt section, and result rendering).

#### KV Cache effect

No direct invalidation; the named consumers own any request-prefix changes.

## Known Limitations and Deferred Work

- **Commit/review subset only** — no interactive rebase, amend, stash, bisect, or submodule verbs; editors and interactive history rewriting stay outside this seam.
- **Per-call shell-out** — no persistent git daemon or in-process index cache; each verb spawns `git` and collects bounded output.
- **No credential/store plumbing** — the service assumes ambient git auth (SSH agent, credential helper) and does not manage remotes, secrets, or signing keys.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
