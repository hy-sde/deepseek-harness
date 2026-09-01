# Git 提交与评审

[English](git.md) | 中文

Agent 化 git seam 拆分为一个宿主服务（[dsh-git](../../packages/git/git)，`ctx.git`）与一个消费方（[dsh-tool-git](../../packages/git/tool-git)，`commit`、`commit_apply` 与 `review` 三个 schema）。服务通过 [subprocess seam](subprocess.zh.md) 调用 `git` CLI；工具层负责面向模型方的契约，并通过 [subagent seam](subagent.zh.md) 分发评审子代理。

源码：[`packages/git/git/src/service.ts`](../../packages/git/git/src/service.ts)

## 服务面

`ctx.git` 是一个轻量、无状态的封装：单实例服务所有会话，不持有持久状态。其动词对应 omp (oh-my-pi) 的 git 层，精简到 commit + review 所需：

- **仓库状态** — `isRepo`、`root`、`branch`、`status`、`hasStaged`。
- **Diff 读取** — `diffText`、`fileDiffs`，以及用于派生形状（`changedFiles`、`numstat`、`has`）的 `diff` 命名空间。diff 以 `--binary` 捕获，以便二进制变更安然通过拆分路径。
- **暂存** — `addAll`（`git add -A`）、`resetIndex`（`git reset`），以及 `stageHunks`——按 hunk 选择把已记录的 cached diff 切回索引（直接移植 omp 的 `stage.hunks`）。
- **提交 / 推送 / 日志** — `commit`（消息经 stdin 传入）、`push`（不跟随标签）、`log`。

每条命令都有独立的 wall-clock 超时、`SIGTERM→SIGKILL` 宽限、有界输出收集，以及转发给所派生 `git` 进程的中止信号。

## 模型驱动的两阶段提交

`commit` 与 `commit_apply` 以确定性的方式拆解 omp 流程；工具内部不运行隐藏的模型会话。

1. **`commit`（分析，只读）** — 快照已暂存（或在无暂存内容时自动暂存工作区）的树，返回按文件的增删计数、有界 diff 文本、`trivial` 分类、`lockFilesPending`，以及带有分组变更与常规提交模板指引字符串的建议计划骨架。它从不写入仓库。
2. **`commit_apply`（执行）** — 模型编写 `SplitCommitPlan`；工具对照*实际*暂存状态校验，然后确定性执行：
   - 每个已暂存文件恰好被规划一次（重复与未覆盖文件都是硬错误，在任何写入前抛出）；
   - hunk 选择对照真实 diff 校验；坐标无法解析的 hunk 是错误而非猜测；
   - 提交分组被校验（类型、作用域、摘要）并按拓扑排序；环依赖在任何写入前被拒绝；
   - 执行先重置索引，然后按组只暂存该组的 hunks 并提交；失败时重置索引，所有剩余变更都以可检查状态保留在工作区；
   - 单组计划即普通提交，多组即拆分提交。

### 锁文件自动归位

`pnpm-lock.yaml`、`package-lock.json`、`yarn.lock`、`bun.lock*` 与工作区工具的锁文件从不进入计划骨架。`commit_apply` 把每个待处理锁文件附加到拥有其兄弟 manifest（如 `package.json` 变更）的分组，回退到最后一个提交。模型无法把它们规划错，也完全无需规划它们。

### Hunk 暂存语义

暂存 hunks 子集时，会依据记录的 `--cached` diff 重建补丁，并以 `git apply --cached` **不加** `--binary` 的方式应用。对头部携带 `index <old>..<new>` 的文本补丁传入 `--binary`，会让 `git apply` 找到两个 blob 并暂存*整个*新 blob，静默破坏 hunk 粒度——重建过程会去掉 `--binary`，除非补丁实际内嵌二进制内容。已提交的 hunk 从索引得到满足；分组未选择的其余内容之后保留在工作区中——未暂存但完整无损。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

<a id="ctxvcs--vcsservice"></a>

### `ctx.vcs` — `VcsService`

The `ctx.vcs` service.

```ts cordis-catalog
/**
 * Check whether the `pi-vcs` CLI is reachable and answering
 * `pi-vcs --version`. Never throws: an unavailable binary, launch failure,
 * or timeout surfaces as `{ available: false, reason }`. Feature-detection
 * gate for the read surfaces and the watch companion.
 * @returns reachability, CLI version when present, and a human reason on failure.
 */
async probe(): Promise<VcsProbe>

/**
 * Resolve repository discovery metadata (`pi-vcs repo-info <dir>`).
 * @param dir - any directory inside the checkout (walked toward the root).
 * @returns repo metadata, or `null` when `dir` is outside any git
 * repository (`NotARepository` is data, not an error).
 */
async repoInfo(dir: string): Promise<VcsRepoInfo | null>

/**
 * Render the git patch between two revisions (`pi-vcs rev-diff <dir> <base>
 * [<head>]`). Output is git-compatible unified diff text, byte-compatible
 * with the git service's rendering, so existing diff parsers keep working.
 * @param dir - directory inside the checkout.
 * @param base - base revision (rev-parse spec).
 * @param head - head revision; `base`→worktree when omitted.
 * @returns the unified diff text (empty string when the range is clean).
 */
async revDiff(dir: string, base: string, head?: string): Promise<string>

/**
 * Render the staged patch (index vs HEAD) (`pi-vcs staged-diff <dir>`).
 * @param dir - directory inside the checkout.
 * @returns the unified diff text (empty string when nothing is staged).
 */
async stagedDiff(dir: string): Promise<string>

/**
 * Render the worktree patch (index vs worktree) (`pi-vcs worktree-diff <dir>`),
 * the native counterpart to `git diff`. Untracked files are excluded, like
 * git itself.
 * @param dir - directory inside the checkout.
 * @param signal - optional abort.
 * @returns the unified diff text (empty string when the worktree is clean).
 */
async worktreeDiff(dir: string, signal?: AbortSignal): Promise<string>

/**
 * Render one diff range in any CLI output mode. It picks the CLI verb from
 * the selectors (base+head → `rev-diff`, base only → base→worktree, cached →
 * `staged-diff`, none → `worktree-diff`) and appends the mode flag.
 * @param dir - directory inside the checkout.
 * @param options - range/mode selectors (see {@link VcsDiffOptions}).
 * @param signal - optional abort.
 * @returns the raw CLI text: unified diff, one path per line (`name-only`),
 * or `added\tremoved\tpath` lines (`numstat`), byte-compatible with the
 * corresponding `git diff` output.
 */
async diff( dir: string, options: VcsDiffOptions & { mode?: VcsDiffMode } = {}, signal?: AbortSignal, ): Promise<string>

/**
 * Changed-file names (`git diff --name-only`), one per line with the
 * destination path for renames and git's C-quoting preserved.
 * @param dir - directory inside the checkout.
 * @param options - range selectors (see {@link VcsDiffOptions}).
 * @param signal - optional abort.
 * @returns the changed paths, relative to the checkout root.
 */
async changedFiles(dir: string, options: VcsDiffOptions = {}, signal?: AbortSignal): Promise<string[]>

/**
 * Raw `git diff --numstat` text. Callers parse with the git package's
 * `parseNumstat` (already byte-compatible with this output) when they need
 * typed entries.
 * @param dir - directory inside the checkout.
 * @param options - range selectors (see {@link VcsDiffOptions}).
 * @param signal - optional abort.
 * @returns `added\tremoved\tpath` lines (binary rows show `-`).
 */
async numstat(dir: string, options: VcsDiffOptions = {}, signal?: AbortSignal): Promise<string>

/**
 * Plain status summary counts, mirroring `ctx.git.status` by counting the
 * same `git status --porcelain` columns natively.
 * @param dir - directory inside the checkout.
 * @param signal - optional abort.
 * @returns staged/unstaged/untracked counts.
 */
async status(dir: string, signal?: AbortSignal): Promise<VcsStatusSummary>

/**
 * The current branch name (`pi-vcs repo-info <dir>`), or undefined on a
 * detached HEAD / outside any checkout.
 * @param dir - directory inside the checkout.
 * @returns the current branch name, or undefined when detached or outside
 * any checkout.
 */
async branch(dir: string): Promise<string | undefined>

/**
 * Watch a repository for HEAD changes (`pi-vcs watch` companion).
 *
 * Spawns a long-running `pi-vcs watch <dir>` process, decodes its JSON-lines
 * protocol incrementally through the subprocess seam's offset-based reader,
 * and invokes `onChange` per `head` event. The returned disposer
 * terminates the process tree (SIGTERM → grace → SIGKILL) and stops
 * decoding; the process exits 0 on the signal, keeping
 * {@link VcsCommandError} out of the watch surface.
 * @param dir - directory inside the checkout.
 * @param onChange - called once per reported HEAD change.
 * @returns a disposer that stops the companion process and its decoders.
 */
watch(dir: string, onChange: (event: VcsWatchEvent) => void): () => void

/**
 * Run one `pi-vcs` command. A non-zero exit code is returned as data on the
 * run (callers decide whether it is an error); only a launch failure, a
 * signal kill, or a timeout throws {@link VcsCommandError}.
 * @param argv - pi-vcs arguments (never shell-interpreted).
 * @param options - cwd (required), abort signal, stdin text, timeout override.
 * @returns exit code, collected stdout/stderr, and killed flag; throws {@link VcsCommandError} on launch/timeout/signal failures.
 */
async run( argv: readonly string[], options: { cwd: string signal?: AbortSignal | undefined stdin?: string | undefined timeoutMs?: number }, ): Promise<CommandRun>
```

Source: [`packages/vcs/vcs/src/service.ts`](../../packages/vcs/vcs/src/service.ts)
<!-- END GENERATED cordis-surface -->

## 评审扇出

`review` 按权重把已暂存 diff 切成至多 `maxReviewers` 份子代理运行，每份都有有界 diff 窗口与结构化评审者契约（`overall_correctness`、带优先级／置信度／行引用的 findings、解释）。它按各评审者置信度的最小值聚合 `ship`／`reject` 结论，按严重度排序 findings，并把传输失败报告为 `errors`——绝不静默批准未受评审的变更。评审者提供方与数量属于配置，而非工具参数。

## 配置

- `dsh-git` — `gitPath`、`timeoutMs`、`maxStdoutBytes`、`maxStderrBytes`、`graceMs`。
- `dsh-tool-git` — `reviewProvider`、`maxReviewers`、`maxReviewerDiffChars`、`maxDiffChars`；agent 组合中的 preset 行选择 `reviewProvider: spawn` 与 `maxReviewers: 4`。
