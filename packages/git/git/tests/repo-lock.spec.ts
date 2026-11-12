/**
 * Tests for `withRepoLock`/`withPathLock`: queue keying by git common dir
 * (worktrees of one repository share one queue), explicit path-scope keying,
 * reentrance detection, failure isolation, and abort checks.
 * @module
 */

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ReentrantLockError, withPathLock, withRepoLock } from '../src/repo-lock.ts'

let root = ''
let sub = ''
const realRepos: string[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-git-lock-'))
  // An empty .git dir keeps this fixture out of real git's hands: the queue
  // key falls back to the in-process discovery of ./vcs.ts.
  await mkdir(join(root, '.git'), { recursive: true })
  sub = join(root, 'sub')
  await mkdir(sub, { recursive: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  for (const dir of realRepos) rmSync(dir, { recursive: true, force: true })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function gitRun(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

/** Real repository with one linked worktree, for common-dir keying proofs. */
async function makeRealRepo(): Promise<{ dir: string; wt: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-git-lock-repo-'))
  realRepos.push(dir)
  gitRun(dir, ['init', '-q', '-b', 'master'])
  gitRun(dir, ['config', 'user.email', 'lock@test'])
  gitRun(dir, ['config', 'user.name', 'lock'])
  gitRun(dir, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(dir, 'seed.txt'), 'seed\n')
  gitRun(dir, ['add', '.'])
  gitRun(dir, ['commit', '-q', '-m', 'init'])
  const wt = join(dir, 'wt')
  gitRun(dir, ['worktree', 'add', '--detach', wt, 'master'])
  return { dir, wt }
}

describe('withRepoLock', () => {
  it('keys worktrees/subdirs of the same repo on one queue (shared serialization)', async () => {
    const order: string[] = []
    const started = deferred()
    const gate = deferred()
    const slow = async (): Promise<void> => {
      started.resolve()
      await gate.promise
      order.push('slow')
    }
    const fast = async (): Promise<void> => {
      order.push('fast')
    }
    const first = withRepoLock(sub, slow)
    await started.promise
    expect(order).toEqual([])
    const second = withRepoLock(root, fast)
    gate.resolve()
    await first
    expect(order).toEqual(['slow'])
    await second
    expect(order).toEqual(['slow', 'fast'])
  })

  it('keys a linked worktree and the main checkout on one queue', async () => {
    const { dir, wt } = await makeRealRepo()
    // Same queue key: nesting the worktree cwd inside the main checkout's
    // block reports the reentrance instead of running as a second queue.
    const error = await withRepoLock(dir, () => withRepoLock(wt, async () => 'inner')).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ReentrantLockError)
    expect(error).toMatchObject({ key: `repo:${realpathSync(join(dir, '.git'))}` })
  })

  it('throws ReentrantLockError on nested same-key acquisition', async () => {
    const error = await withRepoLock(root, () => withRepoLock(sub, async () => 'inner')).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ReentrantLockError)
    expect(error).toMatchObject({ code: 'ReentrantLock', key: `repo:${root}`, holder: expect.any(String) })
  })

  it('allows nesting a different key', async () => {
    const inner = await withRepoLock(root, () => withPathLock(join(root, 'other'), async () => 'nested'))
    expect(inner).toBe('nested')
  })

  it('a failing block does not poison the queue for the next caller', async () => {
    await expect(withRepoLock(sub, async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    await expect(withRepoLock(root, async () => 'after')).resolves.toBe('after')
  })

  it('honors an already-aborted signal by refusing to run', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(withRepoLock(root, async () => 'never', controller.signal)).rejects.toThrow('operation was aborted while waiting for the repository lock')
  })

  it('returns the block result', async () => {
    await expect(withRepoLock(sub, async () => 42)).resolves.toBe(42)
  })
})

describe('withPathLock', () => {
  it('keeps distinct paths distinct', async () => {
    const order: string[] = []
    const aStarted = deferred()
    const aGate = deferred()
    const bStarted = deferred()
    const first = withPathLock(join(root, 'a'), async () => {
      aStarted.resolve()
      await aGate.promise
      order.push('a')
    })
    await aStarted.promise
    const second = withPathLock(join(root, 'b'), async () => {
      bStarted.resolve()
      order.push('b')
    })
    // b runs to completion while a still holds its queue: distinct keys.
    await bStarted.promise
    expect(order).toEqual(['b'])
    aGate.resolve()
    await first
    await second
    expect(order).toEqual(['b', 'a'])
  })
})
