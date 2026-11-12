/**
 * P2 same-quality gate: no unreviewed change leaves the repository under a
 * `review-gated` posture. `review --target staged` records a verdict over the
 * exact staged range (pre-commit HEAD + index tree identity); `commit_apply
 * --push` consults it before touching `origin` and refuses when the verdict is
 * missing, stale, non-staged, or `reject`. Fail-closed by default.
 *
 * Verdicts live in this process (one host = one tool-git instance) and are
 * mirrored into the findings ledger (`<git-common-dir>/dsh-review/ledger.json`
 * under `gate:<target>` keys, see `./ledger.ts`) so a host restart recovers the
 * latest verdict instead of forgetting it. Recovery stays fail-closed: the gate
 * re-checks a verdict's identity (beforeHead + indexTree + target) against the
 * current push on every read — from the memo or from the ledger alike — so a
 * restart can never flip a blocked push to allowed unless the staged range is
 * provably the one that was reviewed.
 * @module @deepseek-ai/dsh-tool-git/push-gate
 */

import type { GitService } from '@deepseek-ai/dsh-git'
import { readGateVerdict, writeGateVerdict } from './ledger.ts'

/** The review targets that can produce a verdict. */
export type ReviewTarget = 'worktree' | 'staged' | 'commits'

/** One review verdict, keyed by repository root + target. */
export interface ReviewVerdictRecord {
  /** Repository root (`git rev-parse --show-toplevel`) of the reviewed checkout. */
  root: string
  /** Which diff the reviewers actually saw. */
  target: ReviewTarget
  verdict: 'ship' | 'reject'
  /** HEAD hash when the review ran — part of the staged-range identity. */
  beforeHead: string
  /** Index tree (`git write-tree`) when the review ran — null when unreadable. */
  indexTree: string | null
  /** Epoch ms of the review run (diagnostics only; staleness is identity-based). */
  at: number
}

/** Per-root record sets keep one record per target (a later worktree review must not shadow a staged verdict). */
type RecordSet = { [T in ReviewTarget]?: ReviewVerdictRecord }

const verdicts = new Map<string, RecordSet>()

/** Record (or replace) one review verdict. */
export function recordReviewVerdict(record: ReviewVerdictRecord): void {
  const set = verdicts.get(record.root) ?? {}
  set[record.target] = record
  verdicts.set(record.root, set)
}

/** Latest staged-target verdict for a repository root, if any. */
export function latestStagedVerdict(root: string): ReviewVerdictRecord | undefined {
  return verdicts.get(root)?.staged
}

/** Test-only: drop all recorded verdicts. */
export function clearReviewVerdicts(): void {
  verdicts.clear()
}

/** Read the index tree identity; null when the index is unreadable (e.g. conflicts). */
export async function indexTreeOf(git: GitService, cwd: string, signal: AbortSignal | undefined): Promise<string | null> {
  const run = await git.run(['write-tree'], { cwd, signal })
  return run.exitCode === 0 ? run.stdout.trim() : null
}

/** Current HEAD hash identity; '' when unborn. */
export async function headOf(git: GitService, cwd: string, signal: AbortSignal | undefined): Promise<string> {
  // Unborn branches (no commits yet) exit non-zero: report '' so the gate can
  // never match a recorded verdict on a repo that had no HEAD at review time.
  const run = await git.run(['log', '-1', '--format=%H'], { cwd, signal })
  return run.exitCode === 0 ? run.stdout.trim() : ''
}

/** Named states of the push-gate verdict state machine. */
export type GateState = 'absent' | 'wrong-target' | 'stale-head' | 'stale-tree' | 'rejected' | 'ship'

/**
 * One resolved gate transition: the named state plus the verdict record that
 * produced it (`absent` has none). `gateStateOf` resolves the identity and
 * verdict facts into this closed union; `gateDecisionOf` maps a state to the
 * allow/refuse decision, so each reason string lives in exactly one place.
 */
export type GateTransition =
  | { state: 'absent' }
  | { state: Exclude<GateState, 'absent'>; record: ReviewVerdictRecord }

function assertNever(value: never): never {
  throw new Error(`unreachable gate state: ${String(value)}`)
}

/**
 * Resolve the gate state for one push from the recorded verdict and the
 * push-time identity. Order is load-bearing for the reason strings: target
 * mismatch outranks identity staleness, and staleness outranks the verdict
 * comparison, exactly like the previous if-chain.
 * @param record - the latest staged review verdict (undefined = never reviewed).
 * @param beforeHead - HEAD identity at `commit_apply` start.
 * @param indexTree - index tree identity at `commit_apply` start (null = unreadable).
 * @param requireVerdict - the verdict that releases a push.
 * @returns the resolved gate transition.
 */
export function gateStateOf(args: {
  record: ReviewVerdictRecord | undefined
  beforeHead: string
  indexTree: string | null
  requireVerdict: 'ship'
}): GateTransition {
  const { record, beforeHead, indexTree, requireVerdict } = args
  if (record === undefined) return { state: 'absent' }
  if (record.target !== 'staged') return { state: 'wrong-target', record }
  if (record.beforeHead !== beforeHead) return { state: 'stale-head', record }
  if (record.indexTree !== indexTree) return { state: 'stale-tree', record }
  if (record.verdict !== requireVerdict) return { state: 'rejected', record }
  return { state: 'ship', record }
}

export interface PushGateDecision {
  /**
   * Named state the decision was reached from. The explicit `fast` posture
   * consults no verdict and reports `absent`.
   */
  state: GateState
  allowed: boolean
  /** Success path note (recorded in tool `warnings`) or the refusal reason. */
  reason: string
}

/** Refusal-suffix appended when `onUnavailable: warn` degrades a blocking state to an allowed push. */
const UNAVAILABLE_WARN_SUFFIX = '; pushing anyway because `reviewGate.onUnavailable: warn`'

/**
 * Map one resolved gate transition to the allow/refuse decision. Fail-closed:
 * only a current `ship` verdict releases a push. `absent` and `wrong-target`
 * honor `onUnavailable`; `stale-head`, `stale-tree`, and `rejected` always
 * block.
 * @param transition - the state resolved by `gateStateOf`.
 * @param requireVerdict - the verdict that releases a push.
 * @param onUnavailable - `block` (fail-closed) or `warn` (loud degrade) for the
 *                        states that can degrade. A `reject` verdict or a
 *                        stale/mismatched identity ALWAYS blocks.
 * @returns the gate decision.
 */
export function gateDecisionOf(
  transition: GateTransition,
  requireVerdict: 'ship',
  onUnavailable: 'block' | 'warn',
): PushGateDecision {
  switch (transition.state) {
    case 'absent': {
      const reason = 'commit_apply --push is gated but this staged range has never been reviewed — run `review --target staged` first'
      return onUnavailable === 'block'
        ? { state: 'absent', allowed: false, reason: `${reason} (or record an explicit \`fast\` posture for this repository)` }
        : { state: 'absent', allowed: true, reason: `${reason}${UNAVAILABLE_WARN_SUFFIX}` }
    }
    case 'wrong-target': {
      const reason = `the latest review targeted \`${transition.record.target}\`, not the staged range — run \`review --target staged\``
      return onUnavailable === 'block'
        ? { state: 'wrong-target', allowed: false, reason }
        : { state: 'wrong-target', allowed: true, reason: `${reason}${UNAVAILABLE_WARN_SUFFIX}` }
    }
    case 'stale-head':
      return {
        state: 'stale-head',
        allowed: false,
        reason: 'stale review verdict — HEAD moved since the review; re-run `review --target staged`',
      }
    case 'stale-tree':
      return {
        state: 'stale-tree',
        allowed: false,
        reason: 'stale review verdict — the staged tree changed since the review; re-run `review --target staged`',
      }
    case 'rejected':
      return {
        state: 'rejected',
        allowed: false,
        reason: `the review verdict was \`${transition.record.verdict}\`, not \`${requireVerdict}\` — fix the findings and re-run \`review --target staged\``,
      }
    case 'ship':
      return {
        state: 'ship',
        allowed: true,
        reason: `push gated: latest staged review returned \`${transition.record.verdict}\` for the current staged range`,
      }
    default:
      return assertNever(transition)
  }
}

/**
 * Decide whether one `commit_apply --push` may proceed under the review gate.
 * @param posture - the repository's resolved standing posture.
 * @param record - the latest staged review verdict (undefined = never reviewed).
 * @param beforeHead - HEAD identity at `commit_apply` start.
 * @param indexTree - index tree identity at `commit_apply` start (null = unreadable).
 * @param requireVerdict - the verdict that releases a push.
 * @param onUnavailable - `block` (fail-closed) or `warn` (loud degrade) when no
 *                        current `ship` verdict exists. A `reject` verdict or a
 *                        stale/mismatched identity ALWAYS blocks.
 * @returns the gate decision, carrying its named {@link GateState}.
 */
export function decidePushGate(args: {
  posture: 'review-gated' | 'fast'
  record: ReviewVerdictRecord | undefined
  beforeHead: string
  indexTree: string | null
  requireVerdict: 'ship'
  onUnavailable: 'block' | 'warn'
}): PushGateDecision {
  if (args.posture === 'fast') {
    // No verdict is consulted: the gate is not in effect for this repository.
    return { state: 'absent', allowed: true, reason: 'push gate skipped: this repository has an explicit `fast` posture' }
  }
  return gateDecisionOf(gateStateOf(args), args.requireVerdict, args.onUnavailable)
}

/**
 * Record one review verdict in the in-process memo AND in the findings ledger
 * (`gate:<target>` key), so the verdict survives a host restart. The memo write
 * happens first (hot path); a failed ledger write surfaces to the caller, which
 * reports it loudly — the verdict then lives only in this process, and a
 * restart reads no verdict, which fails closed.
 * @param git - the git service used for the ledger write.
 * @param cwd - working directory of the reviewed checkout.
 * @param signal - abort signal for the ledger write.
 * @param record - the verdict to record.
 */
export async function recordReviewVerdictDurable(
  git: GitService,
  cwd: string,
  signal: AbortSignal | undefined,
  record: ReviewVerdictRecord,
): Promise<void> {
  recordReviewVerdict(record)
  await writeGateVerdict(git, cwd, signal, {
    version: 1,
    target: record.target,
    state: record.verdict === 'ship' ? 'ship' : 'rejected',
    verdict: record.verdict,
    beforeHead: record.beforeHead,
    indexTree: record.indexTree,
    at: record.at,
    recordedAt: Date.now(),
  })
}

/**
 * Load the staged verdict for a repository root: the in-process memo first,
 * falling back to the ledger record persisted by
 * {@link recordReviewVerdictDurable} (a restart emptied the memo but the
 * ledger survives). The recovered record re-enters the memo and goes through
 * the same identity check as any other verdict, so a restart never releases a
 * push whose staged range no longer matches.
 * @param git - the git service used for the ledger read.
 * @param cwd - working directory of the checkout being pushed.
 * @param signal - abort signal for the ledger read.
 * @param root - repository root (memo key).
 * @returns the staged verdict record, or undefined when neither memo nor
 * ledger holds one.
 */
export async function loadStagedVerdict(
  git: GitService,
  cwd: string,
  signal: AbortSignal | undefined,
  root: string,
): Promise<ReviewVerdictRecord | undefined> {
  const memo = latestStagedVerdict(root)
  if (memo !== undefined) return memo
  const stored = await readGateVerdict(git, cwd, signal, 'staged')
  if (stored === undefined) return undefined
  const record: ReviewVerdictRecord = {
    root,
    target: stored.target,
    verdict: stored.verdict,
    beforeHead: stored.beforeHead,
    indexTree: stored.indexTree,
    at: stored.at,
  }
  recordReviewVerdict(record)
  return record
}
