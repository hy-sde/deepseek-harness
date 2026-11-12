/**
 * Worktree pool with durable leases for parallel agent work on one repository.
 *
 * Modeled on treehouse (MIT, https://github.com/kunchenguid/treehouse) `get
 * --lease` semantics — see `firstmate-worktree-scope.md` in the workspace for
 * the design record — reduced to what a pure-TS fork can express over the
 * `ctx.git` subprocess seam:
 *
 * - A per-repository pool of git worktrees under a configurable root
 *   (default `~/.treehouse`), each slot cut at detached HEAD (treehouse
 *   default) or at a NAMED branch (DSH deviation D1: `tool-git commit_apply
 *   --push` runs `git push` on the current branch, which fails on a detached
 *   HEAD, so the PR path needs a branch).
 * - DURABLE LEASES: `acquireWorktree` reserves a slot in persistent pool state
 *   with an immutable random lease id; a leased slot is never handed out again
 *   and never pruned until `releaseWorktree` clears it with the matching id —
 *   exactly treehouse's lease contract, and the property that makes a task's
 *   environment survive a host restart (D3: DSH children die with the host, so
 *   the lease — not a process — is the ownership record).
 * - Safety is recorded, not re-inferred: each slot persists a lifecycle phase
 *   — `parked` (released after the clean+merge checks passed), `leased`, or
 *   `damaged` with a cause — and every phase transition runs the live git
 *   probes first: `acquireWorktree` re-probes a parked candidate before reuse
 *   and records damage otherwise, `releaseWorktree` refuses (and records)
 *   dirty work, and `verifyWorktrees` re-probes after external mutations.
 *   Reads never probe: `listWorktrees` and `pruneWorktrees` report the
 *   persisted phase, so a status never costs a per-slot git fork and outside
 *   changes surface only after verify. Destructive paths keep their explicit
 *   flags and live guards.
 * - TERMINAL STATE: parked is not a forever home — `sweepWorktrees` (run
 *   automatically inside `acquireWorktree` unless `settings.autoPrune` is
 *   false) evicts parked slots idle past `settings.maxIdleMs` (default 7
 *   days, stamped `parkedAt` at park time) after re-probing clean+merged,
 *   and deletes an evicted slot's pool-owned cut-branch when it is merged
 *   into the reset target (`git branch -d`; unmerged branches are retained).
 * - DEVIATIONS vs treehouse (see the scope doc): named-branch support (D1), no
 *   process scan/termination in release (D2 — reports instead of killing),
 *   lease holder identifies the session/agent rather than a PID (D3), and the
 *   pool state file is this package's own `treehouse-state.json` with
 *   treehouse-compatible field names — no byte-level interop claim (D4).
 *
 * Concurrency: pool-state mutations are serialized cross-process with
 * `@deepseek-ai/dsh-atomic-write`'s `writeFileAtomic` + `withFileLock` (the
 * same temp-rename + lock treehouse implements with a flock), and git
 * mutations additionally run under the in-process `withRepoLock` keyed on the
 * repository's git common dir so worktrees of one repository share one queue.
 * @module @deepseek-ai/dsh-git/worktree
 */

import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { GitService } from './service.ts'
import { withRepoLock } from './repo-lock.ts'

/** Machine-readable failure codes carried by {@link WorktreeError}. */
export type WorktreeErrorCode =
  | 'NotARepository'
  | 'UnsupportedRepository'
  | 'DefaultBranchUnknown'
  | 'LeaseMismatch'
  | 'UnknownWorktree'
  | 'DirtyWorktree'
  | 'UnlandedWorktree'
  | 'LeasedWorktree'
  | 'GitFailed'
  | 'MaxSlots'

/** A typed worktree-pool failure: semantic codes for the tool layer to branch on. */
export class WorktreeError extends Error {
  override readonly name = 'WorktreeError' as const
  readonly code: WorktreeErrorCode
  /** The worktree or pool path involved, when one exists. */
  readonly path: string | undefined

  constructor(code: WorktreeErrorCode, message: string, path?: string) {
    super(message)
    this.code = code
    this.path = path
  }
}

/** Pool-level settings (shareable as a tool config row). */
export interface WorktreeSettings {
  /**
   * Pool root directory holding one sub-directory per repository
   * (default `~/.treehouse`). Treated as a literal path — unlike treehouse it
   * is not treated as the parent of a `.treehouse` directory (documented
   * deviation D4; keep it explicit so an operator can point both tools at the
   * same root if interop ever matters).
   */
  root?: string
  /**
   * Default branch worktrees are cut from (default: inferred from
   * `refs/remotes/origin/HEAD`, then the current branch).
   */
  baseBranch?: string
  /** Fetch origin before acquiring (default true; skipped when no origin exists). */
  fetchBeforeAcquire?: boolean
  /** Max ms to wait for the cross-process pool-state lock (default 30000). */
  lockWaitMs?: number
  /**
   * Cap on total pooled slots for one repository (default 0 = unlimited).
   * `acquireWorktree` still reuses a provably-idle slot when the cap is
   * reached; it refuses to CUT a new slot and fails with code `MaxSlots`,
   * leaving release/prune/destroy (or raising the cap) as the fix.
   */
  maxSlots?: number
  /**
   * Auto-sweep parked slots during `acquireWorktree` (default true): evict
   * parked slots idle past `maxIdleMs` after re-probing clean+merged, and
   * delete their merged pool-owned cut-branches. See {@link sweepWorktrees}.
   */
  autoPrune?: boolean
  /** Max ms a parked slot may sit idle before the auto-sweep may evict it (default 7 days). */
  maxIdleMs?: number
}

/** Per-acquire options. */
export interface AcquireOptions {
  /**
   * Cut HEAD at a NEW named branch instead of detached (DSH deviation D1, for
   * `commit_apply --push` / PR flows). The branch is created from the reset
   * target; a slot previously cut at the same branch name is the only slot
   * this option may reuse (D5).
   */
  branch?: string
  /** Cut from this branch, overriding `settings.baseBranch` and inference. */
  base?: string
  /** Lease holder label recorded in pool state (default `dsh`). */
  holder?: string
  /** Skip the origin fetch even when `settings.fetchBeforeAcquire` is true. */
  noFetch?: boolean
  signal?: AbortSignal
}

/** A completed lease acquisition (the caller's durable ownership record). */
export interface WorktreeLease {
  /** Absolute path of the worktree. */
  path: string
  /** Immutable per-acquisition identity; required to release this slot. */
  leaseId: string
  leaseHolder: string
  /** ISO timestamp of the acquisition. */
  leasedAt: string
  /** The branch this slot was cut from (explicit or inferred). */
  baseBranch: string
  /** Present when the slot was cut at a named branch (D1). */
  branch?: string
  /** Present when the acquire-time auto-sweep evicted slots or touched branches. */
  sweep?: WorktreeSweepResult
}

/** One pool slot as reported by {@link listWorktrees}. */
export interface WorktreeStatus {
  /** Pool-relative slot name (the numeric directory). */
  name: string
  path: string
  /**
   * `leased` — durably reserved; `idle` — parked and reusable; `damaged` —
   * recorded damage or a missing directory. Reported from the persisted slot
   * phase, not probed (see {@link listWorktrees}).
   */
  status: 'leased' | 'idle' | 'damaged'
  leased: boolean
  leaseId?: string
  leaseHolder?: string
  leasedAt?: string
  baseBranch: string
  /** The named branch this slot was cut at (D1), when any. */
  branch?: string
  /** ISO timestamp stamped when the slot parked; present only while idle. */
  parkedAt?: string
  /**
   * True when the recorded damage cause is `dirty`. Not a live probe —
   * {@link verifyWorktrees} refreshes it.
   */
  dirty: boolean
  /**
   * True for a parked slot (parking resets HEAD onto the reset target, so the
   * merge is an invariant). Not probed.
   */
  merged: boolean
  /** True when the worktree directory still exists (filesystem stat). */
  exists: boolean
}

/** One prune candidate or skip item. */
export interface WorktreePruneItem {
  name: string
  path: string
  /** Human-readable reason: `removable`, or the skip reason (`leased`, `missing`, `damaged (<cause>)`). */
  reason: string
}

/** Result of {@link pruneWorktrees}. */
export interface WorktreePruneResult {
  candidates: WorktreePruneItem[]
  skipped: WorktreePruneItem[]
  /** Paths actually removed when `yes` was passed. */
  removed: string[]
}

/** One slot the sweep considered but refused, with the reason. */
export interface WorktreeSweepSkippedItem {
  name: string
  path: string
  reason: string
}

/** One pool-owned cut-branch kept after its slot was evicted. */
export interface WorktreeSweepBranchItem {
  branch: string
  /** Why the branch was retained: `unmerged`, or the delete refusal. */
  reason?: string
}

/**
 * Result of {@link sweepWorktrees} and of the acquire-time auto-sweep
 * (attached to {@link WorktreeLease.sweep} when anything happened).
 */
export interface WorktreeSweepResult {
  /** Parked slots idle past the TTL, re-probed clean+merged, and removed. */
  evicted: Array<{ name: string; path: string; branch?: string }>
  /** Slots that reached the eviction gate but were refused (never silently). */
  skipped: WorktreeSweepSkippedItem[]
  /** Pool-owned cut-branches deleted with their slot (merged into the target). */
  deletedBranches: string[]
  /** Pool-owned cut-branches retained despite eviction (unmerged or delete refused). */
  retainedBranches: WorktreeSweepBranchItem[]
}

/** Result of {@link destroyWorktree}. */
export interface WorktreeDestroyResult {
  path: string
  /** True when the slot was actually removed; false for a dry-run preview. */
  removed: boolean
}

/** Result of {@link releaseWorktree}. */
export interface WorktreeReleaseResult {
  path: string
  released: boolean
}

/** Persisted lifecycle phase of one pool slot. */
export type WorktreePhase =
  /**
   * Released after the clean+merge checks passed (release resets HEAD onto
   * the target): reusable by `acquireWorktree`, removable by prune.
   */
  | 'parked'
  /** Durably reserved by a lease id until `releaseWorktree` or destroy. */
  | 'leased'
  /**
   * A probe or recovery found a problem (see `cause`); only
   * `verifyWorktrees` can move the slot back to `parked`.
   */
  | 'damaged'

/** Why a slot is in the `damaged` phase. */
export type WorktreeDamageCause =
  /** The working tree has tracked or untracked changes. */
  | 'dirty'
  /** HEAD is not an ancestor of the reset target. */
  | 'unmerged'
  /** The slot directory is gone. */
  | 'missing'
  /** The state file was corrupt; the slot was adopted from disk without proof. */
  | 'state-corrupt'

/** One entry of the on-disk pool state (treehouse-compatible field names, own file — D4). */
export interface WorktreeStateEntry {
  name: string
  path: string
  createdAt: string
  /** Authoritative slot phase; the lease fields exist only while `leased`. */
  phase: WorktreePhase
  /** Why the slot is damaged; present only while phase is `damaged`. */
  cause?: WorktreeDamageCause
  /** Lease identity; present while leased. */
  leaseId?: string
  leaseHolder?: string
  leasedAt?: string
  /** Explicit cut branch only (treehouse parity); empty for inferred. */
  baseBranch: string
  /** Named branch this slot was cut at (D1). */
  branch?: string
  /** ISO timestamp stamped when the slot parked; present only while `parked`. */
  parkedAt?: string
}

/** The pool state file shape. */
export interface WorktreeState {
  schema: 1
  /** Canonical (realpath) primary repository root the pool belongs to. */
  repoRoot: string
  worktrees: WorktreeStateEntry[]
}

const STATE_FILE_NAME = 'treehouse-state.json'
const STATE_SCHEMA = 1 as const
const DEFAULT_ROOT = join(homedir(), '.treehouse')
const DEFAULT_LOCK_WAIT_MS = 30_000
/** Default auto-sweep idle TTL: 7 days. */
const DEFAULT_MAX_IDLE_MS = 604_800_000

function fail(code: WorktreeErrorCode, message: string, path?: string): never {
  throw new WorktreeError(code, message, path)
}

/** Never throw for a missing file; returns undefined. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Run a git command via the service, requiring exit 0 (WorktreeError on a non-zero exit). */
async function gitChecked(git: GitService, argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const run = await git.run(argv, { cwd, signal })
  if (run.exitCode !== 0) {
    throw new WorktreeError(
      'GitFailed',
      `git ${argv[0] ?? ''} failed (exit ${run.exitCode}): ${run.stderr.trim()}`,
      cwd,
    )
  }
  return run.stdout
}

/** Run a git command without throwing on a non-zero exit. */
async function gitMaybe(
  git: GitService,
  argv: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const run = await git.run(argv, { cwd, signal })
  return { ok: run.exitCode === 0, stdout: run.stdout, stderr: run.stderr }
}

function abortGuard(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new WorktreeError('GitFailed', 'operation was aborted before it could start')
  }
}

/* ── repository discovery ──────────────────────────────────────────────── */

/**
 * The PRIMARY repository root (the main checkout) owning `cwd`, canonicalized
 * through realpath so one repository — main checkout or any linked worktree —
 * always resolves to one pool key, even across `/tmp` vs `/private/tmp`.
 * @param git - the git service.
 * @param cwd - a directory inside any checkout of the repository.
 * @param signal - optional abort.
 * @returns the canonical absolute primary root.
 */
export async function primaryRepoRoot(git: GitService, cwd: string, signal?: AbortSignal): Promise<string> {
  const inside = await gitMaybe(git, ['rev-parse', '--is-inside-work-tree'], cwd, signal)
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    fail('NotARepository', `not inside a git working tree: ${cwd}`, cwd)
  }
  const common = await git.run(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, signal })
  if (common.exitCode !== 0) {
    const fallback = await git.run(['rev-parse', '--git-common-dir'], { cwd, signal })
    if (fallback.exitCode !== 0) {
      fail('NotARepository', `cannot resolve the repository for ${cwd}: ${fallback.stderr.trim()}`, cwd)
    }
    let value = fallback.stdout.trim()
    if (!isAbsolute(value)) value = resolve(cwd, value)
    return realpath(dirname(value))
  }
  let value = common.stdout.trim()
  if (!isAbsolute(value)) value = resolve(cwd, value)
  if (basename(value) !== '.git') {
    fail('UnsupportedRepository', `bare or non-standard repository (git dir ${value})`, cwd)
  }
  return realpath(dirname(value))
}

/**
 * The pool directory for one primary repository root: `<root>/<repo>-<hash6>`
 * where the hash is the first 6 hex chars of sha256 over the canonical root
 * (stable offline; a remote URL is not consulted, unlike treehouse — D4).
 * @param settings - pool settings (root default `~/.treehouse`).
 * @param primaryRoot - canonical primary repository root.
 * @returns the absolute pool directory.
 */
export function resolveWorktreePoolRoot(settings: WorktreeSettings, primaryRoot: string): string {
  const root = settings.root ?? DEFAULT_ROOT
  const repoName = basename(primaryRoot)
  const hash = createHash('sha256').update(primaryRoot).digest('hex').slice(0, 6)
  return join(root, `${repoName}-${hash}`)
}

function stateFilePath(poolRoot: string): string {
  return join(poolRoot, STATE_FILE_NAME)
}

/* ── state file ────────────────────────────────────────────────────────── */

/**
 * Validate one state-file entry and normalize it to the current shape: the
 * persisted `phase` is authoritative, lease fields exist only while leased,
 * and legacy entries (`leased`/`recovered` booleans) migrate in place.
 * @returns the normalized entry, or null when required fields are missing
 *   (the whole file then falls back to disk recovery).
 */
function normalizeEntry(item: unknown): WorktreeStateEntry | null {
  if (typeof item !== 'object' || item === null) return null
  const raw = item as Partial<WorktreeStateEntry> & { leased?: boolean; recovered?: boolean }
  if (typeof raw.name !== 'string' || raw.name.length === 0) return null
  if (typeof raw.path !== 'string' || raw.path.length === 0) return null
  if (typeof raw.createdAt !== 'string' || raw.createdAt.length === 0) return null
  if (typeof raw.baseBranch !== 'string') return null
  const leaseId = typeof raw.leaseId === 'string' && raw.leaseId.length > 0 ? raw.leaseId : undefined
  let phase: WorktreePhase
  if (raw.phase === 'parked' || raw.phase === 'leased' || raw.phase === 'damaged') {
    phase = raw.phase
  } else if (raw.recovered === true) {
    phase = 'damaged'
  } else if (raw.leased === true && leaseId !== undefined) {
    phase = 'leased'
  } else if (raw.leased === true) {
    // A lease without an id can neither be released nor matched: damaged.
    phase = 'damaged'
  } else {
    phase = 'parked'
  }
  let cause: WorktreeDamageCause = 'state-corrupt'
  if (raw.cause === 'dirty' || raw.cause === 'unmerged' || raw.cause === 'missing') {
    cause = raw.cause
  }
  if (phase === 'leased' && leaseId === undefined) {
    phase = 'damaged'
  }
  return {
    name: raw.name,
    path: raw.path,
    createdAt: raw.createdAt,
    phase,
    baseBranch: raw.baseBranch,
    ...(typeof raw.branch === 'string' && raw.branch.length > 0 ? { branch: raw.branch } : {}),
    ...(phase === 'damaged' ? { cause } : {}),
    ...(phase === 'leased' && leaseId !== undefined ? { leaseId } : {}),
    ...(phase === 'leased' && typeof raw.leaseHolder === 'string' && raw.leaseHolder.length > 0 ? { leaseHolder: raw.leaseHolder } : {}),
    ...(phase === 'leased' && typeof raw.leasedAt === 'string' && raw.leasedAt.length > 0 ? { leasedAt: raw.leasedAt } : {}),
    ...(phase === 'parked' && typeof raw.parkedAt === 'string' && raw.parkedAt.length > 0
      && !Number.isNaN(Date.parse(raw.parkedAt)) ? { parkedAt: raw.parkedAt } : {}),
  }
}

function parseState(text: string): WorktreeState | null {
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value !== 'object' || value === null) return null
    const record = value as Partial<WorktreeState>
    if (record.schema !== STATE_SCHEMA || !Array.isArray(record.worktrees)) return null
    if (typeof record.repoRoot !== 'string') return null
    const worktrees: WorktreeStateEntry[] = []
    for (const item of record.worktrees) {
      const entry = normalizeEntry(item)
      if (entry === null) return null
      worktrees.push(entry)
    }
    return { schema: STATE_SCHEMA, repoRoot: record.repoRoot, worktrees }
  } catch {
    return null
  }
}

function serializeState(state: WorktreeState): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

/** Phase transition to `parked`: drops the damage cause and lease fields, stamps `parkedAt`.
 * A carried `parkedAt` (same-phase re-verify of an already-parked slot) keeps the idle clock
 * running instead of silently restarting it; only a real transition into `parked` re-stamps. */
function parkEntry(entry: WorktreeStateEntry, carriedParkedAt?: string): WorktreeStateEntry {
  return {
    name: entry.name,
    path: entry.path,
    createdAt: entry.createdAt,
    phase: 'parked',
    baseBranch: entry.baseBranch,
    parkedAt: carriedParkedAt ?? new Date().toISOString(),
    ...entry.branch !== undefined ? { branch: entry.branch } : {},
  }
}

/** Phase transition to `leased`: records the lease identity, drops any cause. */
function leaseEntry(
  entry: WorktreeStateEntry,
  lease: { id: string; holder: string; at: string; baseBranch: string; branch?: string },
): WorktreeStateEntry {
  return {
    name: entry.name,
    path: entry.path,
    createdAt: entry.createdAt,
    phase: 'leased',
    baseBranch: lease.baseBranch,
    ...lease.branch !== undefined ? { branch: lease.branch } : {},
    leaseId: lease.id,
    leaseHolder: lease.holder,
    leasedAt: lease.at,
  }
}

/** Phase transition to `damaged`: records the cause, drops the lease fields. */
function damageEntry(entry: WorktreeStateEntry, cause: WorktreeDamageCause): WorktreeStateEntry {
  return {
    name: entry.name,
    path: entry.path,
    createdAt: entry.createdAt,
    phase: 'damaged',
    cause,
    baseBranch: entry.baseBranch,
    ...entry.branch !== undefined ? { branch: entry.branch } : {},
  }
}

/**
 * Rebuild pool entries from the git worktree registry after a corrupt or
 * truncated state file (treehouse parity: entries are adopted without proof,
 * as `damaged` with cause `state-corrupt` until `verifyWorktrees` probes
 * them). Only worktrees under `poolRoot` are adopted; everything else is left
 * to git bookkeeping.
 * @returns the rebuilt entries, or null when the registry itself is unreadable.
 */
async function recoverEntriesFromDisk(
  git: GitService,
  repoRoot: string,
  poolRoot: string,
  signal?: AbortSignal,
): Promise<WorktreeStateEntry[] | null> {
  const list = await git.run(['worktree', 'list', '--porcelain'], { cwd: repoRoot, signal })
  if (list.exitCode !== 0) return null
  const prefix = poolRoot.endsWith(sep) ? poolRoot : `${poolRoot}${sep}`
  const entries: WorktreeStateEntry[] = []
  let current: { path?: string; branch?: string } | undefined
  const flush = (): void => {
    if (current?.path !== undefined && current.path.startsWith(prefix)) {
      const slot = dirname(current.path)
      entries.push({
        name: basename(slot),
        path: current.path,
        createdAt: new Date().toISOString(),
        phase: 'damaged',
        cause: 'state-corrupt',
        baseBranch: '',
        ...current.branch !== undefined ? { branch: current.branch } : {},
      })
    }
    current = undefined
  }
  for (const line of list.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush()
      current = { path: line.slice('worktree '.length) }
    } else if (line.startsWith('branch ')) {
      if (current !== undefined) current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
    // A bare `detached` line is implied for detached slots; no extra state.
  }
  flush()
  return entries
}

/**
 * Load pool state, recovering from a corrupt/truncated/foreign file by
 * rebuilding from `git worktree list` (entries adopted as damaged with cause
 * `state-corrupt`). Parsed entries are normalized to the current shape.
 */
async function loadState(
  git: GitService,
  repoRoot: string,
  poolRoot: string,
  signal?: AbortSignal,
): Promise<{ state: WorktreeState; recovered: boolean }> {
  const text = await readOptional(stateFilePath(poolRoot))
  if (text !== undefined && text.trim().length > 0) {
    const parsed = parseState(text)
    if (parsed !== null && parsed.repoRoot === repoRoot) {
      return { state: parsed, recovered: false }
    }
  }
  const rebuilt = (await recoverEntriesFromDisk(git, repoRoot, poolRoot, signal)) ?? []
  return { state: { schema: STATE_SCHEMA, repoRoot, worktrees: rebuilt }, recovered: true }
}

/* ── git predicates ────────────────────────────────────────────────────── */

/** True when the worktree has no tracked or untracked changes. */
async function isClean(git: GitService, worktreePath: string, signal?: AbortSignal): Promise<boolean> {
  const probe = await git.run(['status', '--porcelain', '--untracked-files=all'], { cwd: worktreePath, signal })
  return probe.exitCode === 0 && probe.stdout.trim().length === 0
}

/** True when the worktree HEAD is an ancestor of `target`. */
async function isMergedInto(
  git: GitService,
  worktreePath: string,
  target: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const probe = await gitMaybe(git, ['merge-base', '--is-ancestor', 'HEAD', target], worktreePath, signal)
  return probe.ok
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The repository's default branch: origin HEAD symbolic ref, then the current branch. */
async function inferDefaultBranch(git: GitService, repoRoot: string, signal?: AbortSignal): Promise<string> {
  const originHead = await gitMaybe(git, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoRoot, signal)
  if (originHead.ok) {
    const ref = originHead.stdout.trim()
    const prefix = 'refs/remotes/origin/'
    if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length)
  }
  const head = await gitMaybe(git, ['symbolic-ref', '--quiet', 'HEAD'], repoRoot, signal)
  if (head.ok) {
    const ref = head.stdout.trim()
    const prefix = 'refs/heads/'
    if (ref.startsWith(prefix) && ref.length > prefix.length) return ref.slice(prefix.length)
  }
  fail('DefaultBranchUnknown', `cannot infer the default branch of ${repoRoot}; set settings.baseBranch or pass base`)
}

async function resolveTarget(
  git: GitService,
  repoRoot: string,
  explicit: string | undefined,
  settings: WorktreeSettings,
  signal?: AbortSignal,
): Promise<string> {
  const base = explicit ?? settings.baseBranch
  if (base !== undefined && base.length > 0) return base
  return inferDefaultBranch(git, repoRoot, signal)
}

/** The pool owning a worktree path: `<poolRoot>/<slot>/<repoName>` → `<poolRoot>`. */
function poolRootFromLeasePath(worktreePath: string): string {
  return dirname(dirname(worktreePath))
}

/* ── acquire ───────────────────────────────────────────────────────────── */

/**
 * Acquire a durable lease on one clean worktree slot. A parked candidate is
 * re-probed before reuse — clean (`--untracked-files=all`), HEAD merged into
 * the reset target, directory present — and a failed probe records the slot
 * as damaged (with the matching cause) before a fresh slot is cut. Before
 * choosing, the auto-sweep may evict parked slots idle past
 * `settings.maxIdleMs` (see {@link sweepWorktrees}); a non-empty sweep
 * outcome is attached to the lease as `sweep`. Holding
 * the pool-state file lock for the whole choose-cut-reset cycle makes
 * concurrent acquires (in any process) serialize, and `withRepoLock` on the
 * repository's git common dir serializes with other in-process git mutations
 * of the same repository.
 *
 * The returned lease is the caller's durable ownership record:
 * `releaseWorktree` requires the exact `leaseId`, so a stale caller can never
 * release someone else's slot.
 * @param git - the git service.
 * @param cwd - any checkout (main or worktree) of the target repository.
 * @param settings - pool settings (root, default branch, fetch behavior).
 * @param options - per-acquire options (named branch, base, holder, noFetch, signal).
 * @returns the lease.
 */
export async function acquireWorktree(
  git: GitService,
  cwd: string,
  settings: WorktreeSettings = {},
  options: AcquireOptions = {},
): Promise<WorktreeLease> {
  abortGuard(options.signal)
  const repoRoot = await primaryRepoRoot(git, cwd, options.signal)
  const poolRoot = resolveWorktreePoolRoot(settings, repoRoot)
  await mkdir(poolRoot, { recursive: true })

  const target = await resolveTarget(git, repoRoot, options.base, settings, options.signal)

  return withFileLock(
    stateFilePath(poolRoot),
    async () => {
      // Serialize git mutations against other in-process callers of this repo.
      return withRepoLock(repoRoot, async () => {
        if (settings.fetchBeforeAcquire !== false && options.noFetch !== true) {
          const remote = await gitMaybe(git, ['remote', 'get-url', 'origin'], repoRoot, options.signal)
          if (remote.ok) {
            await gitChecked(git, ['fetch', 'origin'], repoRoot, options.signal)
          }
        }

        const { state } = await loadState(git, repoRoot, poolRoot, options.signal)
        let entries = state.worktrees
        let sweep: WorktreeSweepResult | undefined
        if (settings.autoPrune !== false) {
          // Auto-prune (terminal state): evict parked slots idle past the TTL
          // before choosing, so eviction also frees cap room. Persist at once —
          // a later throw (MaxSlots) must not lose the sweep.
          const swept = await sweepPoolEntries(git, repoRoot, entries, {
            maxIdleMs: settings.maxIdleMs ?? DEFAULT_MAX_IDLE_MS,
            now: Date.now(),
            settings,
            signal: options.signal,
          })
          entries = swept.entries
          state.worktrees = entries
          if (swept.mutated) {
            await writeFileAtomic(stateFilePath(poolRoot), serializeState(state), { mode: 0o600 })
          }
          if (!sweepResultIsEmpty(swept.result)) sweep = swept.result
        }
        const branch = options.branch

        // A reusable slot is a PARKED slot: released after the clean+merge
        // checks passed, and cut at the matching branch when a named branch
        // is requested (D5).
        const reusable = entries.find((entry) => {
          if (entry.phase !== 'parked') return false
          if (branch !== undefined && entry.branch !== branch) return false
          return true
        })

        const atCap = settings.maxSlots !== undefined && settings.maxSlots > 0
          && entries.length >= settings.maxSlots
        // A cap limits NEW slots only: proven reuse is always allowed.
        const cutNew = (): Promise<WorktreeStateEntry> => {
          if (atCap) {
            throw new WorktreeError(
              'MaxSlots',
              `pool "${poolRoot}" is at its maxSlots cap (${settings.maxSlots}): no new slot can be cut — release a lease, prune/destroy an idle slot, or raise maxSlots`,
              poolRoot,
            )
          }
          return cutNewSlot(git, repoRoot, poolRoot, entries, target, branch, options.signal)
        }

        let entry: WorktreeStateEntry
        if (reusable !== undefined) {
          const clean = await isClean(git, reusable.path, options.signal)
          const merged = await isMergedInto(git, reusable.path, target, options.signal)
          const present = await exists(reusable.path)
          if (clean && merged && present) {
            // Proven reusable: park it at the target, then lease it below.
            entry = await reuseSlot(git, reusable, target, branch, options.signal)
          } else {
            // The parked slot no longer satisfies the park invariant (external
            // mutation): record the damage so status reflects it, then cut fresh.
            const cause: WorktreeDamageCause = !present ? 'missing' : !clean ? 'dirty' : 'unmerged'
            state.worktrees = state.worktrees.map(item => item.path === reusable.path ? damageEntry(item, cause) : item)
            await writeFileAtomic(stateFilePath(poolRoot), serializeState(state), { mode: 0o600 })
            entry = await cutNew()
          }
        } else {
          entry = await cutNew()
        }

        const leasedAt = new Date().toISOString()
        const leaseId = randomBytes(16).toString('hex')
        const updated = leaseEntry(entry, {
          id: leaseId,
          holder: options.holder ?? 'dsh',
          at: leasedAt,
          baseBranch: options.base ?? settings.baseBranch ?? target,
          ...branch !== undefined ? { branch } : {},
        })
        state.worktrees = [
          ...state.worktrees.filter(item => !(item.name === updated.name && item.path === updated.path)),
          updated,
        ]
        await writeFileAtomic(stateFilePath(poolRoot), serializeState(state), { mode: 0o600 })

        return {
          path: updated.path,
          leaseId,
          leaseHolder: updated.leaseHolder ?? 'dsh',
          leasedAt,
          baseBranch: updated.baseBranch,
          ...branch !== undefined ? { branch } : {},
          ...(sweep !== undefined ? { sweep } : {}),
        }
      })
    },
    { waitMs: settings.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS },
  )
}

/** Park a proven-reusable slot at the reset target (named branch recreated — D5). */
async function reuseSlot(
  git: GitService,
  entry: WorktreeStateEntry,
  target: string,
  branch: string | undefined,
  signal?: AbortSignal,
): Promise<WorktreeStateEntry> {
  if (branch !== undefined) {
    await gitChecked(git, ['checkout', '-B', branch, target], entry.path, signal)
  } else {
    await gitChecked(git, ['checkout', '--detach', target], entry.path, signal)
  }
  return { ...entry, ...branch !== undefined ? { branch } : {} }
}

/** Cut a fresh slot: self-heal stale bookkeeping, then `worktree add`. */
async function cutNewSlot(
  git: GitService,
  repoRoot: string,
  poolRoot: string,
  entries: WorktreeStateEntry[],
  target: string,
  branch: string | undefined,
  signal?: AbortSignal,
): Promise<WorktreeStateEntry> {
  await gitChecked(git, ['worktree', 'prune'], repoRoot, signal)
  const used = new Set(entries.map(entry => entry.name))
  let slot = 1
  while (used.has(String(slot))) slot += 1
  const slotDir = join(poolRoot, String(slot))
  const path = join(slotDir, basename(repoRoot))
  if (branch !== undefined) {
    // The branch ref may already exist — e.g. a sweep evicted the slot but had to
    // retain its cut-branch (branch -d re-checks against the primary HEAD, not the
    // sweep target). Reuse it when merged into the target (mirroring the same-branch
    // reuse semantics: the slot force-resets the branch to the target); otherwise
    // fail with the pre-existing-branch error.
    const exists = await gitMaybe(git, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot, signal)
    if (exists.ok) {
      const merged = await gitMaybe(git, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, target], repoRoot, signal)
      if (!merged.ok) {
        throw new WorktreeError('GitFailed', `branch '${branch}' already exists and is not merged into ${target}`, repoRoot)
      }
      await gitChecked(git, ['worktree', 'add', path, branch], repoRoot, signal)
      await gitChecked(git, ['reset', '--hard', target], path, signal)
    } else {
      await gitChecked(git, ['worktree', 'add', '-b', branch, path, target], repoRoot, signal)
    }
  } else {
    await gitChecked(git, ['worktree', 'add', '--detach', path, target], repoRoot, signal)
  }
  return {
    name: String(slot),
    path,
    createdAt: new Date().toISOString(),
    phase: 'parked',
    parkedAt: new Date().toISOString(),
    baseBranch: '',
    ...branch !== undefined ? { branch } : {},
  }
}

/* ── release ───────────────────────────────────────────────────────────── */

/**
 * Release a leased worktree, clearing only the lease whose id matches. The
 * slot parks: a non-forced release requires a clean tree (tracked AND
 * untracked) and then resets HEAD to the recorded base (or the inferred
 * default) at detached HEAD; `force` additionally runs `git clean -fdqx`.
 * A refused dirty release fails with code `DirtyWorktree` and leaves the
 * lease and phase untouched (the slot does not become damaged).
 * D2: this engine never kills processes — a busy slot surfaces as a
 * {@link WorktreeError} with code `DirtyWorktree` instead.
 * @param git - the git service.
 * @param cwd - any checkout of the pool's repository (fallback pool resolution).
 * @param lease - the exact lease to release (`path` + `leaseId` from {@link acquireWorktree}).
 * @param options - `force`, `settings` (root), `signal`.
 */
export async function releaseWorktree(
  git: GitService,
  cwd: string,
  lease: { path: string; leaseId: string },
  options: { force?: boolean; settings?: WorktreeSettings; signal?: AbortSignal } = {},
): Promise<WorktreeReleaseResult> {
  abortGuard(options.signal)
  const repoRoot = await primaryRepoRoot(git, cwd, options.signal)
  // Prefer the pool the lease actually came from (settings-independent), then
  // fall back to the configured root so release still works after a restart
  // with a different tool config.
  let poolRoot = poolRootFromLeasePath(lease.path)
  if (await readOptional(stateFilePath(poolRoot)) === undefined) {
    poolRoot = resolveWorktreePoolRoot(options.settings ?? {}, repoRoot)
  }
  await mkdir(poolRoot, { recursive: true })
  return withFileLock(
    stateFilePath(poolRoot),
    async () => {
      const { state } = await loadState(git, repoRoot, poolRoot, options.signal)
      const entry = state.worktrees.find(item => item.path === lease.path)
      if (entry === undefined) fail('UnknownWorktree', `no pooled worktree at ${lease.path}`, lease.path)
      if (entry.leaseId !== lease.leaseId) {
        fail('LeaseMismatch', `lease ${lease.leaseId} does not own ${lease.path} (held by ${entry.leaseId ?? 'nobody'})`, lease.path)
      }
      return withRepoLock(repoRoot, async () => {
        if (!(await exists(lease.path))) {
          // The worktree is gone (external removal): drop the entry and prune bookkeeping.
          state.worktrees = state.worktrees.filter(item => item.path !== lease.path)
          await gitChecked(git, ['worktree', 'prune'], repoRoot, options.signal)
          await writeFileAtomic(stateFilePath(poolRoot), serializeState(state), { mode: 0o600 })
          return { path: lease.path, released: true }
        }
        const clean = await isClean(git, lease.path, options.signal)
        if (!clean && options.force !== true) {
          // A refused release is a failed transition: the lease stays intact so the
          // owner can repair the worktree and retry (the slot does not become damaged).
          fail('DirtyWorktree', `worktree ${lease.path} has uncommitted changes; commit them or pass force`, lease.path)
        }
        const target = entry.baseBranch.length > 0
          ? entry.baseBranch
          : await resolveTarget(git, repoRoot, undefined, {}, options.signal)
        await gitChecked(git, ['checkout', '--detach', target], lease.path, options.signal)
        await gitChecked(git, ['reset', '--hard', target], lease.path, options.signal)
        if (!clean && options.force === true) {
          await gitChecked(git, ['clean', '-fdqx'], lease.path, options.signal)
        }
        state.worktrees = state.worktrees.map(item => item.path !== lease.path ? item : parkEntry(item))
        await writeFileAtomic(stateFilePath(poolRoot), serializeState(state), { mode: 0o600 })
        return { path: lease.path, released: true }
      })
    },
    { waitMs: 30_000 },
  )
}

/* ── list / verify / prune / destroy ───────────────────────────────────── */

/**
 * Report every slot of the pool owning `cwd`. Read-only: it never mutates
 * pool state and never probes git per slot — the status comes from the
 * persisted slot phase, so externally mutated slots keep their recorded phase
 * until {@link verifyWorktrees} re-probes them (deliberate: a status read
 * never costs a per-slot git fork). The only git calls are the fixed pool
 * resolution plus the corrupt-state recovery sweep. `exists` is a filesystem
 * stat, and a slot whose directory is gone reports `damaged` from that fact.
 */
export async function listWorktrees(
  git: GitService,
  cwd: string,
  options: { settings?: WorktreeSettings; signal?: AbortSignal } = {},
): Promise<WorktreeStatus[]> {
  abortGuard(options.signal)
  const repoRoot = await primaryRepoRoot(git, cwd, options.signal)
  const poolRoot = resolveWorktreePoolRoot(options.settings ?? {}, repoRoot)
  const text = await readOptional(stateFilePath(poolRoot))
  if (text === undefined) return []
  let entries = parseState(text)?.worktrees
  if (entries === undefined) {
    // Corrupt/truncated state: report a read-only rebuild so damage is visible.
    entries = (await recoverEntriesFromDisk(git, repoRoot, poolRoot, options.signal)) ?? []
  }
  const result: WorktreeStatus[] = []
  for (const entry of entries) {
    const present = await exists(entry.path)
    const status: WorktreeStatus['status'] = !present
      ? 'damaged'
      : entry.phase === 'leased'
        ? 'leased'
        : entry.phase === 'damaged'
          ? 'damaged'
          : 'idle'
    result.push({
      name: entry.name,
      path: entry.path,
      status,
      leased: entry.phase === 'leased',
      ...entry.leaseId !== undefined ? { leaseId: entry.leaseId } : {},
      ...entry.leaseHolder !== undefined ? { leaseHolder: entry.leaseHolder } : {},
      ...entry.leasedAt !== undefined ? { leasedAt: entry.leasedAt } : {},
      baseBranch: entry.baseBranch,
      ...entry.branch !== undefined ? { branch: entry.branch } : {},
      ...entry.parkedAt !== undefined ? { parkedAt: entry.parkedAt } : {},
      dirty: entry.cause === 'dirty',
      merged: entry.phase === 'parked' && present,
      exists: present,
    })
  }
  return result
}

/**
 * Re-probe every non-leased slot of the pool owning `cwd` and refresh its
 * persisted phase: a slot that is present, clean (`--untracked-files=all`)
 * and merged into the reset target parks; any other result records `damaged`
 * with the matching cause (`missing`, `dirty`, or `unmerged`, in that
 * precedence). Leased slots are skipped — their owner mutates them
 * concurrently.
 *
 * Run this after external mutations: `listWorktrees`/`pruneWorktrees` read
 * the persisted phase and never probe, so this is the explicit refresh that
 * makes outside changes visible.
 * @param git - the git service.
 * @param cwd - any checkout (main or worktree) of the target repository.
 * @param options - `settings` overrides the pool root and base branch;
 *   `signal` aborts before the work starts.
 * @returns the refreshed statuses (same shape as {@link listWorktrees}).
 */
export async function verifyWorktrees(
  git: GitService,
  cwd: string,
  options: { settings?: WorktreeSettings; signal?: AbortSignal } = {},
): Promise<WorktreeStatus[]> {
  abortGuard(options.signal)
  const repoRoot = await primaryRepoRoot(git, cwd, options.signal)
  const poolRoot = resolveWorktreePoolRoot(options.settings ?? {}, repoRoot)
  await mkdir(poolRoot, { recursive: true })
  const target = await resolveTarget(git, repoRoot, undefined, options.settings ?? {}, options.signal).catch(() => '')
  await withFileLock(
    stateFilePath(poolRoot),
    async () => {
      const { state } = await loadState(git, repoRoot, poolRoot, options.signal)
      let mutated = false
      const refreshed: WorktreeStateEntry[] = []
      for (const entry of state.worktrees) {
        if (entry.phase === 'leased') {
          refreshed.push(entry)
          continue
        }
        const present = await exists(entry.path)
        const clean = present ? await isClean(git, entry.path, options.signal) : false
        const merged = present && target.length > 0
          ? await isMergedInto(git, entry.path, target, options.signal)
          : false
        const next = present && clean && merged
          ? parkEntry(entry, entry.phase === 'parked' ? entry.parkedAt : undefined)
          : damageEntry(entry, !present ? 'missing' : !clean ? 'dirty' : 'unmerged')
        if (next.phase !== entry.phase || next.cause !== entry.cause) mutated = true
        refreshed.push(next)
      }
      if (mutated) {
        await writeFileAtomic(stateFilePath(poolRoot), serializeState({ ...state, worktrees: refreshed }), { mode: 0o600 })
      }
    },
    { waitMs: DEFAULT_LOCK_WAIT_MS },
  )
  return listWorktrees(git, cwd, options)
}

/**
 * Produce (and with `yes`, execute) a prune plan for the pool owning `cwd`.
 * Only parked slots are candidates — leased and damaged slots are reported as
 * skipped, and a parked slot whose directory is gone is reported `missing`.
 * Parked slots are trusted as persisted for the dry-run report (the park
 * invariant: released only after the clean+merge checks passed); run
 * {@link verifyWorktrees} first when the worktrees may have been mutated
 * externally. The destructive `yes` path live-probes every parked slot for
 * dirtiness before removal, so an unprobed dirty slot is skipped in every
 * pool. `all` sweeps every pool under the configured root. Dry-run unless
 * `yes`.
 */
export async function pruneWorktrees(
  git: GitService,
  cwd: string,
  options: { yes?: boolean; all?: boolean; settings?: WorktreeSettings; signal?: AbortSignal } = {},
): Promise<WorktreePruneResult> {
  abortGuard(options.signal)
  const settings = options.settings ?? {}
  const repoRoot = await primaryRepoRoot(git, cwd, options.signal)
  const defaultPool = resolveWorktreePoolRoot(settings, repoRoot)
  const scopes: Array<{ repoRoot: string; poolRoot: string }> = [{ repoRoot, poolRoot: defaultPool }]

  if (options.all === true) {
    const base = dirname(defaultPool)
    let names: string[] = []
    try {
      names = (await readdir(base, { withFileTypes: true }))
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      names = []
    }
    for (const name of names) {
      const pool = join(base, name)
      if (pool === defaultPool) continue
      scopes.push({ repoRoot: '', poolRoot: pool })
    }
  }

  const candidates: WorktreePruneItem[] = []
  const skipped: WorktreePruneItem[] = []
  const removed: string[] = []
  for (const scope of scopes) {
    const text = await readOptional(stateFilePath(scope.poolRoot))
    if (text === undefined) continue
    const parsed = parseState(text)
    if (parsed === null) continue
    let mutated = false
    for (const entry of [...parsed.worktrees]) {
      if (entry.phase === 'leased') {
        skipped.push({ name: entry.name, path: entry.path, reason: 'leased' })
        continue
      }
      if (entry.phase === 'damaged') {
        skipped.push({ name: entry.name, path: entry.path, reason: `damaged (${entry.cause ?? 'state-corrupt'})` })
        continue
      }
      if (!(await exists(entry.path))) {
        skipped.push({ name: entry.name, path: entry.path, reason: 'missing' })
        continue
      }
      if (options.yes === true && !(await isClean(git, entry.path, options.signal))) {
        // Last-resort probe on the destructive path: a parked slot that was
        // dirtied externally (never re-verified) must not be force-removed.
        skipped.push({ name: entry.name, path: entry.path, reason: 'dirty (unprobed park)' })
        continue
      }
      candidates.push({ name: entry.name, path: entry.path, reason: 'removable' })
      if (options.yes === true) {
        await withRepoLock(parsed.repoRoot, async () => {
          await gitChecked(git, ['worktree', 'remove', '--force', entry.path], parsed.repoRoot, options.signal)
          await rm(dirname(entry.path), { recursive: true, force: true })
        })
        removed.push(entry.path)
        parsed.worktrees = parsed.worktrees.filter(item => item.path !== entry.path)
        mutated = true
      }
    }
    if (options.yes === true && mutated) {
      await writeFileAtomic(stateFilePath(scope.poolRoot), serializeState(parsed), { mode: 0o600 })
    }
  }
  return { candidates, skipped, removed }
}

/* ── sweep (auto-prune) ────────────────────────────────────────────────── */

/**
 * The sweep core. The caller MUST hold the pool-state file lock and the repo
 * lock: this mutates the entry list in memory and runs the slot removals,
 * but performs no locking and no state writes of its own, so
 * `acquireWorktree` can fold it into its own transaction while
 * {@link sweepWorktrees} wraps it in the standard two locks.
 *
 * Guards, in order — leased and damaged slots are never touched; a parked
 * slot without a usable `parkedAt` (legacy or corrupt) is stamped with the
 * current time (grace restart) and kept this round; a slot idle past the TTL
 * must then re-probe present + clean + merged (the park invariant) or it is
 * recorded damaged with the matching cause instead of removed; the removal
 * itself is the prune destructive path (`worktree remove --force` + rm).
 * An evicted slot's pool-owned cut-branch is deleted only when it is merged
 * into the reset target, enforced by `git branch -d` (which refuses unmerged
 * branches) — unmerged work is always retained.
 */

function sweepResultIsEmpty(result: WorktreeSweepResult): boolean {
  return result.evicted.length === 0
    && result.skipped.length === 0
    && result.deletedBranches.length === 0
    && result.retainedBranches.length === 0
}
async function sweepPoolEntries(
  git: GitService,
  repoRoot: string,
  entries: WorktreeStateEntry[],
  options: {
    maxIdleMs: number
    now: number
    settings: WorktreeSettings
    signal?: AbortSignal | undefined
  },
): Promise<{ entries: WorktreeStateEntry[]; result: WorktreeSweepResult; mutated: boolean }> {
  const evicted: WorktreeSweepResult['evicted'] = []
  const skipped: WorktreeSweepSkippedItem[] = []
  const deletedBranches: string[] = []
  const retainedBranches: WorktreeSweepBranchItem[] = []
  let mutated = false
  const remaining: WorktreeStateEntry[] = []

  // Shared fallback target for slots parked without an explicit base; each
  // entry's own baseBranch wins (same resolution as release). Unresolvable →
  // no eviction at all (the merge cannot be proven).
  const sharedTarget = await resolveTarget(git, repoRoot, undefined, options.settings, options.signal).catch(() => '')

  for (const entry of entries) {
    if (entry.phase !== 'parked') {
      remaining.push(entry)
      continue
    }
    const parkedAt = entry.parkedAt !== undefined && !Number.isNaN(Date.parse(entry.parkedAt))
      ? entry.parkedAt
      : undefined
    if (parkedAt === undefined) {
      // Legacy or corrupt entry: start its grace period now; a later sweep
      // sees a real age. Never evict on first sight.
      remaining.push({ ...entry, parkedAt: new Date(options.now).toISOString() })
      mutated = true
      continue
    }
    const idleMs = options.now - Date.parse(parkedAt)
    if (!(idleMs >= options.maxIdleMs)) {
      remaining.push(entry)
      continue
    }
    const target = entry.baseBranch.length > 0 ? entry.baseBranch : sharedTarget
    if (target.length === 0) {
      skipped.push({ name: entry.name, path: entry.path, reason: 'no-base' })
      remaining.push(entry)
      continue
    }
    const present = await exists(entry.path)
    const clean = present ? await isClean(git, entry.path, options.signal) : false
    const merged = present && clean ? await isMergedInto(git, entry.path, target, options.signal) : false
    if (!present || !clean || !merged) {
      // The park invariant broke (external mutation): record damage instead of
      // removing — the same precedence as the verify/acquire probes.
      const cause: WorktreeDamageCause = !present ? 'missing' : !clean ? 'dirty' : 'unmerged'
      skipped.push({ name: entry.name, path: entry.path, reason: cause })
      remaining.push(damageEntry(entry, cause))
      mutated = true
      continue
    }
    try {
      await gitChecked(git, ['worktree', 'remove', '--force', entry.path], repoRoot, options.signal)
      await rm(dirname(entry.path), { recursive: true, force: true })
    } catch (error) {
      skipped.push({
        name: entry.name,
        path: entry.path,
        reason: `remove failed (${error instanceof Error ? error.message : String(error)})`,
      })
      remaining.push(entry)
      continue
    }
    mutated = true
    evicted.push({
      name: entry.name,
      path: entry.path,
      ...entry.branch !== undefined ? { branch: entry.branch } : {},
    })
    if (entry.branch !== undefined) {
      const branchMerged = await gitMaybe(
        git,
        ['merge-base', '--is-ancestor', `refs/heads/${entry.branch}`, target],
        repoRoot,
        options.signal,
      )
      if (branchMerged.ok) {
        const deleted = await gitMaybe(git, ['branch', '-d', entry.branch], repoRoot, options.signal)
        if (deleted.ok) {
          deletedBranches.push(entry.branch)
        } else {
          retainedBranches.push({ branch: entry.branch, reason: deleted.stderr.trim() || 'branch delete refused' })
        }
      } else {
        retainedBranches.push({ branch: entry.branch, reason: 'unmerged' })
      }
    }
  }
  return { entries: remaining, result: { evicted, skipped, deletedBranches, retainedBranches }, mutated }
}

/**
 * Sweep the pool owning `cwd`: evict parked slots idle past `maxIdleMs`
 * (stamped `parkedAt` at park time) after re-probing them clean and merged,
 * and delete each evicted slot's pool-owned cut-branch when it is merged
 * into the reset target. Leased and damaged slots are never touched; a
 * parked slot that fails the re-probe is recorded damaged, not removed; a
 * legacy entry without `parkedAt` gets stamped (grace restart) and kept.
 * `acquireWorktree` runs this automatically before choosing a slot (disable
 * with `settings.autoPrune === false`); this export is the manual path with
 * the same locks and guards.
 * @param git - the git service.
 * @param cwd - any checkout (main or worktree) of the target repository.
 * @param options - `settings` (root, base branch, `maxIdleMs`, `lockWaitMs`
 *   are honored; `autoPrune` only gates the acquire-time run), `maxIdleMs`
 *   override, `signal`.
 * @returns what the sweep did (evictions, refusals, branch outcomes).
 */
export async function sweepWorktrees(
  git: GitService,
  cwd: string,
  options: { settings?: WorktreeSettings; maxIdleMs?: number; signal?: AbortSignal } = {},
): Promise<WorktreeSweepResult> {
  abortGuard(options.signal)
  const settings = options.settings ?? {}
  const repoRoot = await primaryRepoRoot(git, cwd, options.signal)
  const poolRoot = resolveWorktreePoolRoot(settings, repoRoot)
  await mkdir(poolRoot, { recursive: true })
  const maxIdleMs = options.maxIdleMs ?? settings.maxIdleMs ?? DEFAULT_MAX_IDLE_MS
  return withFileLock(
    stateFilePath(poolRoot),
    async () => withRepoLock(repoRoot, async () => {
      const { state } = await loadState(git, repoRoot, poolRoot, options.signal)
      const swept = await sweepPoolEntries(git, repoRoot, state.worktrees, {
        maxIdleMs,
        now: Date.now(),
        settings,
        signal: options.signal,
      })
      if (swept.mutated) {
        await writeFileAtomic(stateFilePath(poolRoot), serializeState({ ...state, worktrees: swept.entries }), { mode: 0o600 })
      }
      return swept.result
    }),
    { waitMs: settings.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS },
  )
}

/**
 * Destroy one pooled slot. Dry-run unless `yes`. Defaults refuse leased slots
 * (`includeLeased`) and dirty or unmerged work (`includeUnlanded`) — the same
 * guards as treehouse, with the same irreversible-data-loss semantics for the
 * unlanded case. Unlike status reads, the destructive path keeps its live
 * clean/merge probes as the last data-loss guard.
 */
export async function destroyWorktree(
  git: GitService,
  cwd: string,
  options: {
    /** Slot name (pool-relative) or absolute path under the pool. */
    name?: string
    path?: string
    yes?: boolean
    includeLeased?: boolean
    includeUnlanded?: boolean
    settings?: WorktreeSettings
    signal?: AbortSignal
  },
): Promise<WorktreeDestroyResult> {
  abortGuard(options.signal)
  const repoRoot = await primaryRepoRoot(git, cwd, options.signal)
  const poolRoot = resolveWorktreePoolRoot(options.settings ?? {}, repoRoot)
  const { state } = await loadState(git, repoRoot, poolRoot, options.signal)
  const entry = options.path !== undefined
    ? state.worktrees.find(item => item.path === options.path)
    : options.name !== undefined
      ? state.worktrees.find(item => item.name === options.name)
      : undefined
  if (entry === undefined) fail('UnknownWorktree', `no pooled worktree named ${String(options.name ?? options.path)}`, options.path)
  if (entry.phase === 'leased' && options.includeLeased !== true) {
    fail('LeasedWorktree', `worktree ${entry.path} is leased (${entry.leaseId ?? 'unverified'}); pass includeLeased to destroy`, entry.path)
  }
  if (options.yes !== true) {
    return { path: entry.path, removed: false }
  }
  return withFileLock(
    stateFilePath(poolRoot),
    async () => withRepoLock(repoRoot, async () => {
      const clean = await isClean(git, entry.path, options.signal)
      const target = await resolveTarget(git, repoRoot, undefined, {}, options.signal).catch(() => '')
      const merged = target.length > 0
        ? await isMergedInto(git, entry.path, target, options.signal)
        : clean
      if (!clean && options.includeUnlanded !== true) {
        fail('UnlandedWorktree', `worktree ${entry.path} is dirty; pass includeUnlanded to discard (irreversible)`, entry.path)
      }
      if (!merged && !clean && options.includeUnlanded !== true) {
        fail('UnlandedWorktree', `worktree ${entry.path} has unmerged work; pass includeUnlanded to discard (irreversible)`, entry.path)
      }
      await gitChecked(git, ['worktree', 'remove', '--force', entry.path], repoRoot, options.signal)
      await rm(dirname(entry.path), { recursive: true, force: true })
      const fresh = await loadState(git, repoRoot, poolRoot, options.signal)
      fresh.state.worktrees = fresh.state.worktrees.filter(item => item.path !== entry.path)
      await writeFileAtomic(stateFilePath(poolRoot), serializeState(fresh.state), { mode: 0o600 })
      return { path: entry.path, removed: true }
    }),
    { waitMs: 30_000 },
  )
}
