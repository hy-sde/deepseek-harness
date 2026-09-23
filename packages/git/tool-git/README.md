---
description: "Model-facing commit, commit_apply, and review tools for the agentic git commit and review workflow, plus the worktree pool tool (durable-lease isolated worktrees), with read-preference routing between ctx.vcs and ctx.git."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-git

English | [中文](README.zh.md)

## Summary

`commit`, `commit_apply`, and `review` drive the agentic git commit and review workflow, and `worktree` provides a model-facing worktree pool with durable leases so parallel tasks get isolated, restart-proof working directories. Reads route through `ctx.vcs` when its `pi-vcs` probe is clean, else `ctx.git`; mutations always stay on `ctx.git`, so the write path is unchanged. Choose it when a composition wants the model to author deterministic split-commit plans and get bounded reviewer fan-out over the staged diff. The cost is one analysis call per commit plus capped reviewer fan-out; review quality stays the model's own negotiation.

## Table of Contents

- [Read-preference routing](#read-preference-routing)
- [What it does](#what-it-does)
- [Two-phase contract](#two-phase-contract)
- [Worktree tool](#worktree-tool)
- [Configuration](#configuration)
- [Export shape](#export-shape)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

The model-facing `commit`, `commit_apply`, and `review` tools — the agentic git commit + review workflow, ported from omp (oh-my-pi). The underlying host service is [`@deepseek-ai/dsh-git`](../git/README.md) (`ctx.git`).

## Read-preference routing

Every `commit` analysis and `review` **read** (repository check, changed files, status counts, numstat, diff text, branch) resolves through [`@deepseek-ai/dsh-vcs`](../../vcs/vcs/README.md) (`ctx.vcs`) when the host bundle registered it and its `pi-vcs` probe is clean — resolved opportunistically per call, one probe per tool execution — and falls back to `ctx.git` otherwise. **Mutation inputs stay on `ctx.git`** (`addAll` auto-staging, `commit_apply`'s raw staged diff feeding `stageHunks`), so the write path is byte-for-byte unchanged. The facade lives in `./reads.ts` (`openReads` → `ReadSurface`), which tests exercise through a fake `pi-vcs` shim next to a real temp repo (reads hit the vcs verbs, the auto-stage still hits git).


## What it does

Registers three tools on `ctx.tools`, a `git:` system-prompt section with the commit/review negotiation grammar, and an inject on `ctx.git`:

- **`commit` (analyze, read-only)** — snapshots the staged diff (auto-staging the working tree when nothing is staged and `stagedOnly: false`), reports per-file add/delete counts, a bounded diff, `trivial` classification, `lockFilesPending`, and a `suggestedPlan` skeleton. It never writes to the repository.
- **`commit_apply` (execute)** — validates a `SplitCommitPlan` against the actual staged state, then commits deterministically: every staged file planned exactly once, hunk selectors resolved against the real diff, groups ordered topologically (cycles rejected before any write), lock files auto-placed onto the group owning their sibling manifest. `dryRun: true` previews exact messages without committing; `cwd` selects the repository. `push: true` pushes the current branch to `origin` and records upstream (`git push --set-upstream origin <branch>`) so PR tooling can consume it; a detached HEAD (the default worktree slot) fails with guidance toward `worktree acquire --branch` — that named-branch pairing is the ship path. When [`@deepseek-ai/dsh-orchestration-policy`](../../orchestration/policy/README.md) is mounted with its `reviewGate` active, a push additionally requires a current `ship` verdict from `review --target staged` over the exact same staged range (identity = pre-commit HEAD + index tree) — otherwise `commit_apply --push` is refused with the fix; verdicts are recorded per repository by the `review` tool and live only in the host process.
- **`review`** — slices the staged diff by weight across `maxReviewers` subagent runs with a structured reviewer contract, aggregates a `ship`/`reject` verdict from the minimum reviewer confidence, ranks findings by severity, and reports transport failures as errors (never silently approving unreviewed changes).
- **`worktree`** — the pool manager: `acquire` cuts or reuses an isolated git worktree (`--branch` for a named-branch HEAD that `commit_apply --push`/PR flows need) and returns a durable `leaseId`; `release` returns the slot (conditional on the exact lease id; refuses dirty work unless `force`); `list` shows live pool status; `prune` and `destroy` are dry-runs until `yes` and never touch leased or dirty slots automatically. See [Worktree tool](#worktree-tool).

## Two-phase contract

The flow is intentionally model-driven but deterministic: `commit` returns ground truth plus a plan skeleton and guidance, the model authors a precise `SplitCommitPlan` (types, scopes, summaries, details, dependencies, optional hunk selections), and `commit_apply` validates and executes it without a hidden model session. Failures reset the index so no change is lost and every remaining edit stays inspectable in the worktree.

## Worktree tool

`worktree` maps the treehouse CLI verb surface (acquire/release/list/prune/destroy) onto the pool engine in [`@deepseek-ai/dsh-git`](../git/README.md#worktree-pool) (`./worktree`):

- **`acquire`** — fetches (unless `noFetch`), then reuses a slot only when provably idle (unleased, clean including untracked, HEAD merged into the exact reset target) or cuts a new one at the default/inferred base branch. Returns `path` + `leaseId` + holder/base — the durable ownership record. `branch` cuts a named-branch HEAD (the `commit_apply --push` path — `--push` records `origin/<branch>` upstream, so a PR flow can pick it up); `base` overrides the cut point.
- **`release`** — requires the exact `leaseId` (a stale caller can never release someone else's slot), parks the slot detached at its base for reuse, and refuses dirty work unless `force` (then `git clean -fdqx`).
- **`list`** — live pool status per slot: `leased` / `idle` / `damaged` with clean/merged/exists flags and holder.
- **`prune`** — dry-run by default; `yes` removes only unleased + clean + merged slots (`all` sweeps every pool under the configured root). Everything else is reported, never guessed.
- **`destroy`** — dry-run by default; `includeLeased` / `includeUnlanded` are the explicit overrides for the irreversible cases.

Why leases and not processes: DSH agents are host children, so a durable lease in `treehouse-state.json` — not a PID scan — is what survives a host restart, and the engine never terminates processes. Pool root is configurable (`worktreeRoot`, default `~/.treehouse`) so each workspace or machine can choose its own home for the pools.

## Configuration

- `reviewProvider` — subagent provider id for reviewer fan-out (default `spawn`).
- `maxReviewers` — max parallel reviewer runs (default 4).
- `maxReviewerDiffChars` — per-reviewer diff window cap (default 25k).
- `maxDiffChars` — analysis diff cap (default 60k).
- `worktreeRoot` — pool root directory for `worktree` (default `~/.treehouse`).
- `worktreeBaseBranch` — default cut branch for `worktree acquire` (default: inferred from origin HEAD / current branch).
- `worktreeFetchBeforeAcquire` — fetch origin before acquiring (default true; skipped when the repo has no origin).
- `worktreeLockWaitMs` — max wait for the pool-state lock (default 30s).
- `worktreeMaxSlots` — cap on total pooled worktrees per repository (default 0 = unlimited; reuse of a provably idle slot is still allowed at the cap, only cutting a new slot is refused).

The agent preset rows in this deployment mount `reviewProvider: spawn` and `maxReviewers: 4`.

## Export shape

A function/namespace plugin exporting `name` / `inject` / `apply` with no default export (a stray default would collapse the module via the Loader's `unwrapExports`). Helpers and types (`resolveCwd`, `toPriority`, `sliceByWeight`, `gitDiffSection`, `buildReviewerPrompt`, `SliceResult`, `ReviewerFinding`, common commit types) re-export from `/commit` and `/review` for tests and other consumers.

## Model Experience

### Tool schema

#### What the model sees

The generated [`commit`, `commit_apply`, `review`, and `worktree` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-git), plus the `git:` section in the system prompt.

#### Token effect

Fixed schema cost per request while the tools are visible. `commit` returns a bounded diff (capped by `maxDiffChars`); reviewer prompts carry bounded diff windows (`maxReviewerDiffChars`) so fan-out context does not grow without limit.

#### KV Cache effect

Prefix-stable while the tool definitions, `git:` prompt section, and configured budgets are unchanged. `commit_apply` and `review` results append after the reusable request prefix without invalidating earlier entries.

### Tool-call history and result

#### What the model sees

Each `commit` call retains its analysis (files, diff, plan skeleton) in the call arguments. `commit_apply` returns `{ mode, created: [{ hash, message, changes }], messages, warnings }` — deterministic, small, and replay-authoritative. `review` returns verdict, ranked findings, confidence, files, and errors as compact JSON. Stable failures are thrown before any write with readable messages: `Split commit plan missing staged files: <...>`, `Split commit plan assigns files to multiple groups: <...>`, `Invalid hunk selections: …`, `Circular dependency…`, and `nothing is staged; run `commit`…` for an empty index.

#### Token effect

Token growth scales with the diff and with `commit_apply`'s `created` list; each is bounded by the caps above. Reviewer findings are summarized, not echoed.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **No hidden model session inside the tools** — commit review quality is the model's own negotiation; the tool surface enforces structure, not semantic judgment of summaries.
- **Coverage is file-granular, hunks are optional** — the plan must plan every staged file once; hunk selectors refine *within* a file but do not relax coverage.
- **Lock files are auto-placed, not planable** — they never appear in the skeleton; `commit_apply` decides their group from the owning manifest.
- **`review` treats unreviewed as reject** — a reviewer transport failure (or an empty slice) refuses approval rather than guessing.
- **No force-push, no amend, no rebase verbs** — the service surface is the commit/review subset; editors and interactive history rewriting remain outside.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
