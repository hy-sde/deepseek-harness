---
description: "Model-facing commit, commit_apply, and review tools for the agentic git commit and review workflow, plus the worktree pool tool (durable-lease isolated worktrees), with read-preference routing between ctx.vcs and ctx.git."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-git

English | [中文](README.zh.md)

## Summary

`commit`, `commit_apply`, and `review` drive the agentic git commit and review workflow, and `worktree` provides a model-facing worktree pool with durable leases for isolated, restart-proof task directories. Reads route through `ctx.vcs` when its `pi-vcs` probe is clean, else `ctx.git`; mutations always stay on `ctx.git`, so the write path is unchanged. Choose it when a composition wants the model to author deterministic split-commit plans and get bounded reviewer fan-out over the staged diff plus delta-only re-reviews that close prior findings. The cost is one analysis call per commit plus capped reviewer fan-out; review quality stays the model's own negotiation.

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
- **`commit_apply` (execute)** — validates a `SplitCommitPlan` against the actual staged state, then commits deterministically: every staged file planned exactly once, hunk selectors resolved against the real diff, groups ordered topologically (cycles rejected before any write), lock files auto-placed onto the group owning their sibling manifest. `dryRun: true` previews exact messages without committing; `cwd` selects the repository. `push: true` pushes the current branch to `origin` and records upstream (`git push --set-upstream origin <branch>`) so PR tooling can consume it; a detached HEAD (the default worktree slot) fails with guidance toward `worktree acquire --branch` — that named-branch pairing is the ship path. When [`@deepseek-ai/dsh-orchestration-policy`](../../orchestration/policy/README.md) is mounted with its `reviewGate` active, a push additionally requires a current `ship` verdict from `review --target staged` over the exact same staged range (identity = pre-commit HEAD + index tree) — otherwise `commit_apply --push` is refused with the fix; verdicts are recorded per repository by the `review` tool — an in-process staged-verdict record mirrored into the on-disk findings ledger under `<git-common-dir>/dsh-review/` under a `gate:<target>` key, so the gate survives process restarts, and a stored verdict applies only while its identity (pre-commit HEAD + index tree) still matches, with any mismatch recomputing fail-closed. Every `commit_apply` commit is also checked against its staged baseline: a deficit (staged content that did not survive the commit — the signature of a silently failed pre-commit-hook restore) throws a typed `CommitBoundaryError` after writing a `refs/recovery/pre-commit-<old-head>` recovery ref, while a surplus (a hook legitimately adding content, e.g. lefthook's `stage_fixed: true`) is tolerated with a warning.
- **`review`** — slices the staged diff by weight across `maxReviewers` subagent runs with a structured reviewer contract, aggregates a `ship`/`reject` verdict from the minimum reviewer confidence, ranks findings by severity, and reports transport failures as errors (never silently approving unreviewed changes). Every full review records its verdict and findings in a per-branch ledger at `<git-common-dir>/dsh-review/ledger.json` (LRU cap: 20 branches); `mode: "verify"` re-reviews only the delta since that record, asks reviewers to close each prior finding (`fixed`/`partially_fixed`/`not_fixed`/`cannot_verify`), and ships only when every prior blocking finding is confirmed fixed (ship replaces the record; reject keeps it).
- **`worktree`** — the pool manager: `acquire` cuts or reuses an isolated git worktree (`--branch` for a named-branch HEAD that `commit_apply --push`/PR flows need) and returns a durable `leaseId`; `release` returns the slot (conditional on the exact lease id; refuses dirty work unless `force`); `list` reports the persisted pool state; `prune` and `destroy` are dry-runs until `yes` and never touch leased or dirty slots automatically. Never administer a slot you do not own — the pool is shared infrastructure, and pruning or destroying a sibling slot destroys another task's live work. See [Worktree tool](#worktree-tool).

## Two-phase contract

The flow is intentionally model-driven but deterministic: `commit` returns ground truth plus a plan skeleton and guidance, the model authors a precise `SplitCommitPlan` (types, scopes, summaries, details, dependencies, optional hunk selections), and `commit_apply` validates and executes it without a hidden model session. Failures reset the index so no change is lost and every remaining edit stays inspectable in the worktree.

## Worktree tool

`worktree` maps the treehouse CLI verb surface (acquire/release/list/prune/destroy) onto the pool engine in [`@deepseek-ai/dsh-git`](../git/README.md#worktree-pool) (`./worktree`):

- **`acquire`** — fetches (unless `noFetch`), then reuses a slot only when provably idle (unleased, clean including untracked, HEAD merged into the exact reset target) or cuts a new one at the default/inferred base branch. Returns `path` + `leaseId` + holder/base — the durable ownership record. `branch` cuts a named-branch HEAD (the `commit_apply --push` path — `--push` records `origin/<branch>` upstream, so a PR flow can pick it up); `base` overrides the cut point.
- **`release`** — requires the exact `leaseId` (a stale caller can never release someone else's slot), parks the slot detached at its base for reuse, and refuses dirty work unless `force` (then `git clean -fdqx`).
- **`list`** — persisted pool state per slot: `leased` / `idle` / `damaged` with holder; reads never fork git per slot, so external mutations surface only after the engine's `verifyWorktrees` re-probes the slot.
- **`prune`** — dry-run by default; every prune first re-probes unleased slots (`verifyWorktrees`), so a parked slot dirtied externally flips to damaged and is skipped; the destructive `yes` path live-probes every parked slot for dirtiness before removal (including `--all` sibling pools), so an unprobed dirty slot is never force-removed; `yes` then removes only clean parked slots (`all` sweeps every pool under the configured root). Everything else is reported, never guessed.
- **`destroy`** — dry-run by default; `includeLeased` / `includeUnlanded` are the explicit overrides for the irreversible cases.

Why leases and not processes: DSH agents are host children, so a durable lease in `treehouse-state.json` — not a PID scan — is what survives a host restart, and the engine never terminates processes. Pool root is configurable (`worktreeRoot`, default `~/.treehouse`) so each workspace or machine can choose its own home for the pools.

## Configuration

- `reviewProvider` — subagent provider id for reviewer fan-out (default `spawn`).
- `maxReviewers` — max parallel reviewer runs (default 4).
- `maxReviewerDiffChars` — total inline diff character cap per reviewer (default 40,000), not per file. Larger slices are saved intact through `spillStore`; the reviewer receives the artifact locator, retrieval guidance, and per-file line ranges.
- `maxDiffChars` — analysis diff cap (default 60k).
- `worktreeRoot` — pool root directory for `worktree` (default `~/.treehouse`).
- `worktreeBaseBranch` — default cut branch for `worktree acquire` (default: inferred from origin HEAD / current branch).
- `worktreeFetchBeforeAcquire` — fetch origin before acquiring (default true; skipped when the repo has no origin).
- `worktreeLockWaitMs` — max wait for the pool-state lock (default 30s).
- `worktreeMaxSlots` — cap on total pooled worktrees per repository (default 0 = unlimited; reuse of a provably idle slot is still allowed at the cap, only cutting a new slot is refused).

The agent preset rows in this deployment mount `reviewProvider: spawn` and `maxReviewers: 4`.

Oversized reviewer assignments require a `spillStore` provider such as [`dsh-spill-local`](../../spill/spill-local/README.md). A missing provider or failed write fails the affected reviewer before it starts; the tool never substitutes truncated or oversized inline input. Artifact retention belongs to the spill provider.

## Export shape

A function/namespace plugin exporting `name` / `inject` / `apply` with no default export (a stray default would collapse the module via the Loader's `unwrapExports`). Helpers and types (`resolveCwd`, `toPriority`, `sliceByWeight`, `gitDiffSection`, `buildReviewerPrompt`, `SliceResult`, `ReviewerFinding`, common commit types) re-export from `/commit` and `/review`, the verify-mode prompt builder and findings-ledger helpers (`buildVerifyReviewerPrompt`, `LEDGER_BRANCH_CAP`, `diffHashOf`, `toLedgerFindings`, `ledgerBranchKey`, `ledgerPath`, `readLedger`, `writeLedger`, `LedgerFinding`, `LedgerRecord`) and the gate-verdict durability helpers (`readGateVerdict`, `writeGateVerdict`, `GateVerdictRecord`) from `/review` and `/ledger`, the gate-state machine and durable verdict helpers (`GateState`, `decidePushGate`, `gateStateOf`, `recordReviewVerdictDurable`, `loadStagedVerdict`) from `./src/push-gate`, and the commit-boundary guard (`CommitBoundaryError`, `parseStatTotals`) from `/commit`, for tests and other consumers.

## Model Experience

### Tool schema

#### What the model sees

The generated [`commit`, `commit_apply`, `review`, and `worktree` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-git), plus the `git:` section in the system prompt.

#### Token effect

Fixed schema cost per request while the tools are visible. `commit` returns a bounded diff (capped by `maxDiffChars`). Reviewers receive at most `maxReviewerDiffChars` inline diff characters, or an artifact reference and file ranges; later bounded reads still add context. Review instructions require relevant declarations and callers, not indiscriminate full-file reads.

#### KV Cache effect

Prefix-stable while the tool definitions, `git:` prompt section, and configured budgets are unchanged. `commit_apply` and `review` results append after the reusable request prefix without invalidating earlier entries.

### Tool-call history and result

#### What the model sees

Each `commit` call retains its analysis (files, diff, plan skeleton) in the call arguments. `commit_apply` returns `{ mode, created: [{ hash, message, changes }], messages, warnings }` — deterministic, small, and replay-authoritative. `review` returns verdict, ranked findings, confidence, files, and errors as compact JSON; `verify` mode adds `deltaFiles`/`deltaEmpty` plus per-prior-finding closure statuses and evidence. Stable failures are thrown before any write with readable messages: `Split commit plan missing staged files: <...>`, `Split commit plan assigns files to multiple groups: <...>`, `Invalid hunk selections: …`, `Circular dependency…`, and `nothing is staged; run `commit`…` for an empty index.

#### Token effect

Token growth scales with the diff and with `commit_apply`'s `created` list; each is bounded by the caps above. Reviewer findings are summarized, not echoed.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **No hidden model session inside the tools** — commit review quality is the model's own negotiation; the tool surface enforces structure, not semantic judgment of summaries.
- **Coverage is file-granular, hunks are optional** — the plan must plan every staged file once; hunk selectors refine *within* a file but do not relax coverage.
- **Lock files are auto-placed, not planable** — they never appear in the skeleton; `commit_apply` decides their group from the owning manifest.
- **Review completeness** — no completed reviewers means `reject`. Partial failures appear in `errors` but do not by themselves force rejection; check that `errors` is empty before treating a verdict as complete.
- **No force-push, no amend, no rebase verbs** — the service surface is the commit/review subset; editors and interactive history rewriting remain outside.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
