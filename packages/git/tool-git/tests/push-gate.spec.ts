/**
 * Unit tests for the P2 push gate: named gate states, verdict recording
 * identity, the pure decidePushGate matrix (fast posture, missing/stale/
 * reject verdicts, warn degradation), and the ledger-backed durable verdict
 * store (restart recovery plus identity re-check). Real-repo commit_apply
 * integration lives in commit.spec.ts.
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as Git from '@deepseek-ai/dsh-git'
import type { GitService } from '@deepseek-ai/dsh-git'
import { ledgerPath, type GateVerdictRecord } from '../src/ledger.ts'
import {
  clearReviewVerdicts,
  decidePushGate,
  headOf,
  indexTreeOf,
  latestStagedVerdict,
  loadStagedVerdict,
  recordReviewVerdict,
  recordReviewVerdictDurable,
  type ReviewVerdictRecord,
} from '../src/push-gate.ts'

const ROOT = '/repo/main'
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TREE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function record(overrides: Partial<ReviewVerdictRecord> = {}): ReviewVerdictRecord {
  return {
    root: ROOT,
    target: 'staged',
    verdict: 'ship',
    beforeHead: HEAD,
    indexTree: TREE,
    at: 1,
    ...overrides,
  }
}

beforeEach(() => { clearReviewVerdicts() })

describe('decidePushGate', () => {
  it('skips the gate entirely under an explicit fast posture (with a note)', () => {
    const decision = decidePushGate({
      posture: 'fast',
      record: undefined,
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.state).toBe('absent')
    expect(decision.reason).toContain('push gate skipped')
  })

  it('blocks a gated push with no verdict (fail-closed)', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: undefined,
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.state).toBe('absent')
    expect(decision.reason).toContain('never been reviewed')
    expect(decision.reason).toContain('review --target staged')
  })

  it('degrades to a loud warning under onUnavailable: warn when there is no verdict', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: undefined,
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'warn',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.state).toBe('absent')
    expect(decision.reason).toContain('onUnavailable: warn')
  })

  it('refuses when the latest review targeted worktree, not the staged range', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: record({ target: 'worktree' }),
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.state).toBe('wrong-target')
    expect(decision.reason).toContain('not the staged range')
  })

  it('refuses a stale verdict after HEAD moved', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: record({ beforeHead: 'old-head' }),
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.state).toBe('stale-head')
    expect(decision.reason).toContain('HEAD moved')
  })

  it('refuses a stale verdict when the staged tree changed after the review', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: record({ indexTree: 'old-tree' }),
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.state).toBe('stale-tree')
    expect(decision.reason).toContain('staged tree changed')
  })

  it('blocks a reject verdict even under onUnavailable: warn', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: record({ verdict: 'reject' }),
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'warn',
    })
    expect(decision.allowed).toBe(false)
    expect(decision.state).toBe('rejected')
    expect(decision.reason).toContain('reject')
  })

  it('releases a push when a current ship verdict covers the exact staged range', () => {
    const decision = decidePushGate({
      posture: 'review-gated',
      record: record(),
      beforeHead: HEAD,
      indexTree: TREE,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.state).toBe('ship')
    expect(decision.reason).toContain('ship')
    expect(decision.reason).toContain('current staged range')
  })
})

describe('verdict recording identity', () => {
  it('keeps one record per target so a worktree review does not shadow a staged verdict', () => {
    recordReviewVerdict(record({ target: 'staged' }))
    recordReviewVerdict(record({ target: 'worktree', at: 2 }))
    expect(latestStagedVerdict(ROOT)?.target).toBe('staged')
    expect(latestStagedVerdict('/repo/other')).toBeUndefined()
    recordReviewVerdict(record({ target: 'staged', beforeHead: 'newer' }))
    expect(latestStagedVerdict(ROOT)?.beforeHead).toBe('newer')
  })

  it('clearReviewVerdicts drops everything', () => {
    recordReviewVerdict(record())
    clearReviewVerdicts()
    expect(latestStagedVerdict(ROOT)).toBeUndefined()
  })
})

describe('durable gate verdicts (ledger-backed)', () => {
  let repoDir: string
  let ctx: Context
  let git: GitService

  function gitOrThrow(args: string[]): void {
    const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }

  /** Fresh module instance with an empty verdict memo — the "restart" case. */
  async function freshModule(): Promise<typeof import('../src/push-gate.ts')> {
    vi.resetModules()
    return await import('../src/push-gate.ts')
  }

  beforeAll(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'dsh-push-gate-'))
    gitOrThrow(['init', '-q'])
    gitOrThrow(['config', 'user.email', 'test@example.com'])
    gitOrThrow(['config', 'user.name', 'Test User'])
    await writeFile(join(repoDir, 'f.txt'), 'one\n')
    gitOrThrow(['add', '-A'])
    gitOrThrow(['commit', '-qm', 'baseline'])
    ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(Git)
    git = ctx.git
  })

  afterAll(async () => {
    rmSync(repoDir, { recursive: true, force: true })
    await ctx.fiber.dispose()
  })

  it('persists the verdict as an identity-bound gate record in the ledger', async () => {
    const root = await git.root(repoDir)
    const beforeHead = await headOf(git, repoDir, undefined)
    const indexTree = await indexTreeOf(git, repoDir, undefined)
    await recordReviewVerdictDurable(git, repoDir, undefined, record({ root, beforeHead, indexTree, at: Date.now() }))
    const doc = JSON.parse(await readFile(await ledgerPath(git, repoDir, undefined), 'utf8')) as Record<string, GateVerdictRecord>
    const stored = doc['gate:staged']
    expect(stored).toBeDefined()
    expect(stored.state).toBe('ship')
    expect(stored.verdict).toBe('ship')
    expect(stored.beforeHead).toBe(beforeHead)
    expect(stored.indexTree).toBe(indexTree)
    expect(stored.target).toBe('staged')
  })

  it('recovers the verdict from the ledger once the in-process memo is gone (restart)', async () => {
    const root = await git.root(repoDir)
    const beforeHead = await headOf(git, repoDir, undefined)
    const indexTree = await indexTreeOf(git, repoDir, undefined)
    await recordReviewVerdictDurable(git, repoDir, undefined, record({ root, beforeHead, indexTree, at: Date.now() }))
    clearReviewVerdicts()
    expect(latestStagedVerdict(root)).toBeUndefined()
    // Same process, cold memo: the ledger is authoritative.
    const recovered = await loadStagedVerdict(git, repoDir, undefined, root)
    expect(recovered?.verdict).toBe('ship')
    expect(recovered?.beforeHead).toBe(beforeHead)
    expect(recovered?.indexTree).toBe(indexTree)
    // A brand-new module instance (fresh memo Map) reads the same record back.
    const fresh = await freshModule()
    const fromFresh = await fresh.loadStagedVerdict(git, repoDir, undefined, root)
    expect(fromFresh?.verdict).toBe('ship')
    const decision = fresh.decidePushGate({
      posture: 'review-gated',
      record: fromFresh,
      beforeHead,
      indexTree,
      requireVerdict: 'ship',
      onUnavailable: 'block',
    })
    expect(decision.state).toBe('ship')
    expect(decision.allowed).toBe(true)
  })

  it('recomputes fail-closed when identity no longer matches after a restart', async () => {
    const root = await git.root(repoDir)
    const beforeHead = await headOf(git, repoDir, undefined)
    const indexTree = await indexTreeOf(git, repoDir, undefined)
    await recordReviewVerdictDurable(git, repoDir, undefined, record({ root, beforeHead, indexTree, at: Date.now() }))
    const fresh = await freshModule()
    const loaded = await fresh.loadStagedVerdict(git, repoDir, undefined, root)
    expect(loaded).toBeDefined()
    // Even under onUnavailable: warn, a mismatched identity must never flip a
    // blocked push to allowed — the state machine recomputes fail-closed.
    const movedHead = fresh.decidePushGate({
      posture: 'review-gated',
      record: loaded,
      beforeHead: 'moved-head',
      indexTree,
      requireVerdict: 'ship',
      onUnavailable: 'warn',
    })
    expect(movedHead.state).toBe('stale-head')
    expect(movedHead.allowed).toBe(false)
    const changedTree = fresh.decidePushGate({
      posture: 'review-gated',
      record: loaded,
      beforeHead,
      indexTree: 'other-tree',
      requireVerdict: 'ship',
      onUnavailable: 'warn',
    })
    expect(changedTree.state).toBe('stale-tree')
    expect(changedTree.allowed).toBe(false)
  })

  it('keeps a persisted reject verdict blocking after a restart', async () => {
    const root = await git.root(repoDir)
    const beforeHead = await headOf(git, repoDir, undefined)
    const indexTree = await indexTreeOf(git, repoDir, undefined)
    await recordReviewVerdictDurable(git, repoDir, undefined, record({ root, verdict: 'reject', beforeHead, indexTree, at: Date.now() }))
    const fresh = await freshModule()
    const loaded = await fresh.loadStagedVerdict(git, repoDir, undefined, root)
    expect(loaded?.verdict).toBe('reject')
    const decision = fresh.decidePushGate({
      posture: 'review-gated',
      record: loaded,
      beforeHead,
      indexTree,
      requireVerdict: 'ship',
      onUnavailable: 'warn',
    })
    expect(decision.state).toBe('rejected')
    expect(decision.allowed).toBe(false)
  })
})
