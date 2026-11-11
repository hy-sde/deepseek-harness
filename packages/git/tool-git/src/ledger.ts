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
 * Missing or corrupt documents read as empty; the next full review rewrites
 * them, so a damaged ledger degrades to "no record" instead of failing.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
  return readLedgerFile(await ledgerPath(git, cwd, signal))
}

async function readLedgerFile(path: string): Promise<LedgerDocument> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    // No ledger yet: the first full review creates it.
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (isLedgerDocument(parsed)) return parsed
    // Valid JSON that is not a ledger document: treated as empty.
    return {}
  } catch {
    // Truncated JSON: treated as empty; the next full review rewrites it.
    return {}
  }
}

/** Whether parsed JSON is a ledger document. Individual records are trusted — the writer is this process. */
function isLedgerDocument(value: unknown): value is LedgerDocument {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Store one branch record, trimming the document to the
 * {@link LEDGER_BRANCH_CAP} most recently reviewed branches.
 * @param record - the record to keep under its branch key.
 */
export async function writeLedger(
  git: GitService,
  cwd: string,
  signal: AbortSignal | undefined,
  record: LedgerRecord,
): Promise<void> {
  const path = await ledgerPath(git, cwd, signal)
  const records = await readLedgerFile(path)
  records[record.branch] = record
  const kept = Object.entries(records)
    .sort(([, a], [, b]) => b.reviewedAt - a.reviewedAt)
    .slice(0, LEDGER_BRANCH_CAP)
  const next: LedgerDocument = {}
  for (const [branch, entry] of kept) next[branch] = entry
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
}
