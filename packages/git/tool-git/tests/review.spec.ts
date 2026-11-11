/** Review slice budgeting, artifact retrieval, and verdict aggregation. */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as Git from '@deepseek-ai/dsh-git'
import toolGitPackage from '@deepseek-ai/dsh-tool-git'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import {
  toPriority,
  sliceByWeight,
  gitDiffSection,
  buildReviewerPrompt,
  buildVerifyReviewerPrompt,
} from '../src/review.ts'
import { LEDGER_BRANCH_CAP, diffHashOf, toLedgerFindings, ledgerBranchKey, ledgerPath, readLedger, resolveRev, writeLedger, type LedgerRecord } from '../src/ledger.ts'
import { decidePushGate, latestStagedVerdict } from '../src/push-gate.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

let dir: string
let ctx: Context
let counter = 0
let spillRoot: string
const maxReviewerDiffChars = 40_000
type ActivationOptions = Parameters<Context['subagents']['startActivation']>[0]
let reviewerPrompts: string[] = []

function runGit(args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

const agent = { session: { header: { id: 's1', cwd: '' } } } as never

async function call(name: string, args: unknown, signal = new AbortController().signal): Promise<{ value: unknown }> {
  const result = await executeToolFixture(ctx, {
    signal,
    callId: ToolCallId(`rev-${++counter}`),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) {
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
    throw new Error(text || 'tool failed')
  }
  return result
}

/** A fabricated `ctx.subagents` service whose `start` returns canned runs. */
interface CannedReviewer {
  overall_correctness: 'correct' | 'incorrect'
  explanation: string
  confidence: number
  findings?: unknown[]
  findingStatus?: unknown
}

let cannedRuns: CannedReviewer[] = []
let erroringStart = false
let fakeIndex = 0
let hangResult: unknown = undefined
function fakeSubagents(): {
  getProvider: () => unknown
  start: () => Promise<unknown>
  startActivation: (options: ActivationOptions) => Promise<unknown>
} {
  return {
    getProvider: () => ({ provider: 'spawn' }),
    start: () => {
      if (erroringStart) {
        return Promise.resolve({
          result: Promise.resolve({ stopReason: 'error', diagnostic: 'model transport failed', output: [] }),
          dispose: () => Promise.resolve(),
        })
      }
      const canned = cannedRuns[fakeIndex] ?? { overall_correctness: 'correct', explanation: 'no runs left', confidence: 1, findings: [] }
      fakeIndex += 1
      return Promise.resolve({
        result: Promise.resolve({ stopReason: 'completed', structured: canned, output: [] }),
        dispose: () => Promise.resolve(),
      })
    },
    startActivation: (options) => {
      reviewerPrompts.push(options.request.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n'))
      if (hangResult !== undefined) {
        return Promise.resolve({
          childId: undefined,
          result: new Promise((_, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => {
                // Deliberate non-Error rejection: exercises the reasonOf fallback for non-Error reasons.
                // oxlint-disable-next-line typescript/prefer-promise-reject-errors
                reject(hangResult)
              },
              { once: true },
            )
          }),
          dispose: () => Promise.resolve(),
        })
      }
      if (erroringStart) {
        return Promise.resolve({
          result: Promise.resolve({ stopReason: 'error', diagnostic: 'model transport failed', output: [] }),
          dispose: () => Promise.resolve(),
        })
      }
      const canned = cannedRuns[fakeIndex] ?? { overall_correctness: 'correct', explanation: 'no runs left', confidence: 1, findings: [] }
      fakeIndex += 1
      return Promise.resolve({
        childId: undefined,
        result: Promise.resolve({ stopReason: 'completed', structured: canned, output: [] }),
        dispose: () => Promise.resolve(),
      })
    },
  }
}

function resetFake(): void {
  cannedRuns = []
  erroringStart = false
  fakeIndex = 0
  reviewerPrompts = []
  hangResult = undefined
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-review-'))
  runGit(['init', '-q'])
  runGit(['config', 'user.email', 'test@example.com'])
  runGit(['config', 'user.name', 'Test User'])
  ;(agent as { session: { header: { cwd: string } } }).session.header.cwd = dir
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Git)
  spillRoot = `${dir}-spill`
  await ctx.plugin(LocalSpillStore, { root: spillRoot, cleanupPeriodDays: 0 })
  await ctx.plugin(toolGitPackage, { maxReviewerDiffChars })
  ctx.provide('subagents', fakeSubagents() as never)
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src/a.ts'), 'const a = 0;\n')
  await writeFile(join(dir, 'src/b.ts'), 'const b = 0;\n')
  await writeFile(join(dir, 'README.md'), '# baseline\n')
  runGit(['add', '-A'])
  runGit(['commit', '-q', '-m', 'baseline'])
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await ctx.fiber.dispose()
  rmSync(spillRoot, { recursive: true, force: true })
})

afterEach(() => { vi.restoreAllMocks() })

async function seedChanges(): Promise<void> {
  runGit(['reset', '-q'])
  runGit(['clean', '-fdq'])
  // checkout may fail on an empty history (no tracked paths) — tolerated
  spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: dir, encoding: 'utf8' })
  await mkdir(join(dir, 'src'), { recursive: true })
  await writeFile(join(dir, 'src/a.ts'), 'const a = 1;\n')
  await writeFile(join(dir, 'src/b.ts'), 'const b = 2;\n')
  await writeFile(join(dir, 'README.md'), '# project\n')
  runGit(['add', '-A'])
}

describe('pure helpers', () => {
  it('maps numeric priorities to P labels', () => {
    expect(toPriority(0)).toBe('P0')
    expect(toPriority(3)).toBe('P3')
    expect(toPriority(2)).toBe('P2')
    expect(toPriority('anything')).toBe('P3')
  })

  it('slices files by diff size into at most budget balanced groups', () => {
    const map = new Map<string, string>()
    map.set('big.ts', 'x'.repeat(1000))
    map.set('mid1.ts', 'x'.repeat(100))
    map.set('mid2.ts', 'x'.repeat(100))
    map.set('mid3.ts', 'x'.repeat(100))
    map.set('small.ts', 'x'.repeat(10))
    const slices = sliceByWeight(['big.ts', 'mid1.ts', 'mid2.ts', 'mid3.ts', 'small.ts'], map, 3)
    expect(slices.length).toBe(3)
    expect(slices.flat().sort()).toEqual(['big.ts', 'mid1.ts', 'mid2.ts', 'mid3.ts', 'small.ts'].sort())
  })

  it('extracts a file section from a whole diff', () => {
    const diff = gitSectionPair()
    const section = gitDiffSection(diff, 'src/a.ts')
    expect(section).toContain('diff --git a/src/a.ts b/src/a.ts')
    expect(section).not.toContain('src/b.ts')
  })
})

describe('review tool with fabricated reviewers', () => {
  it('returns a ship verdict with ranked findings when all reviewers pass', async () => {
    await seedChanges()
    resetFake()
    cannedRuns = [
      {
        overall_correctness: 'correct',
        explanation: 'looks good',
        confidence: 0.9,
        findings: [
          { title: 'minor nit', body: 'suboptimal but correct', priority: 3, confidence: 0.6, file_path: 'src/a.ts', line_start: 1, line_end: 1 },
          { title: 'handle null response', body: 'potential edge case', priority: 2, confidence: 0.7, file_path: 'src/b.ts', line_start: 3, line_end: 5 },
        ],
      },
    ]
    const result = await call('review', { target: 'staged' })
    const value = result.value as { verdict: string; findings: Array<{ priority: string }>; errors: string[]; files: string[] }
    expect(value.verdict).toBe('ship')
    expect(value.files).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']))
    // sorted by severity: P2 before P3
    expect(value.findings.map(finding => finding.priority)).toEqual(['P2', 'P3'])
    expect(value.errors).toEqual([])
  })

  it('a clean full review ships with the no-findings explanation', async () => {
    await seedChanges()
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1, findings: [] }]
    const value = (await call('review', { target: 'staged', maxReviewers: 1 })).value as VerifyValueShape
    expect(value.verdict).toBe('ship')
    expect(value.verdictExplanation).toBe('All reviewers judged the change correct (1 reviewer(s)).')
    resetFake()
  })

  it('rejects when any reviewer reports incorrect', async () => {
    await seedChanges()
    resetFake()
    cannedRuns = [
      { overall_correctness: 'correct', explanation: 'fine', confidence: 0.9, findings: [] },
      { overall_correctness: 'incorrect', explanation: 'data corruption in b', confidence: 0.95, findings: [
        { title: 'auth bypass', body: 'P0 scenario', priority: 0, confidence: 0.95, file_path: 'src/b.ts', line_start: 1, line_end: 4 },
      ] },
    ]
    const result = await call('review', { target: 'staged', maxReviewers: 2 })
    const value = result.value as { verdict: string; findings: Array<{ priority: string }>; confidence: number | null }
    expect(value.verdict).toBe('reject')
    expect(value.findings[0]!.priority).toBe('P0')
    // Overall confidence is the minimum across reviewers.
    expect(value.confidence).toBeLessThan(1)
  })

  it.each([26_000, 50_000])('keeps complete scoped diffs retrievable when reviewer input exceeds the cap (%i chars per file)', async (chars) => {
    await seedChanges()
    resetFake()
    for (const name of ['a', 'b']) {
      await writeFile(join(dir, `src/${name}.ts`), `export const ${name} = "${name.repeat(chars)}";\n`)
    }
    runGit(['add', 'src'])
    const sections = Git.parseFileDiffs(runGit(['diff', '--cached', '--', 'src']))
    const expected = sections.map(section => section.content).join('\n')
    expect(expected.length).toBeGreaterThan(maxReviewerDiffChars)
    if (chars < maxReviewerDiffChars) {
      expect(sections.every(section => section.content.length <= maxReviewerDiffChars)).toBe(true)
    }
    const save = vi.spyOn(ctx.spillStore, 'saveText')
    const result = await call('review', { target: 'staged', focus: ['src'], maxReviewers: 1 })
    expect(result.value).toMatchObject({ verdict: 'ship', errors: [], diffTruncated: false })
    expect(save).toHaveBeenCalledTimes(1)
    const ref = (await save.mock.results[0]!.value) as { locator: string }
    const captured = await readFile(ref.locator, 'utf8')
    expect(captured).toBe(expected)
    const prompt = reviewerPrompts[0]!
    expect(prompt.length).toBeLessThan(maxReviewerDiffChars)
    expect(prompt).toContain(ref.locator)
    const ranges = [...prompt.matchAll(/^- (src\/[ab]\.ts): lines (\d+)-(\d+)$/gm)]
    expect(ranges.map(range => range[1])).toEqual(sections.map(section => section.filename))
    const lines = captured.split('\n')
    for (const [index, range] of ranges.entries()) {
      expect(lines.slice(Number(range[2]) - 1, Number(range[3])).join('\n')).toBe(sections[index]!.content)
    }
  })

  it('does not start a reviewer with incomplete input when artifact storage fails', async () => {
    await seedChanges()
    resetFake()
    await writeFile(join(dir, 'src/a.ts'), `export const a = "${'a'.repeat(maxReviewerDiffChars)}";\n`)
    runGit(['add', 'src/a.ts'])
    vi.spyOn(ctx.spillStore, 'saveText').mockRejectedValue(new Error('spill storage unavailable'))
    const result = await call('review', { target: 'staged', focus: ['src/a.ts'], maxReviewers: 1 })
    expect(result.value).toMatchObject({
      verdict: 'reject',
      slices: [],
      errors: [expect.stringContaining('spill storage unavailable')],
    })
    expect(reviewerPrompts).toEqual([])
  })

  it('reports reviewer failures as errors without crashing', async () => {
    await seedChanges()
    erroringStart = true
    try {
      const result = await call('review', { target: 'staged' })
      const value = result.value as { errors: string[]; slices: unknown[]; verdict: string }
      expect(value.errors.length).toBeGreaterThan(0)
      expect(value.errors[0]).toContain('model transport failed')
      expect(value.slices).toHaveLength(0)
      // No reviewer completed: refusing to approve unreviewed changes.
      expect(value.verdict).toBe('reject')
    } finally {
      erroringStart = false
    }
  })
})

type VerifyValueShape = {
  verdict: 'ship' | 'reject'
  verdictExplanation: string
  confidence: number
  files: string[]
  findings: Array<Record<string, unknown>>
  slices: Array<{ label: string }>
  errors: string[]
  warnings: string[]
  verify?: {
    priorFindings: Array<{
      id: string
      priority: string
      title: string
      file_path: string
      line_start: number
      line_end: number
      status: string
      evidence: string
    }>
    deltaFiles: string[]
    deltaEmpty: boolean
  }
}

function rendered(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

function ledgerFile(): string {
  return join(dir, '.git', 'dsh-review', 'ledger.json')
}

function branchName(): string {
  return runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
}

async function readRecord(): Promise<LedgerRecord> {
  const doc = JSON.parse(await readFile(ledgerFile(), 'utf8')) as Record<string, LedgerRecord>
  const record = doc[branchName()]
  if (record === undefined) throw new Error(`no ledger record for ${branchName()}`)
  return record
}

let seedCounter = 0

async function commitUnique(message: string): Promise<void> {
  await seedChanges()
  seedCounter += 1
  await writeFile(join(dir, 'src/a.ts'), `const a = ${seedCounter};\n`)
  await writeFile(join(dir, 'src/b.ts'), `const b = ${200 + seedCounter};\n`)
  runGit(['add', '-A'])
  runGit(['commit', '-q', '-m', message])
}

async function fullReviewWith(findings: Array<Record<string, unknown>>): Promise<LedgerRecord> {
  await commitUnique('seed')
  seedCounter += 1
  await writeFile(join(dir, 'src/a.ts'), `const a = ${seedCounter};\n`)
  runGit(['add', 'src/a.ts'])
  cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1, findings }]
  await call('review', { target: 'staged' })
  resetFake()
  return readRecord()
}

describe('review findings ledger and verify mode', () => {
  it('a full review writes the ledger under the git common dir with stable ids', async () => {
    await fullReviewWith([
      { title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 },
      { title: 'minor nit', body: 'style', priority: 3, confidence: 0.5, file_path: 'src/b.ts', line_start: 1, line_end: 1 },
    ])
    const record = await readRecord()
    expect(record.branch).toBe(branchName())
    expect(record.target).toBe('staged')
    expect(record.range).toBeUndefined()
    expect(record.headSha).toBe(runGit(['rev-parse', 'HEAD']).trim())
    expect(record.files).toEqual(['src/a.ts'])
    expect(record.verdict).toBe('ship')
    expect(record.findings.map(finding => `${finding.id} ${finding.priority} ${finding.title}`)).toEqual(['F1 P2 handle null', 'F2 P3 minor nit'])
    expect(record.diffHash).toHaveLength(64)
    expect(runGit(['status', '--porcelain'])).toBe('M  src/a.ts\n')
  })

  it('verify without a ledger errors with the exact message', async () => {
    rmSync(ledgerFile(), { force: true })
    await expect(call('review', { mode: 'verify' })).rejects.toThrow(`no findings ledger for branch "${branchName()}" — run a full review first (mode: full)`)
  })

  it('verify reports a prior P2 as fixed and ships', async () => {
    await fullReviewWith([{ title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 }])
    await writeFile(join(dir, 'src/b.ts'), 'const b = 42;\n')
    runGit(['add', '-A'])
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'closure clean', confidence: 0.9, findingStatus: [{ id: 'F1', status: 'fixed', evidence: 'const b = 42 guards the null path' }] }]
    const result = await call('review', { mode: 'verify', target: 'staged' })
    const value = result.value as VerifyValueShape
    expect(value.verdict).toBe('ship')
    expect(value.verdictExplanation).toBe('All 1 prior blocking finding(s) fixed. The delta introduced no new findings.')
    expect(value.files).toEqual(['src/a.ts', 'src/b.ts'])
    expect(value.findings).toEqual([])
    expect(value.verify).toEqual({
      priorFindings: [{ id: 'F1', priority: 'P2', title: 'handle null', file_path: 'src/a.ts', line_start: 1, line_end: 1, status: 'fixed', evidence: 'const b = 42 guards the null path' }],
      deltaFiles: ['src/a.ts', 'src/b.ts'],
      deltaEmpty: false,
    })
    const after = await readRecord()
    expect(after.findings).toEqual([])
    expect(after.verdict).toBe('ship')
    const text = rendered(result)
    expect(text).toContain('Delta: 2 file(s) since the recorded review')
    expect(text).toContain('Closure (1 prior finding(s) checked):')
    expect(text).toContain('  [P2] F1 fixed — handle null')
    expect(text).toContain('      src/a.ts:1-1')
    expect(text).toContain('const b = 42 guards the null path')
    resetFake()
  })

  it('verify rejects when a prior P2 is not fixed', async () => {
    const before = await fullReviewWith([{ title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 }])
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'still broken', confidence: 0.7, findingStatus: [{ id: 'F1', status: 'not_fixed', evidence: 'the null path remains' }] }]
    const value = (await call('review', { mode: 'verify', target: 'staged' })).value as VerifyValueShape
    expect(value.verdict).toBe('reject')
    expect(value.verdictExplanation).toBe('1 prior finding(s) not fixed: F1 [P2] not_fixed.')
    expect(value.verify?.priorFindings[0]?.status).toBe('not_fixed')
    const after = await readRecord()
    expect(after).toEqual(before)
    expect(value.warnings).toContain('findings ledger unchanged: the previous record stands until a verify ships or a full review runs')
    resetFake()
  })

  it('verify rejects when a reviewer reports the delta incorrect', async () => {
    await fullReviewWith([{ title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 }])
    await writeFile(join(dir, 'src/b.ts'), 'const b = 42;\n')
    runGit(['add', '-A'])
    cannedRuns = [{ overall_correctness: 'incorrect', explanation: 'bad', confidence: 0.2, findingStatus: [{ id: 'F1', status: 'fixed', evidence: 'guarded' }] }]
    const value = (await call('review', { mode: 'verify', target: 'staged', maxReviewers: 1 })).value as VerifyValueShape
    expect(value.verdict).toBe('reject')
    expect(value.verdictExplanation).toBe('1 of 1 reviewers found blocking problems. [reviewer 1/1] bad')
    expect(value.findings).toEqual([])
    resetFake()
  })

  it('verify keeps an unfixed P3 and still ships', async () => {
    await fullReviewWith([{ title: 'minor nit', body: 'style', priority: 3, confidence: 0.5, file_path: 'src/b.ts', line_start: 1, line_end: 1 }])
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1, findingStatus: [{ id: 'F1', status: 'not_fixed', evidence: 'still nits' }] }]
    const value = (await call('review', { mode: 'verify', target: 'staged' })).value as VerifyValueShape
    expect(value.verdict).toBe('ship')
    expect(value.verdictExplanation).toBe('No prior blocking findings. The delta introduced no new findings.')
    const after = await readRecord()
    expect(after.findings).toEqual([
      { id: 'F1', title: 'minor nit', body: 'style', priority: 'P3', confidence: 0.5, file_path: 'src/b.ts', line_start: 1, line_end: 1, reviewer: 'reviewer 1/1' },
    ])
    resetFake()
  })

  it('verify sees committed fixes in the worktree delta', async () => {
    await fullReviewWith([{ title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 }])
    await writeFile(join(dir, 'src/b.ts'), 'const b = 42;\n')
    runGit(['add', '-A'])
    runGit(['commit', '-q', '-m', 'fix'])
    seedCounter += 1
    await writeFile(join(dir, 'src/a.ts'), `const a = ${seedCounter};\n`)
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'fixed in commit', confidence: 1, findingStatus: [{ id: 'F1', status: 'fixed', evidence: 'removed in the fix commit' }] }]
    const value = (await call('review', { mode: 'verify', target: 'worktree' })).value as VerifyValueShape
    expect(value.verdict).toBe('ship')
    expect(value.files).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']))
    const after = await readRecord()
    expect(after.headSha).toBe(runGit(['rev-parse', 'HEAD']).trim())
    resetFake()
  })

  it('verify reports new blocking findings introduced by the delta', async () => {
    await fullReviewWith([{ title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 }])
    await writeFile(join(dir, 'src/b.ts'), 'eval(userInput);\n')
    runGit(['add', 'src/b.ts'])
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'prior fixed, new issue', confidence: 0.6, findingStatus: [{ id: 'F1', status: 'fixed', evidence: 'guarded now' }], findings: [{ title: 'eval of untrusted input', body: 'rce risk', priority: 1, confidence: 0.9, file_path: 'src/b.ts', line_start: 1, line_end: 1 }] }]
    const value = (await call('review', { mode: 'verify', target: 'staged' })).value as VerifyValueShape
    expect(value.verdict).toBe('ship')
    expect(value.verdictExplanation).toBe('All 1 prior blocking finding(s) fixed. 1 new finding(s) reported for follow-up.')
    expect(value.findings[0]).toMatchObject({ title: 'eval of untrusted input', priority: 'P1' })
    const after = await readRecord()
    expect(after.findings).toHaveLength(1)
    expect(after.findings[0]).toMatchObject({ id: 'F1', title: 'eval of untrusted input', priority: 'P1' })
    resetFake()
  })

  it('verify fails closed when a reviewer fails', async () => {
    await fullReviewWith([{ title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 }])
    erroringStart = true
    const value = (await call('review', { mode: 'verify', target: 'staged' })).value as VerifyValueShape
    expect(value.verdict).toBe('reject')
    expect(value.verdictExplanation).toBe('verify rejected: 1 of 1 reviewer(s) failed — closure evidence is incomplete.')
    expect(value.errors).toEqual(['reviewer 1/1 failed: error (model transport failed)'])
    expect(value.slices).toEqual([])
    expect(value.verify?.priorFindings[0]).toMatchObject({ id: 'F1', status: 'cannot_verify', evidence: 'no closure status reported by the reviewer' })
    expect((await readRecord()).verdict).toBe('ship')
    resetFake()
  })

  it('verify with target staged records the push-gate verdict', async () => {
    await fullReviewWith([])
    await writeFile(join(dir, 'src/b.ts'), 'const b = 7;\n')
    runGit(['add', '-A'])
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1, findingStatus: [] }]
    const value = (await call('review', { mode: 'verify', target: 'staged', maxReviewers: 1 })).value as VerifyValueShape
    expect(value.verdict).toBe('ship')
    const root = runGit(['rev-parse', '--show-toplevel']).trim()
    const record = latestStagedVerdict(root)
    expect(record?.verdict).toBe('ship')
    const decision = decidePushGate({
      posture: 'review-gated',
      record,
      beforeHead: runGit(['rev-parse', 'HEAD']).trim(),
      indexTree: runGit(['write-tree']).trim() || null,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(true)
    resetFake()
  })

  it('verify errors when history was rewritten', async () => {
    await fullReviewWith([{ title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 }])
    runGit(['commit', '-q', '--amend', '--no-edit'])
    await expect(call('review', { mode: 'verify' })).rejects.toThrow('history was rewritten since the review — run a full review')
    resetFake()
  })

  it('verify with an empty delta shortcuts both ways', async () => {
    await fullReviewWith([{ title: 'minor nit', body: 'style', priority: 3, confidence: 0.5, file_path: 'src/b.ts', line_start: 1, line_end: 1 }])
    runGit(['reset', '-q', '--hard'])
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'unused', confidence: 1 }]
    const shipValue = (await call('review', { mode: 'verify', target: 'staged' })).value as VerifyValueShape
    expect(shipValue.verdict).toBe('ship')
    expect(shipValue.verdictExplanation).toBe('Nothing changed since the full review; its ship verdict stands and the closure checklist was skipped.')
    expect(shipValue.files).toEqual([])
    expect(shipValue.findings).toEqual([])
    expect(shipValue.slices).toEqual([])
    expect(shipValue.verify).toEqual({ priorFindings: [], deltaFiles: [], deltaEmpty: true })
    expect(shipValue.warnings).toContain('closure skipped: no files changed since the recorded review (deltaEmpty)')
    const shipped = await readRecord()
    expect(shipped.findings.map(finding => finding.id)).toEqual(['F1'])
    expect(shipped.verdict).toBe('ship')

    runGit(['reset', '-q', '--hard'])
    await commitUnique('seed2')
    seedCounter += 1
    await writeFile(join(dir, 'src/a.ts'), `const a = ${seedCounter};\n`)
    runGit(['add', 'src/a.ts'])
    cannedRuns = [{ overall_correctness: 'incorrect', explanation: 'bad', confidence: 0.2 }]
    await call('review', { target: 'staged' })
    runGit(['reset', '-q', '--hard'])
    const before = await readRecord()
    const rejectValue = (await call('review', { mode: 'verify' })).value as VerifyValueShape
    expect(rejectValue.verdict).toBe('reject')
    expect(rejectValue.verdictExplanation).toBe('Nothing changed since the full review: no fixes landed, so the previous reject stands.')
    expect(rejectValue.verify).toEqual({ priorFindings: [], deltaFiles: [], deltaEmpty: true })
    expect(rejectValue.warnings).toContain('findings ledger unchanged: the previous record stands until a verify ships or a full review runs')
    expect(await readRecord()).toEqual(before)
    resetFake()
  })

  it('verify merges closure statuses across reviewers first-wins', async () => {
    await fullReviewWith([
      { title: 'fix a', body: 'a', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 },
      { title: 'fix b', body: 'b', priority: 2, confidence: 0.8, file_path: 'src/b.ts', line_start: 1, line_end: 1 },
    ])
    await writeFile(join(dir, 'src/a.ts'), 'const a = 9;\n'.repeat(600))
    await writeFile(join(dir, 'src/b.ts'), 'const b = 12;\n')
    runGit(['add', '-A'])
    cannedRuns = [
      { overall_correctness: 'correct', explanation: 'a ok', confidence: 0.8, findingStatus: [{ id: 'F1', status: 'fixed', evidence: 'a rewritten' }] },
      { overall_correctness: 'correct', explanation: 'b pending', confidence: 0.7, findingStatus: [{ id: 'F2', status: 'partially_fixed', evidence: 'b half done' }] },
    ]
    const value = (await call('review', { mode: 'verify', target: 'staged', maxReviewers: 2 })).value as VerifyValueShape
    expect(value.slices).toHaveLength(2)
    expect(value.verdict).toBe('reject')
    expect(value.verdictExplanation).toBe('1 prior finding(s) not fixed: F2 [P2] partially_fixed.')
    expect(value.verify?.priorFindings.map(finding => finding.status)).toEqual(['fixed', 'partially_fixed'])
    expect(value.verify?.priorFindings.map(finding => finding.evidence)).toEqual(['a rewritten', 'b half done'])
    resetFake()
  })

  it('verify drops invalid closure statuses and keeps first reports', async () => {
    await fullReviewWith([{ title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 }])
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'messy statuses', confidence: 1, findingStatus: [42, { status: 'fixed' }, { id: 'F1', status: 'nonsense' }, { id: 'F1', status: 'not_fixed', evidence: 'still present' }, { id: 'F1', status: 'fixed', evidence: 'later report' }] }]
    const value = (await call('review', { mode: 'verify', target: 'staged' })).value as VerifyValueShape
    expect(value.verdict).toBe('reject')
    expect(value.verify?.priorFindings[0]).toMatchObject({ id: 'F1', status: 'not_fixed', evidence: 'still present' })
    resetFake()
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'wrong shape', confidence: 1, findingStatus: 'oops' }]
    const value2 = (await call('review', { mode: 'verify', target: 'staged' })).value as VerifyValueShape
    expect(value2.verdict).toBe('reject')
    expect(value2.verify?.priorFindings[0]).toMatchObject({ id: 'F1', status: 'cannot_verify', evidence: 'no closure status reported by the reviewer' })
    resetFake()
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'non-string evidence', confidence: 1, findingStatus: [{ id: 'F1', status: 'fixed', evidence: 7 }] }]
    const value3 = (await call('review', { mode: 'verify', target: 'staged' })).value as VerifyValueShape
    expect(value3.verdict).toBe('ship')
    expect(value3.verify?.priorFindings[0]).toMatchObject({ id: 'F1', status: 'fixed', evidence: '' })
    resetFake()
  })

  it('verify keeps the first closure report when two reviewers close the same finding', async () => {
    await fullReviewWith([
      { title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 },
      { title: 'leaky loop', body: 'unbounded read', priority: 2, confidence: 0.9, file_path: 'src/b.ts', line_start: 2, line_end: 2 },
    ])
    await writeFile(join(dir, 'src/b.ts'), `${'x'.repeat(10)}\n`)
    runGit(['add', 'src/b.ts'])
    cannedRuns = [
      { overall_correctness: 'correct', explanation: 'first report', confidence: 1, findingStatus: [{ id: 'F1', status: 'fixed', evidence: 'first report' }] },
      { overall_correctness: 'correct', explanation: 'second report', confidence: 1, findingStatus: [{ id: 'F1', status: 'not_fixed', evidence: 'second report' }, { id: 'F2', status: 'fixed' }] },
    ]
    const value = (await call('review', { mode: 'verify', target: 'staged' })).value as VerifyValueShape
    expect(value.verdict).toBe('ship')
    expect(value.verify?.priorFindings).toEqual([
      { id: 'F1', priority: 'P2', title: 'leaky loop', file_path: 'src/b.ts', line_start: 2, line_end: 2, status: 'fixed', evidence: 'first report' },
      { id: 'F2', priority: 'P2', title: 'handle null', file_path: 'src/a.ts', line_start: 1, line_end: 1, status: 'fixed', evidence: '' },
    ])
    resetFake()
  })

  it('verify focus keeps prior-only files but skips their absent delta sections', async () => {
    await fullReviewWith([
      { title: 'fix b', body: 'b', priority: 2, confidence: 0.8, file_path: 'src/b.ts', line_start: 1, line_end: 1 },
      // README is untouched by the delta, so its closure slice has no patch.
      { title: 'fix readme', body: 'r', priority: 3, confidence: 0.5, file_path: 'README.md', line_start: 1, line_end: 1 },
    ])
    await writeFile(join(dir, 'src/b.ts'), 'const b = 21;\n' + 'const pad = 1;\n'.repeat(3000))
    runGit(['add', 'src/b.ts'])
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1, findingStatus: [{ id: 'F1', status: 'fixed', evidence: 'b fixed' }] }]
    await call('review', { mode: 'verify', target: 'staged', focus: ['src/b.ts'] })
    // Prompt order follows activation timing (the spilling slice awaits
    // saveText before startActivation), so select prompts by owned files.
    const bPrompt = reviewerPrompts.find(prompt => prompt.includes('- src/b.ts')) ?? ''
    expect(bPrompt).toContain('- F1 [P2] fix b')
    const priorOnlyPrompt = reviewerPrompts.find(prompt => prompt.includes('- README.md')) ?? ''
    expect(priorOnlyPrompt).toContain('- F2 [P3] fix readme')
    // A prior-only file absent from the delta contributes no patch section.
    expect(priorOnlyPrompt).not.toContain('diff --git a/README.md')
    expect(priorOnlyPrompt).not.toContain('diff --git a/src/b.ts')
    resetFake()
  })

  it('verify with a focus that matches no delta file leaves the ledger and gate untouched', async () => {
    await fullReviewWith([
      { title: 'fix b', body: 'b', priority: 2, confidence: 0.8, file_path: 'src/b.ts', line_start: 1, line_end: 1 },
      { title: 'fix readme', body: 'r', priority: 3, confidence: 0.5, file_path: 'README.md', line_start: 1, line_end: 1 },
    ])
    await writeFile(join(dir, 'src/b.ts'), 'const b = 22;\n')
    runGit(['add', 'src/b.ts'])
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'unused', confidence: 1 }]
    const ledgerBefore = readFileSync(ledgerFile(), 'utf8')
    const root = runGit(['rev-parse', '--show-toplevel']).trim()
    const stagedBefore = latestStagedVerdict(root)
    const value = (await call('review', { mode: 'verify', target: 'staged', focus: ['docs/'] })).value as VerifyValueShape
    expect(value.warnings).toContain('no changed files matched the focus filter: docs')
    expect(value.verify?.deltaEmpty).toBe(false)
    expect(value.verify?.deltaFiles).toEqual(['src/a.ts', 'src/b.ts'])
    expect(value.verify?.priorFindings).toEqual([])
    expect(value.verdict).toBe('ship')
    expect(value.verdictExplanation).not.toContain('Nothing changed since the full review')
    // No closure review ran over the staged delta, so the ledger and gate state stand unchanged.
    expect(readFileSync(ledgerFile(), 'utf8')).toBe(ledgerBefore)
    expect(latestStagedVerdict(root)).toBe(stagedBefore)
    const decision = decidePushGate({
      posture: 'review-gated',
      record: stagedBefore,
      beforeHead: runGit(['rev-parse', 'HEAD']).trim(),
      indexTree: runGit(['write-tree']).trim() || null,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(false)
    resetFake()
  })

  it('verify with a focus that matches no delta file mirrors a standing reject', async () => {
    await commitUnique('seed')
    seedCounter += 1
    await writeFile(join(dir, 'src/a.ts'), `const a = ${seedCounter};\n`)
    runGit(['add', 'src/a.ts'])
    // A reviewer judging the change incorrect is the full-review path to a standing reject record.
    cannedRuns = [{
      overall_correctness: 'incorrect',
      explanation: 'broken',
      confidence: 1,
      findings: [{ title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 }],
    }]
    await call('review', { target: 'staged' })
    resetFake()
    expect((await readRecord()).verdict).toBe('reject')
    await writeFile(join(dir, 'src/b.ts'), 'const b = 22;\n')
    runGit(['add', 'src/b.ts'])
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'unused', confidence: 1 }]
    const ledgerBefore = readFileSync(ledgerFile(), 'utf8')
    const root = runGit(['rev-parse', '--show-toplevel']).trim()
    const stagedBefore = latestStagedVerdict(root)
    const value = (await call('review', { mode: 'verify', target: 'staged', focus: ['docs/'] })).value as VerifyValueShape
    expect(value.warnings).toContain('no changed files matched the focus filter: docs')
    expect(value.warnings).toContain('findings ledger unchanged: the previous record stands until a verify ships or a full review runs')
    expect(value.verdict).toBe('reject')
    expect(value.verdictExplanation).toContain('the recorded reject stands')
    expect(value.confidence).toBe(0)
    expect(value.verify?.deltaEmpty).toBe(false)
    expect(value.verify?.deltaFiles).toEqual(['src/a.ts', 'src/b.ts'])
    expect(readFileSync(ledgerFile(), 'utf8')).toBe(ledgerBefore)
    expect(latestStagedVerdict(root)).toBe(stagedBefore)
    resetFake()
  })

  it('verify spills oversized delta patches and ignores the range argument', async () => {
    await fullReviewWith([{ title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 }])
    runGit(['reset', '-q', '--hard'])
    await writeFile(join(dir, 'src/b.ts'), 'const b = 5;\n' + 'const pad = 1;\n'.repeat(6000))
    runGit(['add', 'src/b.ts'])
    runGit(['commit', '-q', '-m', 'big'])
    const before = await readRecord()
    const save = vi.spyOn(ctx.spillStore, 'saveText')
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1, findingStatus: [{ id: 'F1', status: 'fixed', evidence: 'done' }] }]
    const value = (await call('review', { mode: 'verify', target: 'commits', range: 'HEAD~5..HEAD' })).value as VerifyValueShape
    expect(save).toHaveBeenCalledTimes(1)
    expect(value.warnings).toContain('verify ignores the range argument: the delta runs from the recorded review tip to HEAD')
    // Only the oversized slice spills; find its prompt by the artifact header.
    const prompt = reviewerPrompts.find(candidate => candidate.includes('Complete diff artifact:')) ?? ''
    expect(prompt).toContain('Complete diff artifact:')
    expect(prompt).toContain('- src/b.ts: lines ')
    expect(prompt).not.toContain('- src/a.ts: lines ')
    const ref = (await save.mock.results[0]!.value) as { locator: string }
    expect(prompt).toContain(`${ref.locator}.`)
    expect(value.files).toEqual(['src/b.ts'])
    const record = await readRecord()
    expect(record.range).toBe(`${before.headSha}..HEAD`)
    expect(record.headSha).toBe(runGit(['rev-parse', 'HEAD']).trim())
    expect(record.diffHash).toBe(diffHashOf(runGit(['diff', before.headSha, 'HEAD'])))
    resetFake()
  })

  it('verify ship ignores a malformed range and replaces the record from the recorded tip', async () => {
    await fullReviewWith([{ title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 }])
    const before = await readRecord()
    const value = (await call('review', { mode: 'verify', target: 'commits', range: 'not-a-range..bogus..worse' })).value as VerifyValueShape
    expect(value.warnings).toContain('verify ignores the range argument: the delta runs from the recorded review tip to HEAD')
    expect(value.verdict).toBe('ship')
    expect(value.verify?.deltaEmpty).toBe(true)
    const after = await readRecord()
    expect(after.range).toBe(`${before.headSha}..HEAD`)
    expect(after.headSha).toBe(runGit(['rev-parse', 'HEAD']).trim())
    resetFake()
  })

  it('verify on commits without a range deltas from the recorded tip', async () => {
    const before = await fullReviewWith([{ title: 'handle null', body: 'deref risk', priority: 2, confidence: 0.8, file_path: 'src/a.ts', line_start: 1, line_end: 1 }])
    await commitUnique('fix')
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1, findingStatus: [{ id: 'F1', status: 'fixed', evidence: 'committed fix' }] }]
    const value = (await call('review', { mode: 'verify', target: 'commits' })).value as VerifyValueShape
    expect(value.verdict).toBe('ship')
    const after = await readRecord()
    expect(after.target).toBe('commits')
    expect(after.range).toBe(`${before.headSha}..HEAD`)
    expect(after.headSha).toBe(runGit(['rev-parse', 'HEAD']).trim())
    expect(after.verdict).toBe('ship')
    resetFake()
  })

  it('a commits range without base..head separators throws', async () => {
    await commitUnique('cseed')
    await expect(call('review', { target: 'commits', range: 'HEAD' })).rejects.toThrow('review range must be base..head (e.g. HEAD~3..HEAD), got "HEAD"')
    resetFake()
  })

  it('a commits target requires a range and records it', async () => {
    await commitUnique('cseed')
    seedCounter += 1
    await writeFile(join(dir, 'src/a.ts'), `const a = ${seedCounter};\n`)
    runGit(['add', '-A'])
    runGit(['commit', '-q', '-m', 'change'])
    await expect(call('review', { target: 'commits' })).rejects.toThrow('review target "commits" requires a range, e.g. HEAD~3..HEAD')
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1 }]
    const value = (await call('review', { target: 'commits', range: 'HEAD~1..HEAD' })).value as VerifyValueShape
    expect(value.verdict).toBe('ship')
    const record = await readRecord()
    expect(record.target).toBe('commits')
    expect(record.range).toBe('HEAD~1..HEAD')
    expect(record.headSha).toBe(runGit(['rev-parse', 'HEAD']).trim())
    resetFake()
  })

  it('a no-change review records an empty ledger entry', async () => {

    await commitUnique('clean')
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1 }]
    const value = (await call('review', {})).value as VerifyValueShape
    expect(value.verdict).toBe('ship')
    expect(value.verdictExplanation).toBe('No changed files to review.')
    expect(value.files).toEqual([])
    const record = await readRecord()
    expect(record.files).toEqual([])
    expect(record.verdict).toBe('ship')
    expect(record.findings).toEqual([])
    expect(record.diffHash).toBe(diffHashOf(''))
    resetFake()
  })

  it('a commits range with an empty head resolves to HEAD', async () => {
    await commitUnique('cseed')
    seedCounter += 1
    await writeFile(join(dir, 'src/a.ts'), `const a = ${seedCounter};\n`)
    runGit(['add', '-A'])
    runGit(['commit', '-q', '-m', 'change'])
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1 }]
    const value = (await call('review', { target: 'commits', range: 'HEAD~1..' })).value as VerifyValueShape
    expect(value.verdict).toBe('ship')
    const record = await readRecord()
    expect(record.range).toBe('HEAD~1..')
    expect(record.headSha).toBe(runGit(['rev-parse', 'HEAD']).trim())
    resetFake()
  })

  it('a no-change commits review records its range', async () => {
    await commitUnique('cseed')
    runGit(['commit', '-q', '--allow-empty', '-m', 'empty'])
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1 }]
    const value = (await call('review', { target: 'commits', range: 'HEAD~1..HEAD' })).value as VerifyValueShape
    expect(value.verdict).toBe('ship')
    expect(value.verdictExplanation).toBe('No changed files to review.')
    const record = await readRecord()
    expect(record.target).toBe('commits')
    expect(record.range).toBe('HEAD~1..HEAD')
    expect(record.files).toEqual([])
    resetFake()
  })

  it('a focus filter that matches nothing warns and skips the fan-out', async () => {
    await seedChanges()
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'unused', confidence: 1 }]
    const value = (await call('review', { target: 'staged', focus: ['docs/'] })).value as VerifyValueShape
    expect(value.files).toEqual([])
    expect(value.slices).toEqual([])
    expect(value.warnings).toContain('no changed files matched the focus filter: docs')
    resetFake()
  })

  it('a detached HEAD keys the ledger by DETACHED-<sha8>', async () => {
    try {
      await commitUnique('detach seed')
      runGit(['checkout', '-q', '--detach'])
      seedCounter += 1
      await writeFile(join(dir, 'src/a.ts'), `const a = ${seedCounter};\n`)
      runGit(['add', 'src/a.ts'])
      cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1 }]
      await call('review', {})
      const key = `DETACHED-${runGit(['rev-parse', 'HEAD']).trim().slice(0, 8)}`
      const doc = JSON.parse(await readFile(ledgerFile(), 'utf8')) as Record<string, LedgerRecord>
      expect(doc[key]?.branch).toBe(key)
      expect(doc[key]?.verdict).toBe('ship')
      resetFake()
    } finally {
      runGit(['checkout', '-q', '-'])
    }
  })

  it('a ledger write failure surfaces a warning and does not fail the review', async () => {
    await seedChanges()
    rmSync(join(dir, '.git', 'dsh-review'), { recursive: true, force: true })
    await writeFile(join(dir, '.git', 'dsh-review'), 'not a directory')
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1 }]
    const value = (await call('review', {})).value as VerifyValueShape
    expect(value.verdict).toBe('ship')
    expect(value.warnings.some(warning => warning.startsWith('ledger write failed:'))).toBe(true)
    rmSync(join(dir, '.git', 'dsh-review'), { force: true })
    resetFake()
  })
})

describe('reviewer robustness', () => {
  it('a structured result without confidence fails the reviewer', async () => {
    await seedChanges()
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok' }]
    const value = (await call('review', { target: 'staged', maxReviewers: 1 })).value as VerifyValueShape
    expect(value.verdict).toBe('reject')
    expect(value.errors).toEqual(['reviewer 1/1 failed: completed'])
    expect(value.slices).toEqual([])
    resetFake()
  })

  it('garbage finding fields fall back to safe defaults', async () => {
    await seedChanges()
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1, findings: [{ title: 42, body: null, priority: 'P2', confidence: 'high', file_path: 7, line_start: null, line_end: 9 }] }]
    const value = (await call('review', { target: 'staged', maxReviewers: 1 })).value as VerifyValueShape
    expect(value.findings[0]).toEqual({ title: '(untitled finding)', body: '', priority: 'P3', confidence: 0, file_path: '', line_start: 0, line_end: 9, reviewer: 'reviewer 1/1' })
    resetFake()
  })

  it('a non-Error reviewer rejection is stringified', async () => {
    await seedChanges()
    const subagents = ctx.get('subagents') as { startActivation: (options: ActivationOptions) => Promise<unknown> }
    vi.spyOn(subagents, 'startActivation').mockRejectedValue('storage outage')
    const value = (await call('review', { target: 'staged', maxReviewers: 1 })).value as VerifyValueShape
    expect(value.verdict).toBe('reject')
    expect(value.errors).toEqual(['reviewer 1/1 failed: start failed: storage outage'])
    resetFake()
  })

  it('verify needs a spill store for oversized patches', async () => {
    await fullReviewWith([{ title: 'fix b', body: 'b', priority: 2, confidence: 0.8, file_path: 'src/b.ts', line_start: 1, line_end: 1 }])
    await writeFile(join(dir, 'src/b.ts'), 'const b = 6;\n' + 'const pad = 1;\n'.repeat(6000))
    runGit(['add', 'src/b.ts'])
    const originalGet = ctx.get.bind(ctx) as (name: string) => LocalSpillStore | undefined
    const getSpy = vi.spyOn(ctx, 'get').mockImplementation(name => (name === 'spillStore' ? undefined : originalGet(name)))
    try {
      const value = (await call('review', { mode: 'verify', target: 'staged', focus: ['src/b.ts'] })).value as VerifyValueShape
      expect(value.verdict).toBe('reject')
      expect(value.errors[0]).toContain('review needs spillStore for oversized diffs')
      expect(reviewerPrompts).toEqual([])
    } finally {
      getSpy.mockRestore()
    }
    resetFake()
  })


  it('an unstructured reviewer payload fails the slice closed', async () => {
    await seedChanges()
    cannedRuns = ['just text'] as never
    const value = (await call('review', { target: 'staged', maxReviewers: 1 })).value as VerifyValueShape
    expect(value.verdict).toBe('reject')
    expect(value.errors).toEqual(['reviewer 1/1 failed: completed'])
    resetFake()
  })

  it('non-object findings and non-numeric line bounds fall back to defaults', async () => {
    await seedChanges()
    cannedRuns = [{ overall_correctness: 'correct', explanation: 'ok', confidence: 1, findings: [42, { title: 't', body: 'b', priority: 1, confidence: 0.5, file_path: 'src/a.ts', line_start: 1, line_end: 'x' }] }]
    const value = (await call('review', { target: 'staged', maxReviewers: 1 })).value as VerifyValueShape
    expect(value.findings[0]).toEqual({ title: 't', body: 'b', priority: 'P1', confidence: 0.5, file_path: 'src/a.ts', line_start: 1, line_end: 0, reviewer: 'reviewer 1/1' })
    expect(value.findings[1]).toEqual({ title: '(untitled finding)', body: '', priority: 'P3', confidence: 0, file_path: '', line_start: 0, line_end: 0, reviewer: 'reviewer 1/1' })
    resetFake()
  })
})

describe('findings ledger helpers', () => {
  let ledgerDir: string
  let ledgerCtx: Context

  const runLedgerGit = (args: string[]): string => {
    const result = spawnSync('git', args, { cwd: ledgerDir, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout
  }

  const fakeRecord = (branch: string, reviewedAt: number): LedgerRecord => ({
    version: 1,
    branch,
    target: 'staged',
    headSha: `h-${branch}`,
    diffHash: `d-${branch}`,
    files: [],
    verdict: 'ship',
    reviewedAt,
    findings: [],
  })

  beforeAll(async () => {
    ledgerDir = await mkdtemp(join(tmpdir(), 'dsh-ledger-'))
    runLedgerGit(['init', '-q'])
    runLedgerGit(['config', 'user.email', 't@example.com'])
    runLedgerGit(['config', 'user.name', 't'])
    ledgerCtx = new Context()
    await ledgerCtx.plugin(SystemPrompt)
    await ledgerCtx.plugin(ToolRuntime)
    await ledgerCtx.plugin(LocalSubprocessRuntime)
    await ledgerCtx.plugin(Git)
  })

  afterAll(async () => {
    rmSync(ledgerDir, { recursive: true, force: true })
    await ledgerCtx.fiber.dispose()
  })

  it('writeLedger applies the LRU branch cap', async () => {
    for (let index = 1; index <= LEDGER_BRANCH_CAP + 1; index += 1) {
      await writeLedger(ledgerCtx.get('git'), ledgerDir, undefined, fakeRecord(`branch-${index}`, index))
    }
    const doc = await readLedger(ledgerCtx.get('git'), ledgerDir, undefined)
    expect(doc['branch-1']).toBeUndefined()
    expect(doc['branch-21']).toBeDefined()
    expect(Object.keys(doc)).toHaveLength(LEDGER_BRANCH_CAP)
  })

  it('writeLedger cleans up its temp file when a write fails and keeps the ledger parseable', async () => {
    const git = ledgerCtx.get('git')
    const ledgerDirPath = join(ledgerDir, '.git', 'dsh-review')
    const ledgerFile = join(ledgerDirPath, 'ledger.json')
    await writeLedger(git, ledgerDir, undefined, fakeRecord('atomic-a', LEDGER_BRANCH_CAP + 100))
    expect(Object.keys(JSON.parse(readFileSync(ledgerFile, 'utf8')) as Record<string, unknown>)).toContain('atomic-a')
    // Temp creation fails: the ledger directory is read-only.
    chmodSync(ledgerDirPath, 0o555)
    await expect(writeLedger(git, ledgerDir, undefined, fakeRecord('atomic-b', 2))).rejects.toThrow()
    chmodSync(ledgerDirPath, 0o755)
    // Temp rename fails: the target path is occupied by a directory.
    rmSync(ledgerFile)
    mkdirSync(ledgerFile)
    await expect(writeLedger(git, ledgerDir, undefined, fakeRecord('atomic-c', LEDGER_BRANCH_CAP + 102))).rejects.toThrow()
    expect(readdirSync(ledgerDirPath).filter(name => name !== 'ledger.json')).toEqual([])
    rmSync(ledgerFile, { recursive: true })
    await writeLedger(git, ledgerDir, undefined, fakeRecord('atomic-a', LEDGER_BRANCH_CAP + 101))
    expect(Object.keys(JSON.parse(readFileSync(ledgerFile, 'utf8')) as Record<string, unknown>)).toContain('atomic-a')
  })

  it('writeLedger serializes concurrent writes from two worktrees of one repository', async () => {
    const git = ledgerCtx.get('git')
    const repoDir = await mkdtemp(join(tmpdir(), 'dsh-ledger-wt-'))
    const sibling = `${repoDir}-sibling`
    const runIn = (cwd: string, args: string[]): string => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
      return result.stdout
    }
    try {
      runIn(repoDir, ['init', '-q'])
      runIn(repoDir, ['config', 'user.email', 't@example.com'])
      runIn(repoDir, ['config', 'user.name', 't'])
      await writeFile(join(repoDir, 'seed.txt'), 'seed\n')
      runIn(repoDir, ['add', 'seed.txt'])
      runIn(repoDir, ['commit', '-q', '-m', 'seed'])
      runIn(repoDir, ['worktree', 'add', '-q', '-b', 'wb', sibling, 'HEAD'])
      // Both writes target the shared <git-common-dir>/dsh-review/ledger.json; the lock
      // must serialize them even though the two cwds are different worktrees.
      await Promise.all([
        writeLedger(git, repoDir, undefined, fakeRecord('wa', LEDGER_BRANCH_CAP + 200)),
        writeLedger(git, sibling, undefined, fakeRecord('wb', LEDGER_BRANCH_CAP + 201)),
      ])
      const shared = join(repoDir, '.git', 'dsh-review', 'ledger.json')
      const keys = Object.keys(JSON.parse(readFileSync(shared, 'utf8')) as Record<string, unknown>)
      expect(keys).toContain('wa')
      expect(keys).toContain('wb')
    } finally {
      rmSync(sibling, { recursive: true, force: true })
      rmSync(repoDir, { recursive: true, force: true })
    }
  })

  it('readLedger self-heals corrupt or wrong-shaped files to an empty document', async () => {
    const path = join(ledgerDir, '.git', 'dsh-review', 'ledger.json')
    await mkdir(dirname(path), { recursive: true })
    for (const payload of ['{not json', '[1,2,3]', '42']) {
      await writeFile(path, payload)
      expect(await readLedger(ledgerCtx.get('git'), ledgerDir, undefined)).toEqual({})
    }
  })

  it('ledgerPath resolves under the git common directory', async () => {
    expect(await ledgerPath(ledgerCtx.get('git'), ledgerDir, undefined)).toBe(join(realpathSync(ledgerDir), '.git', 'dsh-review', 'ledger.json'))
  })

  it('ledgerPath rejects outside a repository', async () => {
    const noGit = await mkdtemp(join(tmpdir(), 'dsh-nogit-'))
    try {
      await expect(ledgerPath(ledgerCtx.get('git'), noGit, undefined)).rejects.toThrow('cannot resolve the git common directory for the findings ledger')
    } finally {
      rmSync(noGit, { recursive: true, force: true })
    }
  })

  it('resolveRev returns empty for an unknown revision', async () => {
    expect(await resolveRev(ledgerCtx.get('git'), ledgerDir, undefined, 'no-such-rev')).toBe('')
  })

  it('ledgerBranchKey uses the branch name and a DETACHED-<sha8> fallback', async () => {
    await writeFile(join(ledgerDir, 'f.txt'), 'v1\n')
    runLedgerGit(['add', '-A'])
    runLedgerGit(['commit', '-q', '-m', 'seed'])
    const branch = runLedgerGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    expect(await ledgerBranchKey(ledgerCtx.get('git'), ledgerDir, undefined)).toBe(branch)
    runLedgerGit(['checkout', '-q', '--detach'])
    const expected = `DETACHED-${runLedgerGit(['rev-parse', 'HEAD']).trim().slice(0, 8)}`
    expect(await ledgerBranchKey(ledgerCtx.get('git'), ledgerDir, undefined)).toBe(expected)
    runLedgerGit(['checkout', '-q', '-'])
  })

  it('toLedgerFindings assigns sequential ids', () => {
    const findings = toLedgerFindings([
      { title: 'a', body: '', priority: 'P2', confidence: 1, file_path: 'x', line_start: 1, line_end: 1, reviewer: 'reviewer 1/1' },
      { title: 'b', body: '', priority: 'P3', confidence: 1, file_path: 'y', line_start: 1, line_end: 1, reviewer: 'reviewer 1/1' },
    ])
    expect(findings.map(finding => finding.id)).toEqual(['F1', 'F2'])
  })

  it('diffHashOf hashes deterministically', () => {
    expect(diffHashOf('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('reviewer prompts', () => {
  it('buildReviewerPrompt keeps the full-mode contract', () => {
    const prompt = buildReviewerPrompt('reviewer 1/2', ['src/a.ts'], 'PATCH', [])
    expect(prompt).toContain('You are reviewer 1/2, a code review specialist performing a READ-ONLY review.')
    expect(prompt).toContain('- src/a.ts')
    expect(prompt).toContain('Find bugs the author wants fixed before merge.')
    expect(prompt).toContain('CAPTURED PATCH (the requested review target; not truncated):')
  })

  it('buildVerifyReviewerPrompt adds the closure checklist and prior findings', () => {
    const prompt = buildVerifyReviewerPrompt('reviewer 1/1', ['src/a.ts'], 'PATCH', [
      { id: 'F1', priority: 'P2', title: 'fix the null path', body: 'deref risk', file_path: 'src/a.ts', line_start: 1, line_end: 2 },
    ])
    expect(prompt).toContain('READ-ONLY verify review')
    expect(prompt).toContain('DUTY 1 — close every prior finding listed below')
    expect(prompt).toContain('- partially_fixed: some of it is resolved, part of the problem remains.')
    expect(prompt).toContain('- F1 [P2] fix the null path')
    expect(prompt).toContain('deref risk')
    expect(prompt).toContain('at src/a.ts:1-2')
    expect(prompt).toContain('findingStatus')
    expect(prompt).toContain('CAPTURED PATCH (changes since the full review; not truncated):')
  })

  it('buildVerifyReviewerPrompt renders an empty prior list', () => {
    const prompt = buildVerifyReviewerPrompt('reviewer 1/1', ['src/a.ts'], 'PATCH', [])
    expect(prompt).toContain('PRIOR FINDINGS')
    expect(prompt).toContain('(none)')
  })
})

describe('gitDiffSection edge cases', () => {
  it('returns empty when the file has no section', () => {
    expect(gitDiffSection('diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n', 'src/missing.ts')).toBe('')
  })
})

function gitSectionPair(): string {
  return [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1 @@',
    '-const a = 1;',
    '+const a = 2;',
    'diff --git a/src/b.ts b/src/b.ts',
    'index 3333333..4444444 100644',
    '--- a/src/b.ts',
    '+++ b/src/b.ts',
    '@@ -1 +1 @@',
    '-const b = 2;',
    '+const b = 3;',
  ].join('\n')
}

describe('review honours caller cancellation', () => {
  it('an aborted review rejects the tool call closed', async () => {
    await seedChanges()
    hangResult = 'kaput'
    const controller = new AbortController()
    const pending = call('review', { target: 'staged', maxReviewers: 1 }, controller.signal)
    await vi.waitFor(() => { expect(reviewerPrompts.length).toBe(1) })
    controller.abort()
    await expect(pending).rejects.toThrow(/abort/i)
    resetFake()
  })
})
