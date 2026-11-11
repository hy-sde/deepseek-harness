/**
 * The `review` tool: fan out dedicated reviewer subagents in parallel over a
 * git diff (working tree, staged, or a commit range), collect P0–P3 findings
 * with confidence, and produce a ship/reject verdict.
 *
 * Port of omp's `/review` for the harness. omp's reviewer persona
 * (`prompts/agents/reviewer.md`) is adapted into a plain prompt handed to
 * `ctx.subagents` children with a typed `outputSchema`, so each reviewer
 * returns structured verdict + findings instead of prose; aggregation is local.
 * See port_omp.md item: commit/review.
 *
 * Mode "full" (default) records its result in a per-branch findings ledger
 * (see `./ledger.ts`). Mode "verify" reads that record, re-reviews only what
 * changed since it, and asks reviewers to close each prior finding; it fails
 * closed when no record exists for the branch or history was rewritten since
 * the review.
 * @module @deepseek-ai/dsh-tool-git/review
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { parseFileDiffs } from '@deepseek-ai/dsh-git'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-spill'
import { resolveCwd } from './commit.ts'
import { diffHashOf, ledgerBranchKey, readLedger, resolveRev, toLedgerFindings, writeLedger, type LedgerFinding, type LedgerRecord } from './ledger.ts'
import { openReads, type ReadSurface } from './reads.ts'
import { headOf, indexTreeOf, recordReviewVerdict, type ReviewTarget } from './push-gate.ts'
import type { GitService } from '@deepseek-ai/dsh-git'

/** Configuration consumed by the review tool. */
export interface ReviewToolConfig {
  /** `ctx.subagents` provider name to run reviewers on (default `spawn`). */
  provider?: string
  /** Default cap on parallel reviewers (default 4). */
  maxReviewers?: number
  /** Total inline diff character cap per reviewer; larger slices use spillStore (default 40000). */
  maxReviewerDiffChars?: number
}

const DEFAULT_PROVIDER = 'spawn'
const DEFAULT_MAX_REVIEWERS = 4
const DEFAULT_MAX_REVIEWER_DIFF_CHARS = 40_000

type FindingPriority = 'P0' | 'P1' | 'P2' | 'P3'

interface ReviewerFinding {
  title: string
  body: string
  priority: FindingPriority
  confidence: number
  file_path: string
  line_start: number
  line_end: number
}

interface ReviewFinding extends ReviewerFinding {
  reviewer: string
}

interface SliceResult {
  label: string
  files: string[]
  overall_correctness: 'correct' | 'incorrect'
  explanation: string
  confidence: number
  findings: ReviewerFinding[]
}

export type { SliceResult, ReviewerFinding, ReviewFinding }

/** Closure status a verify reviewer reports for one prior ledgered finding. */
export type VerifyStatus = 'fixed' | 'partially_fixed' | 'not_fixed' | 'cannot_verify'

/** Closure statuses in reporting order. */
const VERIFY_STATUSES: readonly VerifyStatus[] = ['fixed', 'partially_fixed', 'not_fixed', 'cannot_verify']

/** One prior ledgered finding with its closure status, as reported by verify mode. */
export interface VerifyPriorFindingStatus {
  /** Ledger finding id (`F1`, `F2`, …). */
  id: string
  /** Severity of the prior finding. */
  priority: FindingPriority
  /** Title of the prior finding. */
  title: string
  /** File the prior finding pointed at. */
  file_path: string
  /** Start line of the prior finding. */
  line_start: number
  /** End line of the prior finding. */
  line_end: number
  /** Closure status reported by the reviewer (or `cannot_verify`). */
  status: VerifyStatus
  /** One-line reviewer evidence for the status. */
  evidence: string
}

/** Delta scan summary attached to verify-mode results. */
export interface VerifyBlock {
  /** Closure status for each prior ledgered finding. */
  priorFindings: VerifyPriorFindingStatus[]
  /** Files that changed since the recorded review (after the focus filter). */
  deltaFiles: string[]
  /** True when nothing changed since the recorded review. */
  deltaEmpty: boolean
}

/** One prior ledgered finding as presented in a verify reviewer brief. */
export interface VerifyClosureItem {
  /** Ledger finding id. */
  id: string
  /** Severity. */
  priority: FindingPriority
  /** Title. */
  title: string
  /** Body. */
  body: string
  /** File path. */
  file_path: string
  /** Start line. */
  line_start: number
  /** End line. */
  line_end: number
}

interface ReviewArgs {
  target?: 'worktree' | 'staged' | 'commits'
  range?: string
  focus?: string[]
  maxReviewers?: number
  cwd?: string
  /** `full` (default) overwrites the branch ledger; `verify` closes it against the delta. */
  mode?: 'full' | 'verify'
}

interface ReviewValue {
  target: 'worktree' | 'staged' | 'commits'
  files: string[]
  diffTruncated: boolean
  findings: ReviewFinding[]
  verdict: 'ship' | 'reject'
  verdictExplanation: string
  confidence: number
  slices: SliceResult[]
  errors: string[]
  warnings: string[]
  /** Present only in verify mode: the delta scan and prior-finding closure. */
  verify?: VerifyBlock
}

/** Subagent `outputSchema` — the standard JSON-Schema dialect
 * (object-level `required` arrays; per-property must appear in `properties`). */
const REVIEWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overall_correctness', 'explanation', 'confidence', 'findings'],
  properties: {
    overall_correctness: { type: 'string', enum: ['correct', 'incorrect'] },
    explanation: { type: 'string' },
    confidence: { type: 'number' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body', 'priority', 'confidence', 'file_path', 'line_start', 'line_end'],
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          priority: { type: 'integer', enum: [0, 1, 2, 3] },
          confidence: { type: 'number' },
          file_path: { type: 'string' },
          line_start: { type: 'integer' },
          line_end: { type: 'integer' },
        },
      },
    },
  },
} satisfies ObjectJsonSchema

/** Verify-mode reviewer schema: the full schema plus the per-finding closure report. */
const REVIEWER_VERIFY_SCHEMA: ObjectJsonSchema = {
  ...REVIEWER_SCHEMA,
  required: [...REVIEWER_SCHEMA.required, 'findingStatus'],
  properties: {
    ...REVIEWER_SCHEMA.properties,
    findingStatus: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'evidence'],
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: [...VERIFY_STATUSES] },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

const PRIORITY_LABELS: readonly FindingPriority[] = ['P0', 'P1', 'P2', 'P3']

export function toPriority(value: unknown): FindingPriority {
  if (value === 0 || value === '0') return 'P0'
  if (value === 1 || value === '1') return 'P1'
  if (value === 2 || value === '2') return 'P2'
  return 'P3'
}

/** Record a staged review verdict for the push gate (no-op for other targets). */
async function recordStagedVerdict(
  git: GitService,
  cwd: string,
  signal: AbortSignal | undefined,
  value: ReviewValue,
): Promise<void> {
  if (value.target !== 'staged') return
  recordReviewVerdict({
    root: await git.root(cwd, signal),
    target: value.target,
    verdict: value.verdict,
    beforeHead: await headOf(git, cwd, signal),
    indexTree: await indexTreeOf(git, cwd, signal),
    at: Date.now(),
  })
}

/** Prompt-builder seam: full-mode builders ignore the prior-findings argument. */
type PromptBuilder = (
  label: string,
  files: readonly string[],
  patch: string,
  prior: readonly VerifyClosureItem[],
) => string

/** One reviewer run outcome; `findingStatus` carries verify-mode closure entries. */
type SliceOutcome =
  | { kind: 'ok'; slice: SliceResult; findingStatus?: unknown }
  | { kind: 'error'; error: string }

/** The reviewed diff for one target plus the revision its tip resolves to. */
interface ReviewedDiff {
  diffText: string
  /** Revision naming the reviewed tip (`HEAD`, or the range head when set). */
  headTip: string
}

export function applyReviewTool(ctx: Context, config: ReviewToolConfig = {}): void {
  const provider = config.provider ?? DEFAULT_PROVIDER
  const maxReviewers = config.maxReviewers ?? DEFAULT_MAX_REVIEWERS
  const maxReviewerDiffChars = config.maxReviewerDiffChars ?? DEFAULT_MAX_REVIEWER_DIFF_CHARS

  ctx.tools.register(defineTool({
    name: 'review',
    description:
      'Run a parallel code review over git changes (working tree, staged, or a commit range) with dedicated reviewer '
      + 'subagents. Every finding is ranked P0–P3 with a confidence score; the tool returns all findings sorted by severity '
      + 'and a ship/reject verdict with explanation. Reviewers are read-only (git diff/log/show, read, grep, ast_grep) and '
      + 'never edit files or run builds. Use the focus filter to review only the paths that matter. '
      + 'mode "full" (default) runs the complete review and records its findings in a per-branch ledger; mode "verify" '
      + 're-reviews only what changed since that recorded review, asks reviewers to close each prior finding '
      + '(fixed/partially_fixed/not_fixed/cannot_verify), and fails closed when no ledger record exists for the branch '
      + 'or history was rewritten since it.',
    parameters: {
      target: {
        type: 'string',
        enum: ['worktree', 'staged', 'commits'],
        description: 'What to review: working-tree changes vs HEAD (default, includes staged + unstaged), only staged, or a commit range.',
      },
      range: {
        type: 'string',
        description: 'Commit range like HEAD~3..HEAD when target is commits (both endpoints resolved by git).',
      },
      focus: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional subset of paths/prefixes to restrict the review to; other files are skipped.',
      },
      maxReviewers: {
        type: 'integer',
        description: `Cap on parallel reviewers (default ${maxReviewers}); the diff is split into at most this many slices.`,
      },
      cwd: { type: 'string', description: 'Working directory; defaults to the session workspace.' },
      mode: {
        type: 'string',
        enum: ['full', 'verify'],
        description: 'full (default): complete fan-out review that overwrites the branch findings ledger. verify: close '
          + 'the ledgered findings against what changed since that review (cheaper delta scan); requires a prior full '
          + 'review on this branch and fails closed when none exists or history was rewritten.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true, enum: ['worktree', 'staged', 'commits'] },
          files: { type: 'array', required: true, items: { type: 'string' } },
          diffTruncated: { type: 'boolean', required: true },
          verdict: { type: 'string', required: true, enum: ['ship', 'reject'] },
          verdictExplanation: { type: 'string', required: true },
          confidence: { type: 'number', required: true },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                body: { type: 'string', required: true },
                priority: { type: 'string', required: true, enum: ['P0', 'P1', 'P2', 'P3'] },
                confidence: { type: 'number', required: true },
                file_path: { type: 'string', required: true },
                line_start: { type: 'integer', required: true },
                line_end: { type: 'integer', required: true },
                reviewer: { type: 'string', required: true },
              },
            },
          },
          slices: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string', required: true },
                files: { type: 'array', required: true, items: { type: 'string' } },
                overall_correctness: { type: 'string', required: true, enum: ['correct', 'incorrect'] },
                /* jscpd:ignore-start -- independent copies of the finding property block (review vs verify output). */
                explanation: { type: 'string', required: true },
                confidence: { type: 'number', required: true },
                findings: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      title: { type: 'string', required: true },
                      body: { type: 'string', required: true },
                      priority: { type: 'string', required: true, enum: ['P0', 'P1', 'P2', 'P3'] },
                      confidence: { type: 'number', required: true },
                      file_path: { type: 'string', required: true },
                      line_start: { type: 'integer', required: true },
                      line_end: { type: 'integer', required: true },
                      /* jscpd:ignore-end */
                    },
                  },
                },
              },
            },
          },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          verify: {
            type: 'object',
            additionalProperties: false,
            properties: {
              priorFindings: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    priority: { type: 'string', required: true, enum: ['P0', 'P1', 'P2', 'P3'] },
                    title: { type: 'string', required: true },
                    file_path: { type: 'string', required: true },
                    line_start: { type: 'integer', required: true },
                    line_end: { type: 'integer', required: true },
                    status: { type: 'string', required: true, enum: ['fixed', 'partially_fixed', 'not_fixed', 'cannot_verify'] },
                    evidence: { type: 'string', required: true },
                  },
                },
              },
              deltaFiles: { type: 'array', required: true, items: { type: 'string' } },
              deltaEmpty: { type: 'boolean', required: true },
            },
          },
        },
      },
      render: (_args, value: ReviewValue) => [{
        type: 'text',
        text: renderReview(value),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args: ReviewArgs, exec) {
      const cwd = resolveCwd(exec, args.cwd)
      const reads = await openReads(ctx, cwd, exec.signal)
      if (!(await reads.isRepo())) {
        throw new Error(`review requires a git repository: ${cwd} is not inside a working tree`)
      }
      const parent = exec.agent
      if (!parent) {
        throw new Error('review requires a calling agent (exec.agent was undefined)')
      }
      const subagents = ctx.get('subagents')
      if (subagents === undefined || subagents.getProvider(provider) === undefined) {
        throw new Error(`review needs a subagent provider "${provider}" — load @deepseek-ai/dsh-tool-subagent with that provider first`)
      }

      const target = args.target ?? 'worktree'
      if (args.mode === 'verify') {
        // ── verify: close the ledgered findings against what changed ──
        const branchKey = await ledgerBranchKey(ctx.git, cwd, exec.signal)
        const record = (await readLedger(ctx.git, cwd, exec.signal))[branchKey]
        if (record === undefined) {
          throw new Error(`no findings ledger for branch "${branchKey}" — run a full review first (mode: full)`)
        }
        if (!(await isAncestorOfHead(ctx.git, cwd, record.headSha, exec.signal))) {
          throw new Error('history was rewritten since the review — run a full review')
        }
        const warnings: string[] = []
        if (target === 'commits' && args.range !== undefined) {
          warnings.push('verify ignores the range argument: the delta runs from the recorded review tip to HEAD')
        }
        const deltaText = await resolveDeltaDiff(reads, target, record.headSha)
        const deltaFor = new Map(parseFileDiffs(deltaText).map(file => [file.filename, file.content]))
        const focus = (args.focus ?? []).map(prefix => prefix.replace(/\/+$/, ''))
        const deltaFiles = focusFilter(focus, Array.from(deltaFor.keys()))
        if (focus.length > 0 && deltaFiles.length === 0) {
          warnings.push(`no changed files matched the focus filter: ${focus.join(', ')}`)
        }
        const prior: VerifyClosureItem[] = record.findings.map(finding => ({
          id: finding.id,
          priority: finding.priority,
          title: finding.title,
          body: finding.body,
          file_path: finding.file_path,
          line_start: finding.line_start,
          line_end: finding.line_end,
        }))
        const priorBlocking = prior.filter(item => item.priority !== 'P3').length
        // Verify shipping replaces the branch record with the fresh equivalent
        // of a full review run right now.
        const replaceLedgerOnShip = async (kept: LedgerFinding[]): Promise<void> => {
          // The replacement is the fresh equivalent of a full review with the
          // verify's target; commits need a range, supplied or since the tip.
          const fullNowRange = target === 'commits' ? (args.range ?? `${record.headSha}..HEAD`) : args.range
          const fullNow = await resolveReviewDiff(reads, target, fullNowRange)
          await writeLedgerSafely(ctx.git, cwd, exec.signal, ledgerRecord(
            branchKey,
            target,
            target === 'commits' ? fullNowRange : undefined,
            await resolveRev(ctx.git, cwd, exec.signal, 'HEAD'),
            diffHashOf(fullNow.diffText),
            parseFileDiffs(fullNow.diffText).map(file => file.filename),
            'ship',
            kept,
          ), warnings)
        }
        if (deltaFiles.length === 0) {
          // Empty delta: no fan-out. The recorded verdict stands as-is.
          if (record.verdict === 'ship') {
            warnings.push('closure skipped: no files changed since the recorded review (deltaEmpty)')
            // No closure ran, so nothing is marked fixed: keep every prior
            // finding (ids preserved) instead of the ship-time re-selection.
            await replaceLedgerOnShip(record.findings)
            const value: ReviewValue = {
              target,
              files: [],
              diffTruncated: false,
              findings: [],
              verdict: 'ship',
              verdictExplanation: 'Nothing changed since the full review; its ship verdict stands and the closure checklist was skipped.',
              confidence: 1,
              slices: [],
              errors: [],
              warnings,
              verify: { priorFindings: [], deltaFiles: [], deltaEmpty: true },
            }
            await recordStagedVerdict(ctx.git, cwd, exec.signal, value)
            return value
          }
          warnings.push('findings ledger unchanged: the previous record stands until a verify ships or a full review runs')
          const value: ReviewValue = {
            target,
            files: [],
            diffTruncated: false,
            findings: [],
            verdict: 'reject',
            verdictExplanation: 'Nothing changed since the full review: no fixes landed, so the previous reject stands.',
            confidence: 0,
            slices: [],
            errors: [],
            warnings,
            verify: { priorFindings: [], deltaFiles: [], deltaEmpty: true },
          }
          await recordStagedVerdict(ctx.git, cwd, exec.signal, value)
          return value
        }
        const owned: string[] = []
        for (const file of [...deltaFiles, ...prior.map(item => item.file_path)]) {
          if (!owned.includes(file)) owned.push(file)
        }
        const budget = Math.max(1, Math.min(args.maxReviewers ?? maxReviewers, owned.length))
        const slices = sliceByWeight(owned, deltaFor, budget)
        const settled = await Promise.allSettled(
          slices.map((sliceFiles, index) =>
            runSlice(subagents, parent, sliceFiles, index, slices, deltaFor, prior, REVIEWER_VERIFY_SCHEMA, buildVerifyReviewerPrompt)),
        )
        const { slices: slicesResult, errors } = settleReviewers(settled)
        const findings = collectFindings(slicesResult)
        const statusById = new Map<string, { status: VerifyStatus; evidence: string }>()
        const closureReports = settled.flatMap(result =>
          result.status === 'fulfilled' && result.value.kind === 'ok' && result.value.findingStatus !== undefined
            ? [result.value.findingStatus]
            : [],
        )
        for (const report of closureReports) {
          for (const [id, entry] of toFindingStatuses(report)) {
            if (statusById.has(id)) {
              continue
            }
            statusById.set(id, entry)
          }
        }
        const priorStatuses: VerifyPriorFindingStatus[] = prior.map((item) => {
          const reported = statusById.get(item.id)
          return {
            id: item.id,
            priority: item.priority,
            title: item.title,
            file_path: item.file_path,
            line_start: item.line_start,
            line_end: item.line_end,
            status: reported?.status ?? 'cannot_verify',
            evidence: reported?.evidence ?? 'no closure status reported by the reviewer',
          }
        })
        const blockingUnfixed = priorStatuses.filter(entry => entry.priority !== 'P3' && entry.status !== 'fixed')
        const incorrect = slicesResult.filter(slice => slice.overall_correctness === 'incorrect')
        // Fail closed: reviewer failures void the closure evidence, and a
        // blocking prior finding that is not exactly fixed blocks the ship.
        // New findings never auto-reject — they surface for follow-up.
        const verdict: 'ship' | 'reject' = errors.length > 0 || incorrect.length > 0 || blockingUnfixed.length > 0 ? 'reject' : 'ship'
        const confidence = minConfidence(slicesResult)
        const newFindingsSuffix = findings.length > 0
          ? ` ${findings.length} new finding(s) reported for follow-up.`
          : ' The delta introduced no new findings.'
        const verdictExplanation = errors.length > 0
          ? `verify rejected: ${errors.length} of ${slices.length} reviewer(s) failed — closure evidence is incomplete.`
          : blockingUnfixed.length > 0
            ? `${blockingUnfixed.length} prior finding(s) not fixed: ${blockingUnfixed.map(entry => `${entry.id} [${entry.priority}] ${entry.status}`).join(', ')}.`
            : incorrect.length > 0
              ? `${incorrect.length} of ${slicesResult.length} reviewers found blocking problems. `
                + incorrect.map(slice => `[${slice.label}] ${slice.explanation}`).join(' ')
              : priorBlocking > 0
                ? `All ${priorBlocking} prior blocking finding(s) fixed.${newFindingsSuffix}`
                : `No prior blocking findings.${newFindingsSuffix}`
        if (verdict === 'ship') {
          // Prior non-blocking (P3) findings survive until fixed; fixed ones
          // drop. Ids are reassigned over the merged kept list.
          const kept = toLedgerFindings([
            ...findings,
            ...record.findings.filter((finding) => {
              const reported = statusById.get(finding.id)
              return finding.priority === 'P3' && reported?.status !== 'fixed'
            }),
          ])
          await replaceLedgerOnShip(kept)
        } else {
          warnings.push('findings ledger unchanged: the previous record stands until a verify ships or a full review runs')
        }
        const value: ReviewValue = {
          target,
          files: deltaFiles,
          diffTruncated: false,
          findings,
          verdict,
          verdictExplanation,
          confidence,
          slices: slicesResult,
          errors,
          warnings,
          verify: { priorFindings: priorStatuses, deltaFiles, deltaEmpty: false },
        }
        await recordStagedVerdict(ctx.git, cwd, exec.signal, value)
        return value
      }
      const { diffText, headTip } = await resolveReviewDiff(reads, target, args.range)
      const diffFor = new Map(parseFileDiffs(diffText).map(file => [file.filename, file.content]))
      const allFiles = Array.from(diffFor.keys())

      const focus = (args.focus ?? []).map(prefix => prefix.replace(/\/+$/, ''))
      const files = focusFilter(focus, allFiles)
      const warnings: string[] = []
      if (focus.length > 0 && files.length === 0) {
        warnings.push(`no changed files matched the focus filter: ${focus.join(', ')}`)
      }

      const branchKey = await ledgerBranchKey(ctx.git, cwd, exec.signal)

      if (files.length === 0) {
        // No diff for this target: nothing to review, but the (trivial) review
        // still forms the branch's recorded baseline.
        await writeLedgerSafely(ctx.git, cwd, exec.signal, ledgerRecord(
          branchKey,
          target,
          target === 'commits' ? args.range : undefined,
          await resolveRev(ctx.git, cwd, exec.signal, headTip),
          diffHashOf(diffText),
          [],
          'ship',
          [],
        ), warnings)
        const value: ReviewValue = {
          target,
          files: [],
          diffTruncated: false,
          findings: [],
          verdict: 'ship',
          verdictExplanation: 'No changed files to review.',
          confidence: 1,
          slices: [],
          errors: [],
          warnings,
        }
        await recordStagedVerdict(ctx.git, cwd, exec.signal, value)
        return value
      }

      const budget = Math.max(1, Math.min(args.maxReviewers ?? maxReviewers, files.length))
      const slices = sliceByWeight(files, diffFor, budget)

      const settled = await Promise.allSettled(
        slices.map((sliceFiles, index) =>
          runSlice(subagents, parent, sliceFiles, index, slices, diffFor, [], REVIEWER_SCHEMA, buildReviewerPrompt)),
      )

      const { slices: slicesResult, errors } = settleReviewers(settled)

      const findings = collectFindings(slicesResult)

      const incorrect = slicesResult.filter(slice => slice.overall_correctness === 'incorrect')
      // If every reviewer failed, we cannot approve unreviewed changes.
      const noReviewerCompleted = slicesResult.length === 0 && errors.length > 0
      const verdict: 'ship' | 'reject' = incorrect.length > 0 || noReviewerCompleted ? 'reject' : 'ship'
      const confidence = minConfidence(slicesResult)
      const verdictExplanation = noReviewerCompleted
        ? `No reviewer completed (${errors.length} of ${slices.length} failed); refusing to approve unreviewed changes.`
        : verdict === 'reject'
          ? `${incorrect.length} of ${slicesResult.length} reviewers found blocking problems. `
            + incorrect.map(slice => `[${slice.label}] ${slice.explanation}`).join(' ')
          : 'All reviewers judged the change correct'
            + (slicesResult.length > 0 ? ` (${slicesResult.length} reviewer(s))` : '') + '.'
            + (findings.length > 0 ? ` ${findings.length} non-blocking finding(s) remain.` : '')

      await writeLedgerSafely(ctx.git, cwd, exec.signal, ledgerRecord(
        branchKey,
        target,
        target === 'commits' ? args.range : undefined,
        await resolveRev(ctx.git, cwd, exec.signal, headTip),
        diffHashOf(diffText),
        files,
        verdict,
        toLedgerFindings(findings),
      ), warnings)

      const value: ReviewValue = {
        target,
        files,
        diffTruncated: false,
        findings,
        verdict,
        verdictExplanation,
        confidence,
        slices: slicesResult,
        errors,
        warnings,
      }
      await recordStagedVerdict(ctx.git, cwd, exec.signal, value)
      return value

      async function runSlice(
        subagents: SubagentRuntime,
        parent: Agent,
        sliceFiles: string[],
        index: number,
        slices: string[][],
        diffFor: Map<string, string>,
        prior: readonly VerifyClosureItem[],
        outputSchema: ObjectJsonSchema,
        buildPrompt: PromptBuilder,
      ): Promise<SliceOutcome> {
        const label = `reviewer ${index + 1}/${slices.length}`
        exec.signal.throwIfAborted()
        // Prior-only files have no delta section and are dropped from the
        // patch; present files keep their joined order so spill line ranges
        // stay aligned.
        const sections: Array<{ file: string; content: string }> = []
        for (const file of sliceFiles) {
          const content = diffFor.get(file)
          if (content !== undefined) sections.push({ file, content })
        }
        const inline = sections.map(section => section.content).join('\n')
        let patch = inline
        if (inline.length > maxReviewerDiffChars) {
          const spillStore = ctx.get('spillStore')
          if (spillStore === undefined) {
            throw new Error('review needs spillStore for oversized diffs; load @deepseek-ai/dsh-spill-local or another spill backend')
          }
          const ref = await spillStore.saveText({
            owner: { sessionId: parent.session.header.id },
            source: { kind: 'tool', toolName: 'review', callId: exec.callId, label },
            suggestedName: `review-${index + 1}.diff`,
            content: inline,
          })
          const ranges: string[] = []
          let startLine = 1
          for (const section of sections) {
            let endLine = startLine
            for (let offset = section.content.indexOf('\n'); offset !== -1; offset = section.content.indexOf('\n', offset + 1)) {
              endLine += 1
            }
            ranges.push(`- ${section.file}: lines ${startLine}-${endLine}`)
            startLine = endLine + 1
          }
          patch = `Complete diff artifact: ${ref.locator}. ${ref.retrievalHint}\n`
            + 'Read by the file ranges below; narrow further within long ranges rather than loading the whole artifact.\n'
            + ranges.join('\n')
        }
        exec.signal.throwIfAborted()
        const prompt = buildPrompt(label, sliceFiles, patch, prior.filter(item => sliceFiles.includes(item.file_path)))
        const controller = new AbortController()
        const forwardAbort = (): void => { controller.abort() }
        exec.signal.addEventListener('abort', forwardAbort, { once: true })
        let run: SubagentActivation
        try {
          run = await subagents.startActivation({
            provider,
            label,
            request: {
              prompt: [{ type: 'text', text: prompt }] as ContentBlock[],
              parent,
              outputSchema,
            },
            delivery: 'caller',
            signal: controller.signal,
          })
        } catch (error: unknown) {
          exec.signal.removeEventListener('abort', forwardAbort)
          return { kind: 'error', error: `start failed: ${reasonOf(error)}` }
        }
        try {
          const result = await run.result
          if (result.stopReason === 'completed' && isSliceStructured(result.structured)) {
            const slice: SliceResult = {
              label,
              files: sliceFiles,
              overall_correctness: result.structured.overall_correctness,
              explanation: result.structured.explanation,
              confidence: result.structured.confidence,
              findings: (result.structured.findings ?? []).map(toReviewerFinding),
            }
            return { kind: 'ok', slice, findingStatus: result.structured.findingStatus }
          }
          return {
            kind: 'error',
            error: `${result.stopReason}${result.diagnostic !== undefined ? ` (${result.diagnostic})` : ''}`,
          }
        } catch (error: unknown) {
          return { kind: 'error', error: reasonOf(error) }
        } finally {
          exec.signal.removeEventListener('abort', forwardAbort)
          try {
            await run.dispose()
          } catch {
            // disposal failures are not reviewer results
          }
        }
      }
    },
  }))
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

export function reasonOf(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  return String(reason)
}

function isSliceStructured(value: unknown): value is {
  overall_correctness: 'correct' | 'incorrect'
  explanation: string
  confidence: number
  findings?: unknown[]
  findingStatus?: unknown
} {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (record.overall_correctness === 'correct' || record.overall_correctness === 'incorrect')
    && typeof record.explanation === 'string'
    && typeof record.confidence === 'number' && Number.isFinite(record.confidence)
}

function toReviewerFinding(value: unknown): ReviewerFinding {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    title: typeof record.title === 'string' ? record.title : '(untitled finding)',
    body: typeof record.body === 'string' ? record.body : '',
    priority: toPriority(record.priority),
    confidence: typeof record.confidence === 'number' && Number.isFinite(record.confidence) ? record.confidence : 0,
    file_path: typeof record.file_path === 'string' ? record.file_path : '',
    line_start: typeof record.line_start === 'number' && Number.isFinite(record.line_start) ? record.line_start : 0,
    line_end: typeof record.line_end === 'number' && Number.isFinite(record.line_end) ? record.line_end : 0,
  }
}

/**
 * Parse reviewer closure entries into an id→status map. Entries without a
 * valid id or status are dropped; the matching prior finding then surfaces as
 * `cannot_verify`.
 * @param value - raw `findingStatus` payload from a reviewer.
 * @returns first-wins map of ledger id to closure status.
 */
function toFindingStatuses(value: unknown): Map<string, { status: VerifyStatus; evidence: string }> {
  const statuses = new Map<string, { status: VerifyStatus; evidence: string }>()
  if (!Array.isArray(value)) {
    return statuses
  }
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id : undefined
    const status = VERIFY_STATUSES.find(candidate => candidate === record.status)
    if (id === undefined || status === undefined) continue
    if (statuses.has(id)) continue
    statuses.set(id, { status, evidence: typeof record.evidence === 'string' ? record.evidence : '' })
  }
  return statuses
}

/** Which diff to review for the given target, and where its tip resolves. */
async function resolveReviewDiff(
  reads: ReadSurface,
  target: ReviewTarget,
  range: string | undefined,
): Promise<ReviewedDiff> {
  if (target === 'staged') return { diffText: await reads.diffText({ cached: true }), headTip: 'HEAD' }
  if (target === 'commits') {
    if (range === undefined || range.length === 0) {
      throw new Error('review target "commits" requires a range, e.g. HEAD~3..HEAD')
    }
    const dash = range.indexOf('..')
    if (dash === -1) {
      throw new Error(`review range must be base..head (e.g. HEAD~3..HEAD), got "${range}"`)
    }
    const base = range.slice(0, dash)
    // An open-ended range (`base..`) means `base..HEAD`, matching git range
    // semantics; the delta resolver normalizes the same way.
    const head = range.slice(dash + 2) || 'HEAD'
    return { diffText: await reads.diffText({ base, head }), headTip: head }
  }
  // worktree: everything vs HEAD (staged + unstaged; untracked files are
  // excluded — reviewers judge tracked changes).
  return { diffText: await reads.diffText({ base: 'HEAD' }), headTip: 'HEAD' }
}

/** The delta diff of what changed since `deltaBase` for one target. */
async function resolveDeltaDiff(
  reads: ReadSurface,
  target: ReviewTarget,
  deltaBase: string,
): Promise<string> {
  if (target === 'staged') return reads.diffText({ cached: true, base: deltaBase })
  if (target === 'commits') return reads.diffText({ base: deltaBase, head: 'HEAD' })
  return reads.diffText({ base: deltaBase })
}

/** Whether `ancestor` is an ancestor of (or equal to) HEAD. */
async function isAncestorOfHead(
  git: GitService,
  cwd: string,
  ancestor: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const run = await git.run(['merge-base', '--is-ancestor', ancestor, 'HEAD'], { cwd, signal })
  return run.exitCode === 0
}

/** Filter files by focus prefixes (`file === prefix` or under `prefix/`). */
function focusFilter(prefixes: readonly string[], files: readonly string[]): string[] {
  if (prefixes.length === 0) return [...files]
  return files.filter(file => prefixes.some(prefix => file === prefix || file.startsWith(`${prefix}/`)))
}

/** Fold settled reviewer runs into completed slices and one error string per failed reviewer. */
function settleReviewers(
  settled: PromiseSettledResult<SliceOutcome>[],
): { slices: SliceResult[]; errors: string[] } {
  const slices: SliceResult[] = []
  const errors: string[] = []
  for (const [i, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      if (result.value.kind === 'ok') {
        slices.push(result.value.slice)
      } else {
        errors.push(`reviewer ${i + 1}/${settled.length} failed: ${result.value.error}`)
      }
    } else {
      errors.push(`reviewer ${i + 1}/${settled.length} failed: ${reasonOf(result.reason)}`)
    }
  }
  return { slices, errors }
}

/** Collect reviewer findings tagged with their slice label, sorted by severity then descending confidence. */
function collectFindings(slices: readonly SliceResult[]): ReviewFinding[] {
  const findings: ReviewFinding[] = []
  for (const slice of slices) {
    for (const finding of slice.findings) {
      findings.push({ ...finding, reviewer: slice.label })
    }
  }
  findings.sort((a, b) => {
    const pa = PRIORITY_LABELS.indexOf(a.priority)
    const pb = PRIORITY_LABELS.indexOf(b.priority)
    if (pa !== pb) return pa - pb
    return b.confidence - a.confidence
  })
  return findings
}

/** Overall confidence: the minimum across completed reviewers (0 when none). */
function minConfidence(slices: readonly SliceResult[]): number {
  return slices.length === 0 ? 0 : Math.min(...slices.map(slice => slice.confidence))
}

/** Assemble a ledger record for one completed review. */
function ledgerRecord(
  branch: string,
  target: ReviewTarget,
  range: string | undefined,
  headSha: string,
  diffHash: string,
  files: string[],
  verdict: 'ship' | 'reject',
  findings: LedgerFinding[],
): LedgerRecord {
  return {
    version: 1,
    branch,
    target,
    ...(range !== undefined ? { range } : {}),
    headSha,
    diffHash,
    files,
    verdict,
    reviewedAt: Date.now(),
    findings,
  }
}

/**
 * Write the ledger record; persistence failures surface as a warning and
 * never change the verdict.
 */
async function writeLedgerSafely(
  git: GitService,
  cwd: string,
  signal: AbortSignal | undefined,
  record: LedgerRecord,
  warnings: string[],
): Promise<void> {
  try {
    await writeLedger(git, cwd, signal, record)
  } catch (error: unknown) {
    warnings.push(`ledger write failed: ${reasonOf(error)}`)
  }
}

/** Split `files` into at most `budget` slices balanced by diff size. */
export function sliceByWeight(files: readonly string[], diffFor: Map<string, string>, budget: number): string[][] {
  if (budget <= 1) return [files.slice()]
  const weight = (file: string): number => diffFor.get(file)?.length ?? 1
  const ordered = files.slice()
  ordered.sort((a, b) => weight(b) - weight(a))
  const slices: string[][] = Array.from({ length: budget }, () => [])
  const load = new Array<number>(budget).fill(0)
  for (const file of ordered) {
    let lightest = 0
    for (let i = 1; i < budget; i++) if ((load[i] ?? 0) < (load[lightest] ?? 0)) lightest = i
    slices[lightest]?.push(file)
    load[lightest] = (load[lightest] ?? 0) + weight(file)
  }
  return slices
}

/** Extract the `diff --git` section for one file from a whole diff text. */
export function gitDiffSection(diffText: string, file: string): string {
  const parts = diffText.split('\ndiff --git ')
  for (let index = 0; index < parts.length; index += 1) {
    const raw = parts[index] ?? ''
    const part = index === 0 ? raw : `diff --git ${raw}`
    if (!part.trim()) continue
    const header = part.split('\n')[0] ?? ''
    if (new RegExp(` b/${escapeRegExp(file)}$`).test(header) || header === `diff --git a/${file} b/${file}`) return part
  }
  return ''
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Reviewer criteria block, shared by full and verify prompts. */
const PROMPT_CRITERIA = 'CRITERIA — report only issues meeting ALL: provable impact (no speculation); actionable (discrete fix); '
  + 'unintentional (not a deliberate design choice); introduced in the patch (do not flag pre-existing bugs); '
  + 'no unstated assumptions; rigorous only to the level present elsewhere in the codebase.'

/** Reviewer consumer-dispatch block, shared by full and verify prompts. */
const PROMPT_CHECK = 'CHECK boundary-crossing values: every patch-introduced type/variant/value crossing a function or module '
  + 'boundary (event, message, command, frame, enum variant, queue item, IPC payload) needs its consuming-side dispatch '
  + 'point to forward it explicitly. A silent-drop/no-op at the consumer is a defect — read the consumer before concluding.'

/** Reviewer severity block, shared by full and verify prompts. */
const PROMPT_PRIORITY = 'PRIORITY — P0: blocks release/operations, universal impact (data corruption, auth bypass). '
  + 'P1: high, fix next cycle (race under load). P2: medium, fix eventually (edge-case mishandling). '
  + 'P3: info / nice to have (suboptimal but correct).'

/** Reviewer read-only rules block, shared by full and verify prompts. */
const PROMPT_RULES = 'RULES: This is READ-ONLY. NEVER edit files, never stage, never commit, never run builds or tests that mutate '
  + 'state — git diff/log/show/status and file reads only.'

/**
 * Build read-only review instructions for a captured patch.
 * @param label - Reviewer identity within the fan-out.
 * @param files - Changed files assigned to this reviewer.
 * @param patch - Inline diff or a complete artifact locator with retrieval guidance and file line ranges.
 * @returns The reviewer task, including evidence requirements and structured output instructions.
 */
export function buildReviewerPrompt(label: string, files: readonly string[], patch: string): string {
  const parts: string[] = []
  parts.push(`You are ${label}, a code review specialist performing a READ-ONLY review.`)
  parts.push('')
  parts.push('OWNED FILES (review these; other changed files are out of scope):')
  for (const file of files) parts.push(`- ${file}`)
  parts.push('')
  parts.push('Find bugs the author wants fixed before merge.')
  parts.push('')
  parts.push('PROCEDURE')
  parts.push('1. Inspect the captured patch below, one owned file at a time. For an artifact, read bounded line ranges; do not load the whole diff.')
  parts.push('2. Read enclosing declarations and relevant callers with read/lsp, expanding as needed to establish impact. Do not load entire files unnecessarily.')
  parts.push('3. Report each issue as a finding (see OUTPUT).')
  parts.push('4. Return the final verdict in the structured result (see OUTPUT).')
  parts.push('')
  parts.push(PROMPT_CRITERIA)
  parts.push('')
  parts.push(PROMPT_CHECK)
  parts.push('')
  parts.push(PROMPT_PRIORITY)
  parts.push('')
  parts.push(`CAPTURED PATCH (the requested review target; not truncated):\n\n${patch}`)
  parts.push('')
  parts.push(PROMPT_RULES)
  parts.push('')
  parts.push('OUTPUT: Return the structured result with `overall_correctness` ("correct" = no bugs/blockers, ignoring '
    + 'style/docs/nits, or "incorrect") and `explanation` (1-3 sentences). `findings` is an array where each item has '
    + 'title (imperative, ≤80 chars), body (one paragraph: bug, trigger, impact), priority (0=P0 … 3=P3), '
    + 'confidence (0.0-1.0 it is a real bug), file_path, line_start, line_end (≤10-line range overlapping the diff). '
    + 'Never invent findings: every finding must be patch-anchored and evidence-backed. Findings that are not patch-introduced '
    + 'or have no provable impact should not be reported.')
  return parts.join('\n')
}

/**
 * Build verify-mode reviewer instructions: close each prior ledgered finding
 * against the current code, then scan the delta patch for new issues.
 * @param label - Reviewer identity within the fan-out.
 * @param files - Changed files assigned to this reviewer (delta files plus files of its prior findings).
 * @param patch - Inline delta diff or a complete artifact locator with retrieval guidance and file line ranges.
 * @param priorFindings - Ledgered findings this reviewer must close.
 * @returns The reviewer task, including the closure checklist and structured output instructions.
 */
export function buildVerifyReviewerPrompt(
  label: string,
  files: readonly string[],
  patch: string,
  priorFindings: readonly VerifyClosureItem[],
): string {
  const parts: string[] = []
  parts.push(`You are ${label}, a code review specialist performing a READ-ONLY verify review: the change since `
    + 'a previous full review, plus closure of that review\'s findings.')
  parts.push('')
  parts.push('OWNED FILES (review these; other changed files are out of scope):')
  for (const file of files) parts.push(`- ${file}`)
  parts.push('')
  parts.push('You have two duties.')
  parts.push('')
  parts.push('DUTY 1 — close every prior finding listed below. Locate each one by its content in the current code '
    + '(the patch may have moved it). Report one `findingStatus` entry per prior finding:')
  parts.push('- fixed: the flagged problem is fully resolved in the current code.')
  parts.push('- partially_fixed: some of it is resolved, part of the problem remains.')
  parts.push('- not_fixed: the flagged problem is still present.')
  parts.push('- cannot_verify: you could not establish the state (e.g. the code moved out of the owned files).')
  parts.push('Keep `evidence` to one line citing the current code (file:line or the deciding expression). Do not '
    + 're-report a finding that is fixed; a still-broken one stays in `findings` only if it needs a fresh report.')
  parts.push('')
  parts.push('PRIOR FINDINGS')
  for (const finding of priorFindings) {
    parts.push(`- ${finding.id} [${finding.priority}] ${finding.title}`)
    parts.push(`  ${finding.body}`)
    parts.push(`  at ${finding.file_path}:${finding.line_start}-${finding.line_end}`)
  }
  if (priorFindings.length === 0) parts.push('- (none)')
  parts.push('')
  parts.push('DUTY 2 — scan the delta patch below for NEW issues introduced since the full review.')
  parts.push('')
  parts.push(PROMPT_CRITERIA)
  parts.push('')
  parts.push(PROMPT_CHECK)
  parts.push('')
  parts.push(PROMPT_PRIORITY)
  parts.push('')
  parts.push(`CAPTURED PATCH (changes since the full review; not truncated):\n\n${patch}`)
  parts.push('')
  parts.push(PROMPT_RULES)
  parts.push('')
  parts.push('OUTPUT: Return the structured result with `overall_correctness` ("correct" = the delta introduces no '
    + 'bugs/blockers, ignoring style/docs/nits, or "incorrect") and `explanation` (1-3 sentences). `findingStatus` has '
    + 'one entry per prior finding (see DUTY 1); `findings` reports NEW delta-introduced issues only, each with title '
    + '(imperative, ≤80 chars), body (one paragraph: bug, trigger, impact), priority (0=P0 … 3=P3), confidence '
    + '(0.0-1.0 it is a real bug), file_path, line_start, line_end (≤10-line range overlapping the delta). Never invent '
    + 'findings: every status needs evidence and every finding must be patch-anchored.')
  return parts.join('\n')
}

function renderReview(value: ReviewValue): string {
  const lines: string[] = []
  lines.push(`Review (${value.target}) — ${value.files.length} file(s), verdict: ${value.verdict.toUpperCase()}`
    + ` (confidence ${Math.round(value.confidence * 100)}%)`)
  lines.push(value.verdictExplanation)
  if (value.verify !== undefined) {
    lines.push(`Delta: ${value.verify.deltaFiles.length} file(s) since the recorded review`)
    if (!value.verify.deltaEmpty && value.verify.priorFindings.length > 0) {
      lines.push('')
      lines.push(`Closure (${value.verify.priorFindings.length} prior finding(s) checked):`)
      for (const entry of value.verify.priorFindings) {
        lines.push(`  [${entry.priority}] ${entry.id} ${entry.status} — ${entry.title}`)
        lines.push(`      ${entry.file_path}:${entry.line_start}-${entry.line_end}`)
        if (entry.evidence.length > 0) lines.push(`      ${entry.evidence}`)
      }
    }
  }
  if (value.findings.length > 0) {
    lines.push('')
    lines.push(`Findings (${value.findings.length}, sorted by severity):`)
    for (const finding of value.findings) {
      lines.push(`  [${finding.priority}] (${Math.round(finding.confidence * 100)}%) ${finding.title}`)
      if (finding.body.length > 0) lines.push(`      ${finding.body}`)
      lines.push(`      ${finding.file_path}:${finding.line_start}-${finding.line_end}  (reviewer ${finding.reviewer})`)
    }
  } else {
    lines.push('')
    lines.push('No findings reported.')
  }
  if (value.errors.length > 0) {
    lines.push('')
    lines.push(`Reviewer failures (${value.errors.length}):`)
    for (const error of value.errors) lines.push(`  - ${error}`)
  }
  for (const warning of value.warnings) lines.push(`warning: ${warning}`)
  return lines.join('\n')
}
