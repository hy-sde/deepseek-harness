# Git commit + review

English | [中文](git.zh.md)

The agentic git seam is split across a Host Service ([dsh-git](../../packages/git/git), `ctx.git`) and a Consumer ([dsh-tool-git](../../packages/git/tool-git), the `commit`, `commit_apply`, and `review` schemas). The service shells out to the `git` CLI through the [subprocess seam](subprocess.md); the tool layer owns the model-facing contract, fanning reviewer runs out through the [subagent seam](subagent.md).

Source: [`packages/git/git/src/service.ts`](../../packages/git/git/src/service.ts)

## Service surface

`ctx.git` is a thin, stateless wrapper: one instance serves every session and holds no durable state. Its verbs mirror the omp (oh-my-pi) git layer reduced to what commit + review need:

- **Repository state** — `isRepo`, `root`, `branch`, `status`, `hasStaged`.
- **Diff reads** — `diffText`, `fileDiffs`, and a `diff` namespace for the derived shapes (`changedFiles`, `numstat`, `has`). Diffs are captured with `--binary` so binary changes survive the split path.
- **Staging** — `addAll` (`git add -A`), `resetIndex` (`git reset`), and `stageHunks` which slices a recorded cached diff back onto the index by hunk selection (direct port of omp `stage.hunks`).
- **Commit / push / log** — `commit` (message via stdin), `push` (no tag following), `log`.

Every command runs with its own wall-clock timeout, a `SIGTERM→SIGKILL` grace, bounded collected output, and an abort signal that forwards to the spawned `git` process.

## Model-driven two-phase commit

`commit` and `commit_apply` split the omp flow deterministically; no hidden model session runs inside the tools.

1. **`commit` (analyze, read-only)** — snapshots the staged (or, when nothing is staged, auto-stages the worked) tree, returns per-file add/delete counts, a bounded diff text, `trivial` classification, `lockFilesPending`, and a suggested plan skeleton with grouped changes and a conventional-commit template guidance string. It never writes to the repository.
2. **`commit_apply` (execute)** — the model authors a `SplitCommitPlan`; the tool validates it against the *actual* staged state, then executes deterministically:
   - every staged file is planned exactly once (duplicates and uncovered files are hard errors, thrown before anything is written);
   - hunk selectors are validated against the real diff; a hunk whose coordinates do not resolve is an error, not a guess;
   - commit grouping is validated (types, scopes, summaries) and ordered topologically; a cyclic dependency is rejected before any write;
   - execution resets the index, then per group stages only the group's hunks and commits; failures reset the index so nothing is lost and every remaining change stays inspectable in the worktree;
   - a single-group plan is a plain commit, multi-group is a split.

### Lock-file autoplacement

`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock*` and workspace-tool lock files never appear in the plan skeleton. `commit_apply` attaches each pending lock file to the group that owns its sibling manifest (e.g. a `package.json` change), falling back to the final commit. The model cannot misroute them and never has to plan them.

### Hunk staging semantics

Staging a subset of hunks rebuilds the patch from the recorded `--cached` diff and applies it with `git apply --cached` **without** `--binary`. Passing `--binary` for a text patch whose header carries `index <old>..<new>` makes `git apply` find both blobs and stage the *whole* new blob, silently defeating hunk granularity — the rebuild drops `--binary` unless the patch embeds actual binary content. A committed hunk is satisfied from the index; everything the group did not select remains in the worktree afterwards, unstaged but intact.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxgit--gitservice"></a>

### `ctx.git` — `GitService`

The `ctx.git` service.

```ts cordis-catalog
/**
 * Run one `git` command against `cwd`. A non-zero exit code is returned as
 * data on the run (callers decide whether it is an error); only a launch
 * failure, a signal kill, or a timeout throws {@link GitCommandError}.
 * @param argv - git arguments (never shell-interpreted).
 * @param options - cwd (required), abort signal, stdin text, timeout override.
 * @returns exit code, stdout, stderr; throws {@link GitCommandError} only for launch/timeout/signal failures.
 */
async run( argv: readonly string[], options: { cwd: string; signal?: AbortSignal | undefined; stdin?: string | undefined; timeoutMs?: number }, ): Promise<CommandRun>

/**
 * True when `cwd` is inside a git working tree.
 * @param cwd - working directory to probe.
 * @param signal - optional abort.
 * @returns whether `cwd` is a git working tree (never throws).
 */
async isRepo(cwd: string, signal?: AbortSignal): Promise<boolean>

/**
 * The repository root (`git rev-parse --show-toplevel`).
 * @param cwd - working directory inside the repository.
 * @param signal - optional abort.
 * @returns the absolute repository root.
 */
async root(cwd: string, signal?: AbortSignal): Promise<string>

/**
 * The current branch name, or undefined when detached.
 * @param cwd - working directory inside the repository.
 * @param signal - optional abort.
 * @returns the branch name, or undefined on a detached HEAD.
 */
async branch(cwd: string, signal?: AbortSignal): Promise<string | undefined>

/**
 * Plain status summary: staged/unstaged/untracked counts.
 * @param cwd - working directory inside the repository.
 * @param signal - optional abort.
 * @returns counts of staged, unstaged and untracked entries.
 */
async status(cwd: string, signal?: AbortSignal): Promise<GitStatusSummary>

/**
 * True when the index differs from HEAD (something is staged).
 * @param cwd - working directory inside the repository.
 * @param signal - optional abort.
 * @returns whether there is anything staged.
 */
async hasStaged(cwd: string, signal?: AbortSignal): Promise<boolean>

/**
 * Whole raw diff text; non-zero exit is an error unless `allowFailure`.
 * @param cwd - working directory inside the repository.
 * @param options - cached vs worktree, pathspec files, binary, name-only, numstat, allowFailure.
 * @param signal - optional abort.
 * @returns the diff text.
 */
async diffText(cwd: string, options: DiffOptions & { allowFailure?: boolean } = {}, signal?: AbortSignal): Promise<string>

/**
 * Parsed file diff sections for `pathSpec` (defaults to the whole cached diff).
 * @param cwd - working directory inside the repository.
 * @param options - cached vs worktree and pathspec filter.
 * @returns one parsed section per changed file.
 */
async fileDiffs( cwd: string, options: { cached?: boolean; files?: readonly string[]; signal?: AbortSignal } = {}, ): Promise<FileDiff[]>

/**
 * Selectively stage whole files or hunks from a diff that is already in the
 * index (the `--cached` view). Direct port of omp `stage.hunks`: rebuilds a
 * patch from the recorded diff and applies it to the index.
 * @param cwd - working directory inside the repository.
 * @param selections - file/hunk selections to stage.
 * @param options - the raw cached diff to slice from (defaults to `git diff --cached`).
 */
async stageHunks( cwd: string, selections: readonly FileChange[], options: { rawDiff?: string; signal?: AbortSignal } = {}, ): Promise<void>

/**
 * Apply a patch string (to the index with `cached: true`, as split staging needs).
 * @param cwd - working directory inside the repository.
 * @param patchText - unified diff text piped to `git apply`.
 * @param options - cached vs worktree, reverse direction, abort signal.
 */
async applyPatchText( cwd: string, patchText: string, options: { cached?: boolean; reverse?: boolean; signal?: AbortSignal | undefined } = {}, ): Promise<void>

/**
 * Stage files; empty list stages everything (`git add -A`).
 * @param cwd - working directory inside the repository.
 * @param files - paths to stage; empty stages everything.
 * @param signal - optional abort.
 */
async addAll(cwd: string, files: readonly string[] = [], signal?: AbortSignal): Promise<void>

/**
 * Unstage files; empty list unstages everything (`git reset`).
 * @param cwd - working directory inside the repository.
 * @param files - paths to unstage; empty unstages everything.
 * @param signal - optional abort.
 */
async resetIndex(cwd: string, files: readonly string[] = [], signal?: AbortSignal): Promise<void>

/**
 * Create a commit from `message` (passed via stdin).
 * @param cwd - working directory inside the repository.
 * @param message - commit message (subject/body).
 * @param options - allow-empty and abort signal.
 * @returns the underlying command run.
 */
async commit(cwd: string, message: string, options: { signal?: AbortSignal; allowEmpty?: boolean } = {}): Promise<CommandRun>

/**
 * Push the current branch. `--no-follow-tags` so only the branch moves.
 * @param cwd - working directory inside the repository.
 * @param options - optional force-with-lease and abort signal.
 */
async push(cwd: string, options: { signal?: AbortSignal; forceWithLease?: boolean } = {}): Promise<void>

/**
 * Recent commits (default 20), parseable fields only.
 * @param cwd - working directory inside the repository.
 * @param options - max count, abort signal.
 * @returns newest-first commit entries with hash/author/date/subject.
 */
async log(cwd: string, options: { max?: number; signal?: AbortSignal; color?: 'never' } = {}): Promise<GitLogEntry[]>
```

Source: [`packages/git/git/src/service.ts`](../../packages/git/git/src/service.ts)
<!-- END GENERATED cordis-surface -->

## Review fan-out

`review` slices the staged diff by weight across `maxReviewers` subagent runs, each with a bounded diff window and a structured reviewer contract (`overall_correctness`, findings with priority/confidence/line refs, explanation). It aggregates a `ship`/`reject` verdict from the per-reviewer minimum confidence, ranks findings by severity, and reports transport failures as `errors` — never silently approving unreviewed changes. The reviewer provider and counts are configuration, not tool parameters.

## Configuration

- `dsh-git` — `gitPath`, `timeoutMs`, `maxStdoutBytes`, `maxStderrBytes`, `graceMs`.
- `dsh-tool-git` — `reviewProvider`, `maxReviewers`, `maxReviewerDiffChars`, `maxDiffChars`; the preset row in the agent composition selects `reviewProvider: spawn` and `maxReviewers: 4`.
