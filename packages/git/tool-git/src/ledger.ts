/**
 * Findings ledger for the review tool: one JSON document per repository that
 * records the latest full review per branch.
 *
 * The document lives at `<git-common-dir>/dsh-review/ledger.json`. The common
 * dir is shared by every worktree of one repository and sits outside the
 * tracked tree, so ledger files are never staged. A later `review` call with
 * `mode: "verify"` reads the record for the current branch and closes its
 * findings against the changes made since that review.
 *
 * The same document also holds the push gate's verdict records under
 * `gate:<target>` keys; git refnames cannot contain `:`, so those keys can
 * never collide with a branch key. A gate record survives restarts, and the
 * gate re-checks its identity against the current push on every read (see
 * `push-gate.ts`).
 *
 * Missing or corrupt documents read as empty; the next full review rewrites
 * them, so a damaged ledger degrades to "no record" instead of failing.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { withRepoLock } from '@deepseek-ai/dsh-git'
import type { GitService } from '@deepseek-ai/dsh-git'
import type { ReviewTarget } from './push-gate.ts'
import type { ReviewFinding } from './review.ts'

/** Branch records kept per ledger document, trimmed LRU by `reviewedAt`. */
export const LEDGER_BRANCH_CAP = 20

/** One finding of a recorded full review, carrying its stable ledger id. */
export interface LedgerFinding extends ReviewFinding {
  /** Stable id (`F1`, `F2`, …) assigned in severity order at write time. */
  id: string
}

/** One branch's latest full-review record. */
export interface LedgerRecord {
  version: 1
  branch: string
  /** Diff surface the full review examined. */
  target: ReviewTarget
  /** `base..head` range, present only for `commits` reviews. */
  range?: string
  /** HEAD at review time (commits target: range tip) — the verify delta base. */
  headSha: string
  /** sha256 of the reviewed diff text. */
  diffHash: string
  files: string[]
  verdict: 'ship' | 'reject'
  /** Wall-clock time of the review, also the LRU key for the branch cap. */
  reviewedAt: number
  findings: LedgerFinding[]
}

/** The ledger document: branch key → that branch's latest record. */
export type LedgerDocument = Record<string, LedgerRecord>

/**
 * One push-gate verdict persisted under a `gate:<target>` ledger key,
 * identity-bound to the review it judged.
 *
 * Written when a review verdict is recorded (`recordReviewVerdictDurable` in
 * `push-gate.ts`) and read back by the gate loader (`loadStagedVerdict`); the
 * in-process memo stays the hot path, and the ledger makes verdicts survive
 * restarts. The stored `state` is the gate state resolved at write time — a
 * record always matches its own identity, so only `ship` and `rejected` can
 * occur; the gate re-evaluates the full state transition against the
 * push-time identity on every read.
 */
export interface GateVerdictRecord {
  version: 1
  /** Review surface the verdict covers — one record per target. */
  target: ReviewTarget
  /** Gate state resolved at write time (`ship` or `rejected`). */
  state: 'ship' | 'rejected'
  verdict: 'ship' | 'reject'
  /** Commit identity: HEAD at review time. */
  beforeHead: string
  /** Commit identity: index tree at review time, null when it could not be written. */
  indexTree: string | null
  /** Wall-clock time of the review run (`ReviewVerdictRecord.at`). */
  at: number
  /** Wall-clock time of the ledger write. */
  recordedAt: number
}

/** Ledger-key prefix of gate verdict records. */
const GATE_KEY_PREFIX = 'gate:'

/** Ledger key holding one target's gate verdict record. */
function gateKeyOf(target: string): string {
  return `${GATE_KEY_PREFIX}${target}`
}

function isGateKey(key: string): boolean {
  return key.startsWith(GATE_KEY_PREFIX)
}

function gateTargetOf(key: string): string {
  return key.slice(GATE_KEY_PREFIX.length)
}

/**
 * Whether a parsed ledger value is a gate verdict record. Structural only:
 * a record missing required fields or carrying unknown values reads as
 * absent, so a damaged record fails closed instead of releasing a push.
 */
function isGateVerdictRecord(value: unknown): value is GateVerdictRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Partial<GateVerdictRecord>
  return candidate.version === 1
    && typeof candidate.target === 'string'
    && (candidate.state === 'ship' || candidate.state === 'rejected')
    && (candidate.verdict === 'ship' || candidate.verdict === 'reject')
    && typeof candidate.beforeHead === 'string'
    && (typeof candidate.indexTree === 'string' || candidate.indexTree === null)
    && typeof candidate.at === 'number'
    && typeof candidate.recordedAt === 'number'
}

/**
 * sha256 hex digest of one diff text — the ledger's change identity.
 * @param diffText - the reviewed diff.
 * @returns the digest stored as `LedgerRecord.diffHash`.
 */
export function diffHashOf(diffText: string): string {
  return createHash('sha256').update(diffText, 'utf8').digest('hex')
}

/**
 * Assign stable ledger ids (`F1`, `F2`, …) in list order.
 * @param findings - findings already sorted by severity, so ids follow
 * severity order.
 * @returns the findings with ledger ids attached.
 */
export function toLedgerFindings(findings: readonly ReviewFinding[]): LedgerFinding[] {
  return findings.map((finding, index) => ({ ...finding, id: `F${index + 1}` }))
}

/**
 * Ledger key for the reviewed state: the branch name, or `DETACHED-<sha8>`
 * when HEAD is detached.
 */
export async function ledgerBranchKey(
  git: GitService,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const branch = await git.branch(cwd, signal)
  if (branch !== undefined) return branch
  const run = await git.run(['rev-parse', 'HEAD'], { cwd, signal })
  return `DETACHED-${run.stdout.trim().slice(0, 8)}`
}

/**
 * Resolve one revision to its full hash.
 * @returns the hash, or '' when the revision does not resolve (an unborn
 * HEAD); the record still writes and verify fails closed on the empty base.
 */
export async function resolveRev(
  git: GitService,
  cwd: string,
  signal: AbortSignal | undefined,
  rev: string,
): Promise<string> {
  const run = await git.run(['rev-parse', rev], { cwd, signal })
  return run.exitCode === 0 ? run.stdout.trim() : ''
}

/**
 * Absolute path of the ledger document under the repository's git common dir.
 * @throws when the common dir cannot be resolved (cwd outside a repository).
 */
export async function ledgerPath(
  git: GitService,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const run = await git.run(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, signal })
  const commonDir = run.stdout.trim()
  if (run.exitCode !== 0 || commonDir.length === 0) {
    throw new Error(`cannot resolve the git common directory for the findings ledger: ${run.stderr.trim()}`)
  }
  return join(commonDir, 'dsh-review', 'ledger.json')
}

/**
 * Read the ledger document.
 * @returns the document; missing files, corrupt JSON, and non-document JSON
 * all read as empty.
 */
export async function readLedger(
  git: GitService,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<LedgerDocument> {
  return (await readLedgerFile(await ledgerPath(git, cwd, signal))).branches
}

/** Raw ledger split: branch records plus gate verdict records, both empty when the file is missing, corrupt, or not a document. */
interface RawLedger {
  branches: LedgerDocument
  gates: Record<string, GateVerdictRecord>
}

/**
 * Read the gate verdict record stored for one review target.
 * @param target - the review surface whose verdict to read.
 * @returns the record, or undefined when no verdict is stored for the target
 * (a damaged stored record also reads as absent).
 */
export async function readGateVerdict(
  git: GitService,
  cwd: string,
  signal: AbortSignal | undefined,
  target: ReviewTarget,
): Promise<GateVerdictRecord | undefined> {
  const raw = await readLedgerFile(await ledgerPath(git, cwd, signal))
  return raw.gates[target]
}

async function readLedgerFile(path: string): Promise<RawLedger> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    // No ledger yet: the first full review creates it.
    return { branches: {}, gates: {} }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isLedgerDocument(parsed)) {
      // Valid JSON that is not a ledger document: treated as empty.
      return { branches: {}, gates: {} }
    }
    const raw: RawLedger = { branches: {}, gates: {} }
    for (const [key, value] of Object.entries(parsed)) {
      if (isGateKey(key)) {
        if (isGateVerdictRecord(value)) raw.gates[gateTargetOf(key)] = value
      } else {
        raw.branches[key] = value
      }
    }
    return raw
  } catch {
    // Truncated JSON: treated as empty; the next full review rewrites it.
    return { branches: {}, gates: {} }
  }
}

/** Whether parsed JSON is a ledger document. Individual records are trusted — the writer is this process. */
function isLedgerDocument(value: unknown): value is LedgerDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Store one branch record, trimming the branch records to the
 * {@link LEDGER_BRANCH_CAP} most recently reviewed; gate verdict records
 * (`gate:<target>` keys) are preserved untouched.
 *
 * The read-modify-write runs under the repository write lock keyed on the
 * resolved ledger path: every worktree of one repository resolves the same
 * `<git-common-dir>/dsh-review/ledger.json`, and `withRepoLock` maps that
 * path to the primary repo root (or falls back to the path itself when the
 * common dir lies outside any work tree), so concurrent ledger writes from
 * different worktrees serialize on one key instead of racing on the shared
 * document. The document is replaced atomically by writing a sibling temp
 * file and renaming it over the target, so a failed write never truncates
 * the previous content.
 * @param record - the record to keep under its branch key.
 */
export async function writeLedger(
  git: GitService,
  cwd: string,
  signal: AbortSignal | undefined,
  record: LedgerRecord,
): Promise<void> {
  const path = await ledgerPath(git, cwd, signal)
  await withRepoLock(path, async () => {
    const raw = await readLedgerFile(path)
    raw.branches[record.branch] = record
    const kept = Object.entries(raw.branches)
      .sort(([, a], [, b]) => b.reviewedAt - a.reviewedAt)
      .slice(0, LEDGER_BRANCH_CAP)
    const next: Record<string, LedgerRecord | GateVerdictRecord> = {}
    for (const [branch, entry] of kept) next[branch] = entry
    for (const [target, entry] of Object.entries(raw.gates)) next[gateKeyOf(target)] = entry
    await mkdir(dirname(path), { recursive: true })
    await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`)
  }, signal)
}

/**
 * Store one gate verdict record under `gate:<target>`, replacing the
 * target's previous record. Branch records and other targets' gate records
 * are preserved untouched, and the branch cap never trims gate records.
 *
 * Same discipline as {@link writeLedger}: the read-modify-write runs under
 * the repository write lock keyed on the resolved ledger path, and the
 * document is replaced atomically.
 */
export async function writeGateVerdict(
  git: GitService,
  cwd: string,
  signal: AbortSignal | undefined,
  record: GateVerdictRecord,
): Promise<void> {
  const path = await ledgerPath(git, cwd, signal)
  await withRepoLock(path, async () => {
    const raw = await readLedgerFile(path)
    const next: Record<string, LedgerRecord | GateVerdictRecord> = {}
    for (const [branch, entry] of Object.entries(raw.branches)) next[branch] = entry
    for (const [target, entry] of Object.entries(raw.gates)) next[gateKeyOf(target)] = entry
    next[gateKeyOf(record.target)] = record
    await mkdir(dirname(path), { recursive: true })
    await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`)
  }, signal)
}

/** Replace `path` atomically: write a sibling temp file, then rename it over the target. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, path)
  } finally {
    // A leftover temp is harmless, and cleanup must not mask the write error.
    await rm(temp, { force: true }).catch(() => undefined)
  }
}
