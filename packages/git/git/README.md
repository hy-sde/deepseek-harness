# @deepseek-ai/dsh-git

English | [中文](README.zh.md)

The host `ctx.git` service for the agentic commit + review workflow (ported from omp / oh-my-pi): a stateless, thin wrapper around the `git` CLI through the [`ctx.subprocess`](../../subprocess/subprocess/README.md) seam, plus the diff-parsing primitives and split-commit execution verbs the model-facing tools need. Intended to be consumed by [`@deepseek-ai/dsh-tool-git`](../tool-git/README.md), never by the model directly.

## What it does

Registers one host service on the composition (`ctx.git`). The surface:

- **Repository state** — `isRepo`, `root`, `branch`, `status`, `hasStaged`.
- **Diff reads** — `diffText`, `fileDiffs`, and a `diff` namespace with the derived read shapes (`changedFiles`, `numstat`, `has`). Diffs are captured with `--binary` so binary changes survive staging round-trips.
- **Staging** — `addAll` (`git add -A`), `resetIndex` (`git reset`), and `stageHunks`: slices a recorded `--cached` diff back onto the index by hunk selection (omp `stage.hunks` port).
- **Commit / push / log** — `commit` (message via stdin), `push` (`--no-follow-tags`), `log`.

The diff vocabulary lives in [`types.ts`](src/types.ts)` and `diff.ts` (numstat with rename handling, hunk parsing/selection/validation); the split machinery mirrors omp (topological commit ordering, lock-file autoplacement).

## Execution model

Every git invocation runs through `ctx.subprocess`: its own wall-clock timeout (`timeoutMs`, default 120s), a `SIGTERM→SIGKILL` grace (`graceMs`, default 5s), bounded collected stdout/stderr (`maxStdoutBytes`/`maxStderrBytes`), and an abort signal forwarded to the spawned process. A non-zero exit is returned as data on `run` for probe commands and thrown as a readable [`GitCommandError`](src/service.ts) for everything else.

## Partial-hunk staging

`stageHunks` rebuilds a patch from the recorded diff and applies it with `git apply --cached` **without** `--binary` for text patches: with `--binary`, a header carrying `index <old>..<new>` makes `git apply` find both blobs and stage the *whole* new blob, silently defeating hunk granularity. Binary-embedding patches still apply with `--binary`.

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
