/**
 * Per-repository write serialization.
 *
 * Git uses O_EXCL lock files (`index.lock`, `packed-refs.lock`, …) with no
 * waiter, so concurrent in-process mutations against the same repository fail
 * immediately rather than block; worktrees share the primary repo's metadata,
 * so racing across worktrees has the same failure mode. This module is the
 * single serialization point.
 *
 * Queues are keyed by {@link LockScope}: `repo` (default) keys on the
 * repository's git common dir, so every checkout of one repository — main
 * checkout and linked worktrees — shares one queue; `path` keys on the literal
 * path for callers serializing on a non-repository location (e.g. a review
 * ledger file under the git dir). The `repo` key is resolved with
 * `git rev-parse --path-format=absolute --git-common-dir`; when git cannot
 * answer (non-repository paths, git unavailable), the key falls back to the
 * in-process discovery of `./vcs.ts` and then to the literal path.
 *
 * @module @deepseek-ai/dsh-git/repo-lock
 */

import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { repo } from './vcs.ts'

const execFileP = promisify(execFile)

/** What a lock queue is keyed on. */
export type LockScope =
  // The repository's git common dir: every checkout of one repository shares one queue.
  | 'repo'
  // The literal `cwd` path: distinct paths never share a queue.
  | 'path'

/** Upper bound for the `git rev-parse` probe that resolves the repo-scope key. */
const GIT_PROBE_TIMEOUT_MS = 10_000

/**
 * Thrown when an acquisition re-enters a queue key its caller already holds.
 * Nested same-key acquisition would otherwise deadlock: the inner call waits
 * for the outer block while the outer block waits for the inner call.
 */
export class ReentrantLockError extends Error {
  override readonly name = 'ReentrantLockError' as const

  /** Machine-readable error code. */
  readonly code = 'ReentrantLock' as const

  /** The scope-qualified queue key that is already held. */
  readonly key: string

  /** Top stack frames of the holder's acquisition site, for diagnosis. */
  readonly holder: string

  constructor(scope: LockScope, resolved: string, holder: string) {
    super(`lock (${scope} scope) for "${resolved}" is already held by this caller — nested same-key acquisition would deadlock (holder acquired at ${holder})`)
    this.key = `${scope}:${resolved}`
    this.holder = holder
  }
}

/** Resolved queue key. */
interface LockKey {
  /** Map key for the write chain and the holder registry. */
  id: string
  /** Human-readable resolved location for error messages. */
  resolved: string
}

const repoWriteChain = new Map<string, Promise<unknown>>()

/**
 * Async context tracking the queue keys the running block already holds, so a
 * nested same-key acquisition fails with {@link ReentrantLockError} instead of
 * deadlocking. Async descendants of a holder count as the holder.
 */
const lockHolders = new AsyncLocalStorage<Map<string, string>>()

/** `git rev-parse --git-common-dir` for `cwd`, or null when git cannot answer. */
async function probeCommonDir(cwd: string): Promise<string | null> {
  try {
    const probe = await execFileP('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      timeout: GIT_PROBE_TIMEOUT_MS,
    })
    return probe.stdout.trim()
  } catch {
    // rev-parse fails for non-repository paths, missing git, or a vanished cwd.
    return null
  }
}

/** Resolve the git common dir of the repository containing `cwd`. */
async function commonDir(cwd: string): Promise<string> {
  const value = await probeCommonDir(cwd)
  if (value === null || value.length === 0) {
    // No git answer: keep the legacy in-process discovery, then the literal path.
    return repo(cwd)?.root ?? cwd
  }
  const absolute = isAbsolute(value) ? value : resolve(cwd, value)
  try {
    return await realpath(absolute)
  } catch {
    // The dir vanished between rev-parse and realpath: use the unresolved path.
    return absolute
  }
}

async function resolveKey(cwd: string, scope: LockScope): Promise<LockKey> {
  if (scope === 'path') return { id: `path:${cwd}`, resolved: cwd }
  const resolved = await commonDir(cwd)
  return { id: `repo:${resolved}`, resolved }
}

/** Top stack frames of the current acquisition, for reentrance diagnostics. */
function holderSite(): string {
  const frames = (new Error().stack ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('at ') && !line.includes('node:internal'))
    .slice(1, 4)
  return frames.length > 0 ? frames.join(' <- ') : 'unknown site'
}

/**
 * Serialize an async block on an explicit {@link LockScope}. A failing block
 * does not poison the queue for the next caller; the abort signal is checked
 * once the block reaches the head of the queue. Nesting an acquisition of the
 * same queue inside its own block throws {@link ReentrantLockError}; nesting a
 * different queue is legal.
 *
 * @param cwd - directory the queue is resolved from (`repo` scope: any
 *   directory inside the repository; `path` scope: the exact serialized path —
 *   pass a stable, identical string per logical resource).
 * @param scope - what the queue is keyed on.
 * @param fn - the mutating async block.
 * @param signal - optional abort checked before the block runs.
 * @returns the block's result.
 */
export async function withLock<T>(cwd: string, scope: LockScope, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const held = lockHolders.getStore()
  const key = await resolveKey(cwd, scope)
  const holder = held?.get(key.id)
  if (holder !== undefined) throw new ReentrantLockError(scope, key.resolved, holder)
  const prior = repoWriteChain.get(key.id)
  const site = holderSite()
  const run = (async () => {
    if (prior) {
      try { await prior } catch { // A failed predecessor must not block us from running.
      }
    }
    if (signal?.aborted) {
      throw new Error('operation was aborted while waiting for the repository lock')
    }
    const inner = new Map(held ?? [])
    inner.set(key.id, site)
    return lockHolders.run(inner, fn)
  })()
  repoWriteChain.set(key.id, run)
  try {
    return await run
  } finally {
    if (repoWriteChain.get(key.id) === run) repoWriteChain.delete(key.id)
  }
}

/**
 * Serialize an async block that mutates a git repository.
 *
 * Queues are keyed on the repository's git common dir, so every checkout of
 * one repository — main checkout and linked worktrees — shares one queue and
 * cannot race on the shared git metadata. A failing block does not poison the
 * queue for the next caller. Nesting an acquisition of the same queue inside
 * its own block throws {@link ReentrantLockError} instead of deadlocking;
 * nesting a different queue is legal.
 *
 * @param cwd - any directory inside the repository.
 * @param fn - the mutating async block.
 * @param signal - optional abort checked before the block runs.
 * @returns the block's result.
 */
export async function withRepoLock<T>(cwd: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withLock(cwd, 'repo', fn, signal)
}

/**
 * Serialize an async block on the literal `cwd` path only: two distinct paths
 * never share a queue, even when both sit inside the same repository.
 * Everything else matches {@link withRepoLock}.
 *
 * @param cwd - the exact serialized path; pass a stable, identical string per
 *   logical resource.
 * @param fn - the mutating async block.
 * @param signal - optional abort checked before the block runs.
 * @returns the block's result.
 */
export async function withPathLock<T>(cwd: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withLock(cwd, 'path', fn, signal)
}
