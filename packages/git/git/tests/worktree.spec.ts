/**
 * Real-repository integration for the worktree pool: temp repositories are
 * initialized, slots are acquired/released/pruned/destroyed through the
 * engine against actual `git` through the subprocess seam, and every safety
 * invariant (durable lease ids, persisted slot phases, verify-driven damage
 * recovery, corrupt-state recovery) is exercised with the real filesystem.
 */

import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, realpathSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { GitService } from '../src/service.ts'
import {
  acquireWorktree,
  releaseWorktree,
  listWorktrees,
  verifyWorktrees,
  pruneWorktrees,
  sweepWorktrees,
  destroyWorktree,
  primaryRepoRoot,
  resolveWorktreePoolRoot,
  WorktreeError,
} from '../src/worktree.ts'

interface Fixture {
  dir: string
  pool: string
  git: GitService
  ctx: Context
  run: (args: string[]) => string
  runIn: (cwd: string, args: string[]) => string
  cleanup: () => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean()
})

function gitRun(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`)
  }
  return result.stdout
}

async function makeFixture(options: { poolRoot?: string } = {}): Promise<Fixture> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-wt-')))
  const pool = realpathSync(options.poolRoot ?? await mkdtemp(join(tmpdir(), 'dsh-wt-pool-')))
  gitRun(dir, ['init', '-q', '-b', 'master'])
  gitRun(dir, ['config', 'user.email', 'test@example.com'])
  gitRun(dir, ['config', 'user.name', 'Test User'])
  gitRun(dir, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(dir, 'seed.txt'), 'seed\n')
  gitRun(dir, ['add', '.'])
  gitRun(dir, ['commit', '-qm', 'init'])
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const git = new GitService(ctx)
  const fixture: Fixture = {
    dir,
    pool,
    git,
    ctx,
    run: args => gitRun(dir, args),
    runIn: (cwd, args) => gitRun(cwd, args),
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true })
      rmSync(pool, { recursive: true, force: true })
      await ctx.fiber.dispose()
    },
  }
  cleanups.push(fixture.cleanup)
  return fixture
}

async function expectCode<T>(promise: Promise<T>, code: WorktreeError['code']): Promise<void> {
  try {
    await promise
    expect.unreachable(`expected WorktreeError ${code}`)
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(WorktreeError)
    expect((error as WorktreeError).code).toBe(code)
  }
}

/** Rewrites the pool state so the slot parked `msAgo` milliseconds ago. */
async function backdateParkedAt(statePath: string, path: string, msAgo: number): Promise<void> {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as {
    worktrees: Array<{ path: string; parkedAt?: string }>
  }
  const entry = state.worktrees.find(item => item.path === path)
  expect(entry).toBeDefined()
  entry!.parkedAt = new Date(Date.now() - msAgo).toISOString()
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

describe('primaryRepoRoot', () => {
  it('resolves the main checkout for a main-checkout cwd', async () => {
    const f = await makeFixture()
    expect(await primaryRepoRoot(f.git, f.dir)).toBe(f.dir)
  })

  it('resolves the MAIN root from inside a linked worktree (pool unification)', async () => {
    const f = await makeFixture()
    const wt = join(f.pool, 'manual-wt')
    f.run(['worktree', 'add', '--detach', wt, 'master'])
    expect(await primaryRepoRoot(f.git, wt)).toBe(f.dir)
  })

  it('rejects a non-repository cwd', async () => {
    const f = await makeFixture()
    const outside = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-wt-outside-')))
    rmSync(outside, { recursive: true, force: true })
    await mkdir(outside)
    await expectCode(primaryRepoRoot(f.git, outside), 'NotARepository')
  })
})

describe('resolveWorktreePoolRoot', () => {
  it('is deterministic and names the repo plus a short hash', () => {
    const a = resolveWorktreePoolRoot({ root: '/tmp/pool' }, '/repo/x')
    const b = resolveWorktreePoolRoot({ root: '/tmp/pool' }, '/repo/x')
    expect(a).toBe(b)
    expect(a).toMatch(/pool[/\\]x-[0-9a-f]{6}$/)
  })

  it('defaults to ~/.treehouse and honors a custom root', () => {
    expect(resolveWorktreePoolRoot({}, '/repo/x')).toMatch(new RegExp(`^${join(homedir(), '.treehouse', 'x-')}`))
    expect(resolveWorktreePoolRoot({}, '/repo/x')).toMatch(/x-[0-9a-f]{6}$/)
    expect(resolveWorktreePoolRoot({ root: '/custom' }, '/repo/x')).toBe(join('/custom', 'x-37fb0d'))
  })
})

describe('acquireWorktree', () => {
  it('cuts a detached slot under the pool and records a durable lease', async () => {
    const f = await makeFixture()
    const lease = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(lease.path.startsWith(f.pool)).toBe(true)
    expect(lease.leaseId).toMatch(/^[0-9a-f]{32}$/)
    expect(lease.branch).toBeUndefined()
    expect(f.runIn(lease.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('HEAD')
    expect(f.runIn(lease.path, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true')
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ status: 'leased', leased: true, exists: true, dirty: false })
    expect(listed[0]!.leaseId).toBe(lease.leaseId)
  })

  it('cuts a NEW slot while the first lease is held (never hands out leased)', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    const b = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(b.path).not.toBe(a.path)
    expect((await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })).length).toBe(2)
  })

  it('reuses an idle clean slot after release (same slot, new lease id)', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const b = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(b.path).toBe(a.path)
    expect(b.leaseId).not.toBe(a.leaseId)
  })

  it('cuts a named branch on demand and parks detached on release (D1/D5)', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool }, { branch: 'feat/x' })
    expect(f.runIn(a.path, ['branch', '--show-current']).trim()).toBe('feat/x')
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    expect(f.runIn(a.path, ['branch', '--show-current']).trim()).toBe('')

    const again = await acquireWorktree(f.git, f.dir, { root: f.pool }, { branch: 'feat/x' })
    expect(again.path).toBe(a.path)
    expect(f.runIn(again.path, ['branch', '--show-current']).trim()).toBe('feat/x')

    const other = await acquireWorktree(f.git, f.dir, { root: f.pool }, { branch: 'feat/y' })
    expect(other.path).not.toBe(a.path)
    expect(f.runIn(other.path, ['branch', '--show-current']).trim()).toBe('feat/y')
  })

  it('never reuses a slot whose safety is unprovable (dirty slot is skipped)', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    await writeFile(join(a.path, 'wip.txt'), 'wip\n')
    const b = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(b.path).not.toBe(a.path)
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    const dirtySlot = listed.find(item => item.path === a.path)
    expect(dirtySlot).toMatchObject({ status: 'damaged', dirty: true })
  })

  it('refuses an already-aborted signal before touching git', async () => {
    const f = await makeFixture()
    const controller = new AbortController()
    controller.abort()
    await expectCode(
      acquireWorktree(f.git, f.dir, { root: f.pool }, { signal: controller.signal }),
      'GitFailed',
    )
  })
})

describe('releaseWorktree', () => {
  it('requires the matching lease id (stale caller cannot release)', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await expectCode(
      releaseWorktree(f.git, f.dir, { path: a.path, leaseId: 'f'.repeat(32) }, { settings: { root: f.pool } }),
      'LeaseMismatch',
    )
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed[0]).toMatchObject({ status: 'leased' })
    expect(listed[0]!.leaseId).toBe(a.leaseId)
  })

  it('parks a clean slot as idle for reuse', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    const result = await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    expect(result).toEqual({ path: a.path, released: true })
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed[0]).toMatchObject({ status: 'idle', leased: false, dirty: false })
  })

  it('refuses a dirty slot unless force, and force cleans it', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await writeFile(join(a.path, 'wip.txt'), 'wip\n')
    await expectCode(
      releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } }),
      'DirtyWorktree',
    )
    const result = await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool }, force: true })
    expect(result.released).toBe(true)
    // force runs git clean -fdqx → the untracked file is gone.
    await expect(readFile(join(a.path, 'wip.txt'), 'utf8')).rejects.toThrow()
  })

  it('drops the entry when the worktree was removed externally', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await rm(a.path, { recursive: true, force: true })
    const result = await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    expect(result.released).toBe(true)
    expect(await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })).toHaveLength(0)
  })
})

describe('pruneWorktrees', () => {
  it('previews removable idle slots without removing anything', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const result = await pruneWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({ path: a.path, reason: 'removable' })
    expect(result.removed).toHaveLength(0)
    expect(f.runIn(a.path, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true')
  })

  it('removes only unleased clean merged slots with yes', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    const b = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const result = await pruneWorktrees(f.git, f.dir, { settings: { root: f.pool }, yes: true })
    expect(result.removed).toEqual([a.path])
    expect(result.skipped).toContainEqual(expect.objectContaining({ path: b.path, reason: 'leased' }))
    expect(f.runIn(b.path, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true')
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed.map(item => item.path)).toEqual([b.path])
  })

  it('all sweeps every pool under the configured root', async () => {
    const f = await makeFixture()
    const g = await makeFixture({ poolRoot: f.pool })
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    const b = await acquireWorktree(g.git, g.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    await releaseWorktree(g.git, g.dir, b, { settings: { root: f.pool } })
    const result = await pruneWorktrees(f.git, f.dir, { settings: { root: f.pool }, all: true, yes: true })
    expect(result.removed).toEqual(expect.arrayContaining([a.path, b.path]))
  })
})

describe('sweepWorktrees (auto-prune)', () => {
  const DAY = 24 * 60 * 60 * 1000
  const STALE = 8 * DAY

  it('evicts a stale parked slot and deletes its merged cut-branch', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool }, { branch: 'feat/merged' })
    f.runIn(a.path, ['commit', '--allow-empty', '-qm', 'work'])
    f.run(['merge', 'feat/merged'])
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const statePath = join(dirname(dirname(a.path)), 'treehouse-state.json')
    await backdateParkedAt(statePath, a.path, STALE)
    const result = await sweepWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(result.evicted).toEqual([expect.objectContaining({ path: a.path, branch: 'feat/merged' })])
    expect(result.deletedBranches).toEqual(['feat/merged'])
    expect(result.skipped).toHaveLength(0)
    expect(result.retainedBranches).toHaveLength(0)
    expect(existsSync(a.path)).toBe(false)
    expect((await listWorktrees(f.git, f.dir, { settings: { root: f.pool } }))).toHaveLength(0)
    expect(() => f.run(['rev-parse', '--verify', 'refs/heads/feat/merged'])).toThrow()
  })

  it('retains an unmerged cut-branch while still evicting the slot', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool }, { branch: 'feat/wip' })
    f.runIn(a.path, ['commit', '--allow-empty', '-qm', 'wip work'])
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const statePath = join(dirname(dirname(a.path)), 'treehouse-state.json')
    await backdateParkedAt(statePath, a.path, STALE)
    const result = await sweepWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(result.evicted).toEqual([expect.objectContaining({ path: a.path, branch: 'feat/wip' })])
    expect(result.retainedBranches).toEqual([{ branch: 'feat/wip', reason: 'unmerged' }])
    expect(result.deletedBranches).toHaveLength(0)
    expect(existsSync(a.path)).toBe(false)
    // The unmerged branch survives: `git branch -d` refuses, and the sweep never forces.
    expect(f.run(['rev-parse', '--verify', 'refs/heads/feat/wip']).trim()).toBeTruthy()
  })

  it('stamps a legacy entry (grace restart) and keeps young slots', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const statePath = join(dirname(dirname(a.path)), 'treehouse-state.json')
    // Strip the stamp: a pre-auto-sweep state file must never evict on first sight.
    const legacy = JSON.parse(await readFile(statePath, 'utf8')) as { worktrees: Array<Record<string, unknown>> }
    delete legacy.worktrees[0]!.parkedAt
    await writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`)
    const result = await sweepWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(result.evicted).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
    expect(existsSync(a.path)).toBe(true)
    const stamped = JSON.parse(await readFile(statePath, 'utf8')) as { worktrees: Array<{ parkedAt?: string }> }
    expect(typeof stamped.worktrees[0]!.parkedAt).toBe('string')
    // The fresh stamp starts the grace period: a 60s TTL still keeps the slot.
    const later = await sweepWorktrees(f.git, f.dir, { settings: { root: f.pool }, maxIdleMs: 60_000 })
    expect(later.evicted).toHaveLength(0)
    expect(existsSync(a.path)).toBe(true)
  })

  it('never touches leased or damaged slots even with maxIdleMs 0', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    const b = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, b, { settings: { root: f.pool } })
    await writeFile(join(b.path, 'wip.txt'), 'wip\n')
    await verifyWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    const result = await sweepWorktrees(f.git, f.dir, { settings: { root: f.pool }, maxIdleMs: 0 })
    expect(result.evicted).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed.find(item => item.path === a.path)).toMatchObject({ status: 'leased' })
    expect(listed.find(item => item.path === b.path)).toMatchObject({ status: 'damaged' })
    expect(existsSync(a.path)).toBe(true)
    expect(existsSync(b.path)).toBe(true)
  })

  it('records a stale dirty slot as damaged instead of removing it', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    await writeFile(join(a.path, 'wip.txt'), 'wip\n')
    const statePath = join(dirname(dirname(a.path)), 'treehouse-state.json')
    await backdateParkedAt(statePath, a.path, STALE)
    const result = await sweepWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(result.evicted).toHaveLength(0)
    expect(result.skipped).toEqual([expect.objectContaining({ path: a.path, reason: 'dirty' })])
    expect(existsSync(a.path)).toBe(true)
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      worktrees: Array<{ path: string; phase: string; cause?: string }>
    }
    expect(state.worktrees[0]).toMatchObject({ path: a.path, phase: 'damaged', cause: 'dirty' })
  })

  it('acquire runs the sweep and attaches a non-empty outcome to the lease', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool }, { branch: 'feat/old' })
    f.runIn(a.path, ['commit', '--allow-empty', '-qm', 'work'])
    f.run(['merge', 'feat/old'])
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const statePath = join(dirname(dirname(a.path)), 'treehouse-state.json')
    await backdateParkedAt(statePath, a.path, STALE)
    const lease = await acquireWorktree(f.git, f.dir, { root: f.pool })
    // The evicted slot's number is recycled by the new cut — the sweep
    // payload (not path inequality) is the proof of eviction.
    expect(lease.sweep).toBeDefined()
    expect(lease.sweep!.evicted).toEqual([expect.objectContaining({ path: a.path, branch: 'feat/old' })])
    expect(lease.sweep!.deletedBranches).toEqual(['feat/old'])
    expect(() => f.run(['rev-parse', '--verify', 'refs/heads/feat/old'])).toThrow()
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ path: lease.path, status: 'leased' })
    // Nothing happened on the next acquire → no sweep payload at all.
    const second = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(second.sweep).toBeUndefined()
  })

  it('autoPrune false disables the acquire-time sweep; the manual path still works', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool }, { branch: 'feat/old' })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const statePath = join(dirname(dirname(a.path)), 'treehouse-state.json')
    await backdateParkedAt(statePath, a.path, STALE)
    const lease = await acquireWorktree(f.git, f.dir, { root: f.pool, autoPrune: false }, { branch: 'feat/other' })
    expect(lease.path).not.toBe(a.path)
    expect(lease.sweep).toBeUndefined()
    expect(existsSync(a.path)).toBe(true)
    const result = await sweepWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(result.evicted).toEqual([expect.objectContaining({ path: a.path, branch: 'feat/old' })])
    expect(existsSync(a.path)).toBe(false)
  })

  it('maxIdleMs override: 60000 keeps, 0 evicts immediately', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const kept = await sweepWorktrees(f.git, f.dir, { settings: { root: f.pool }, maxIdleMs: 60_000 })
    expect(kept.evicted).toHaveLength(0)
    expect(existsSync(a.path)).toBe(true)
    const gone = await sweepWorktrees(f.git, f.dir, { settings: { root: f.pool }, maxIdleMs: 0 })
    expect(gone.evicted).toEqual([expect.objectContaining({ path: a.path })])
    expect(existsSync(a.path)).toBe(false)
  })
  it('verify keeps an unchanged parked slot’s idle clock and re-stamps only on recovery', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const statePath = join(dirname(dirname(a.path)), 'treehouse-state.json')
    const ANCIENT = '2020-01-01T00:00:00.000Z'
    const entryOf = async () => {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        worktrees: Array<{ path: string; phase: string; parkedAt?: string }>
      }
      return state.worktrees.find(item => item.path === a.path)!
    }
    const setParkedAt = async (parkedAt: string) => {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        worktrees: Array<{ path: string; parkedAt?: string }>
      }
      const entry = state.worktrees.find(item => item.path === a.path)!
      entry.parkedAt = parkedAt
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)
    }
    await setParkedAt(ANCIENT)
    await verifyWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    // A same-phase re-verify carries the clock instead of restarting it.
    expect((await entryOf()).parkedAt).toBe(ANCIENT)
    // Damage → recovery is a real transition into parked: the clock restarts.
    await writeFile(join(a.path, 'wip.txt'), 'wip\n')
    await verifyWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(await entryOf()).toMatchObject({ phase: 'damaged' })
    await rm(join(a.path, 'wip.txt'))
    await verifyWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    const recovered = await entryOf()
    expect(recovered).toMatchObject({ phase: 'parked' })
    expect(recovered.parkedAt).not.toBe(ANCIENT)
  })

  it('re-acquires a branch whose slot was evicted with the branch retained', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool }, { branch: 'feat/kept' })
    f.runIn(a.path, ['commit', '--allow-empty', '-qm', 'work'])
    f.run(['merge', 'feat/kept'])
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    // Detach the primary HEAD behind the merge so `git branch -d` refuses the
    // delete even though the branch is merged into the sweep target (master —
    // pinned via baseBranch because inferDefaultBranch would read the detached HEAD).
    f.run(['checkout', '--detach', 'master~1'])
    const statePath = join(dirname(dirname(a.path)), 'treehouse-state.json')
    await backdateParkedAt(statePath, a.path, STALE)
    const swept = await sweepWorktrees(f.git, f.dir, { settings: { root: f.pool, baseBranch: 'master' } })
    expect(swept.evicted).toEqual([expect.objectContaining({ path: a.path, branch: 'feat/kept' })])
    expect(swept.retainedBranches).toHaveLength(1)
    expect(swept.retainedBranches[0].branch).toBe('feat/kept')
    expect(swept.retainedBranches[0].reason).toBeTruthy()
    // The same-branch re-acquire reuses the retained branch instead of failing.
    const lease = await acquireWorktree(f.git, f.dir, { root: f.pool, baseBranch: 'master' }, { branch: 'feat/kept' })
    expect(lease.branch).toBe('feat/kept')
    expect(f.runIn(lease.path, ['rev-parse', 'HEAD']).trim()).toBe(f.run(['rev-parse', 'master']).trim())
    await releaseWorktree(f.git, f.dir, lease, { settings: { root: f.pool } })
  })

  it('fails a cut for an existing unmerged branch with the explicit error', async () => {
    const f = await makeFixture()
    f.run(['checkout', '-b', 'feat/divergent'])
    f.run(['commit', '--allow-empty', '-qm', 'divergent'])
    f.run(['checkout', 'master'])
    await expectCode(
      acquireWorktree(f.git, f.dir, { root: f.pool }, { branch: 'feat/divergent' }),
      'GitFailed',
    )
  })
})

describe('destroyWorktree', () => {
  it('previews without yes and never removes', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const result = await destroyWorktree(f.git, f.dir, { path: a.path, settings: { root: f.pool } })
    expect(result).toEqual({ path: a.path, removed: false })
    expect(f.runIn(a.path, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true')
  })

  it('refuses a leased slot unless includeLeased', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(a.leaseId).toMatch(/^[0-9a-f]{32}$/)
    await expectCode(
      destroyWorktree(f.git, f.dir, { name: '1', yes: true, settings: { root: f.pool } }),
      'LeasedWorktree',
    )
  })

  it('refuses dirty work unless includeUnlanded, then removes with both flags', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    await writeFile(join(a.path, 'wip.txt'), 'wip\n')
    await expectCode(
      destroyWorktree(f.git, f.dir, { path: a.path, yes: true, settings: { root: f.pool } }),
      'UnlandedWorktree',
    )
    const result = await destroyWorktree(f.git, f.dir, {
      path: a.path,
      yes: true,
      includeUnlanded: true,
      settings: { root: f.pool },
    })
    expect(result.removed).toBe(true)
    expect(await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })).toHaveLength(0)
  })
})

describe('maxSlots cap', () => {
  it('refuses to cut a new slot at the cap, allows provable reuse, and maxSlots 0 is unlimited', async () => {
    const f = await makeFixture()
    const capped = { root: f.pool, maxSlots: 1 }
    const a = await acquireWorktree(f.git, f.dir, capped)
    await expectCode(
      acquireWorktree(f.git, f.dir, capped),
      'MaxSlots',
    )
    // The cap limits NEW slots only: provable reuse is still allowed.
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const b = await acquireWorktree(f.git, f.dir, capped)
    expect(b.path).toBe(a.path)
    // Explicitly unlimited: cuts beyond the former cap.
    const c = await acquireWorktree(f.git, f.dir, { root: f.pool, maxSlots: 0 })
    expect(c.path).not.toBe(b.path)
  })

  it('refuses to cut past the cap even when a dirty/leased slot blocks reuse', async () => {
    const f = await makeFixture()
    const capped = { root: f.pool, maxSlots: 1 }
    const a = await acquireWorktree(f.git, f.dir, capped)
    await writeFile(join(a.path, 'wip.txt'), 'wip\n')
    await expectCode(
      acquireWorktree(f.git, f.dir, capped),
      'MaxSlots',
    )
  })
})

describe('slot lifecycle (persisted phases)', () => {
  it('listWorktrees reads persisted phases and forks git only for pool resolution', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    const spy = vi.spyOn(f.git, 'run')
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed).toHaveLength(2)
    // Exactly the pool resolution (inside-work-tree + git-common-dir): no per-slot probes.
    expect(spy.mock.calls).toHaveLength(2)
    // External mutations are invisible to a read: the parked slot stays idle.
    await writeFile(join(a.path, 'wip.txt'), 'wip\n')
    const again = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(again.find(item => item.path === a.path)).toMatchObject({ status: 'idle', dirty: false })
    expect(spy.mock.calls).toHaveLength(4)
    spy.mockRestore()
  })

  it('verifyWorktrees parks a repaired slot and acquire reuses it', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    await writeFile(join(a.path, 'wip.txt'), 'wip\n')
    const b = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(b.path).not.toBe(a.path)
    // acquire recorded the failed probe as damage with its cause.
    const statePath = join(dirname(dirname(a.path)), 'treehouse-state.json')
    const damaged = JSON.parse(await readFile(statePath, 'utf8')) as {
      worktrees: Array<{ path: string; phase: string; cause?: string }>
    }
    expect(damaged.worktrees.find(item => item.path === a.path)).toMatchObject({
      phase: 'damaged',
      cause: 'dirty',
    })
    // Repair, then verify re-probes and parks the slot again.
    await rm(join(a.path, 'wip.txt'))
    const verified = await verifyWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(verified.find(item => item.path === a.path)).toMatchObject({ status: 'idle', dirty: false })
    const again = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(again.path).toBe(a.path)
  })

  it('verifyWorktrees records a missing slot as damaged/missing and prune refuses damaged', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    await rm(a.path, { recursive: true, force: true })
    // list computes missing from the filesystem stat only.
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed[0]).toMatchObject({ status: 'damaged', exists: false })
    // verify persists the phase + cause.
    await verifyWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    const statePath = join(dirname(dirname(a.path)), 'treehouse-state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      worktrees: Array<{ path: string; phase: string; cause?: string }>
    }
    expect(state.worktrees[0]).toMatchObject({ path: a.path, phase: 'damaged', cause: 'missing' })
    // prune trusts persisted phases: damaged slots are skipped, not removed.
    const plan = await pruneWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(plan.candidates).toHaveLength(0)
    expect(plan.skipped).toContainEqual(expect.objectContaining({ path: a.path, reason: 'damaged (missing)' }))
  })

  it('acquire records damage with its cause and prune skips it', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    await releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } })
    await writeFile(join(a.path, 'wip.txt'), 'wip\n')
    const b = await acquireWorktree(f.git, f.dir, { root: f.pool })
    expect(b.path).not.toBe(a.path)
    const plan = await pruneWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(plan.candidates).toHaveLength(0)
    expect(plan.skipped).toContainEqual(expect.objectContaining({ path: a.path, reason: 'damaged (dirty)' }))
    expect(plan.skipped).toContainEqual(expect.objectContaining({ path: b.path, reason: 'leased' }))
    // The damaged slot still exists — prune never touches it.
    expect(f.runIn(a.path, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true')
  })
})

describe('corrupt state recovery', () => {
  it('rebuilds entries as damaged/unverified and keeps the safety guards', async () => {
    const f = await makeFixture()
    const a = await acquireWorktree(f.git, f.dir, { root: f.pool })
    const statePath = join(dirname(dirname(a.path)), 'treehouse-state.json')
    await writeFile(statePath, 'not json {{{')
    const listed = await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ status: 'damaged', exists: true })
    // verify re-probes the adopted entry and persists the verdict (parked when clean+merged).
    const verified = await verifyWorktrees(f.git, f.dir, { settings: { root: f.pool } })
    expect(verified[0]).toMatchObject({ status: 'idle', exists: true })
    const verifiedState = JSON.parse(await readFile(statePath, 'utf8')) as {
      worktrees: Array<{ phase: string; cause?: string }>
    }
    const parkedEntry = verifiedState.worktrees[0]
    expect(parkedEntry).toMatchObject({ phase: 'parked' })
    expect(parkedEntry?.cause).toBeUndefined()
    // The rebuilt entry has no lease id → the original lease cannot release it.
    await expectCode(
      releaseWorktree(f.git, f.dir, a, { settings: { root: f.pool } }),
      'LeaseMismatch',
    )
    // Cleanup path: destroy admits leased-recovered entries by exact slot with includeLeased.
    const destroyed = await destroyWorktree(f.git, f.dir, {
      name: '1',
      yes: true,
      includeLeased: true,
      settings: { root: f.pool },
    })
    expect(destroyed.removed).toBe(true)
    expect(await listWorktrees(f.git, f.dir, { settings: { root: f.pool } })).toHaveLength(0)
  })
})
