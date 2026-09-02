---
description: "Model-facing commit, commit_apply, and review tools for the agentic git commit and review workflow, with read-preference routing between ctx.vcs and ctx.git."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-git

English | [中文](README.zh.md)

## Summary

The three model-facing tools — `commit`, `commit_apply`, and `review` — drive the agentic git commit and review workflow ported from omp (oh-my-pi). Reads route opportunistically through `ctx.vcs` when its `pi-vcs` probe is clean and fall back to `ctx.git`; mutation inputs always stay on `ctx.git`, so the write path is byte-for-byte unchanged. Choose this package when a composition wants the model to author deterministic split-commit plans and get bounded reviewer fan-out over the staged diff. The cost is one analysis call per commit plus reviewer fan-out capped by `maxReviewers` and `maxReviewerDiffChars`; the boundary is that commit-review quality stays the model's own negotiation — the tool surface enforces structure, not semantic judgment.

## Table of Contents

- [Read-preference routing](#read-preference-routing)
- [What it does](#what-it-does)
- [Two-phase contract](#two-phase-contract)
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
- **`commit_apply` (execute)** — validates a `SplitCommitPlan` against the actual staged state, then commits deterministically: every staged file planned exactly once, hunk selectors resolved against the real diff, groups ordered topologically (cycles rejected before any write), lock files auto-placed onto the group owning their sibling manifest. `dryRun: true` previews exact messages without committing; `cwd` selects the repository.
- **`review`** — slices the staged diff by weight across `maxReviewers` subagent runs with a structured reviewer contract, aggregates a `ship`/`reject` verdict from the minimum reviewer confidence, ranks findings by severity, and reports transport failures as errors (never silently approving unreviewed changes).

## Two-phase contract

The flow is intentionally model-driven but deterministic: `commit` returns ground truth plus a plan skeleton and guidance, the model authors a precise `SplitCommitPlan` (types, scopes, summaries, details, dependencies, optional hunk selections), and `commit_apply` validates and executes it without a hidden model session. Failures reset the index so no change is lost and every remaining edit stays inspectable in the worktree.

## Configuration

- `reviewProvider` — subagent provider id for reviewer fan-out (default `spawn`).
- `maxReviewers` — max parallel reviewer runs (default 4).
- `maxReviewerDiffChars` — per-reviewer diff window cap (default 25k).
- `maxDiffChars` — analysis diff cap (default 60k).

The agent preset rows in this deployment mount `reviewProvider: spawn` and `maxReviewers: 4`.

## Export shape

A function/namespace plugin exporting `name` / `inject` / `apply` with no default export (a stray default would collapse the module via the Loader's `unwrapExports`). Helpers and types (`resolveCwd`, `toPriority`, `sliceByWeight`, `gitDiffSection`, `buildReviewerPrompt`, `SliceResult`, `ReviewerFinding`, common commit types) re-export from `/commit` and `/review` for tests and other consumers.

## Model Experience

### Tool schema

#### What the model sees

The generated [`commit`, `commit_apply`, and `review` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-git), plus the `git:` section in the system prompt.

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
