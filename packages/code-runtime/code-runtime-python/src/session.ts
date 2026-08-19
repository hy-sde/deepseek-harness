/**
 * Persistent-session registry for the Python kernel backend. Maps a
 * `sessionId` to one kernel whose namespace and event-loop state survive every
 * run in the session; on `reset` the old kernel is shut down before a fresh one
 * answers; at disposal every kernel is terminated to quiescence. One exec at a
 * time per session (a kernel serializes stdin), so concurrent runs for the same
 * session queue on a per-session promise chain.
 * @module @deepseek-ai/dsh-code-runtime-python/src/session
 */

import type { CodeBindingNamespace } from '@deepseek-ai/dsh-code-runtime'
import { PythonKernel } from './kernel.ts'
import type { PythonKernelStartConfig } from './kernel.ts'
import type { KernelExecResult } from './kernel.ts'

/** One live session: its kernel (spawned lazily) and the serialized run tail. */
interface PythonSession {
  kernel: PythonKernel | null
  /** Tail of the per-session serialization chain (resolves to the last run). */
  queue: Promise<unknown>
  /** Idle reaping timer, when configured. */
  idleTimer?: NodeJS.Timeout
}

/** Session-management knobs on top of the per-kernel start config. */
export interface PythonSessionRegistryConfig {
  /** Per-kernel spawn options (interpreter, cwd, timing knobs). */
  start: Omit<PythonKernelStartConfig, 'cwd' | 'env'>
  /**
   * Spawn working directory (kernel default, refined per run when the request
   * carries a cwd).
   */
  cwd: string
  /** Environment inherited by spawned kernels. */
  env?: NodeJS.ProcessEnv
  /** Reap a session whose kernel sits unused for this long; 0 disables. */
  sessionIdleMs: number
}

/** Options for one registered-session run. */
export interface PythonSessionRunOptions {
  /** Discard prior kernel state and start fresh before this run. */
  reset?: boolean
  /** Abort source; SIGINT is raised inside the kernel on abort. */
  signal?: AbortSignal
  /** Per-run working directory override. */
  cwd?: string
  /** Per-run environment overrides. */
  env?: Record<string, string>
}

/**
 * Registers sessions and schedules every run onto its session's serialization
 * tail. A session kernel that died mid-run (or was killed settling a prior
 * run) is replaced with a fresh one and the run retried once, like omp's
 * kernel-session registry — state loss on a hard kill is the accepted cost.
 */
export class PythonSessionRegistry {
  readonly #sessions = new Map<string, PythonSession>()
  readonly #config: PythonSessionRegistryConfig
  #disposed: boolean = false

  constructor(config: PythonSessionRegistryConfig) {
    this.#config = config
  }

  /** Register (or return) the session for an id and run the work on its tail. */
  async executeOnSession(
    sessionId: string,
    code: string,
    bindings: CodeBindingNamespace[],
    options: PythonSessionRunOptions = {},
  ): Promise<KernelExecResult> {
    if (this.#disposed) {
      return {
        status: 'error', logs: [], cancelled: false, invalidOutput: false,
        message: 'python kernel session registry disposed', killed: true,
      }
    }
    let session = this.#sessions.get(sessionId)
    if (session === undefined) {
      session = { kernel: null, queue: Promise.resolve() }
      this.#sessions.set(sessionId, session)
    }
    const run = (): Promise<KernelExecResult> =>
      this.#runOnSession(session, sessionId, code, bindings, options)
    session.queue = session.queue.then(run, run)
    try {
      return (await session.queue) as KernelExecResult
    } finally {
      this.#maybeReap(sessionId)
    }
  }

  /** Shut down and drop one session's kernel. */
  async close(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId)
    if (session === undefined) return
    this.#sessions.delete(sessionId)
    clearTimeout(session.idleTimer)
    const kernel = session.kernel
    session.kernel = null
    if (kernel !== null) await kernel.shutdown().catch(() => {})
  }

  /** Terminate every kernel and drop every session (runtime disposal). */
  async disposeAll(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const sessions = [...this.#sessions.values()]
    this.#sessions.clear()
    const kernels: PythonKernel[] = []
    for (const session of sessions) {
      clearTimeout(session.idleTimer)
      if (session.kernel !== null) kernels.push(session.kernel)
      session.kernel = null
    }
    await Promise.allSettled(kernels.map(kernel => kernel.shutdown()))
  }

  #maybeReap(sessionId: string): void {
    if (this.#disposed) return
    if (this.#config.sessionIdleMs <= 0) return
    const session = this.#sessions.get(sessionId)
    if (session === undefined || session.kernel === null) return
    clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      void this.close(sessionId)
    }, this.#config.sessionIdleMs)
    session.idleTimer.unref()
  }

  async #acquireKernel(sessionId: string, session: PythonSession): Promise<PythonKernel> {
    if (session.kernel !== null && session.kernel.isAlive()) return session.kernel
    const previous = session.kernel
    if (previous !== null) {
      await previous.shutdown().catch(() => {})
      session.kernel = null
    }
    if (this.#disposed) {
      throw new Error('dsh-code-runtime-python: session registry disposed while acquiring kernel')
    }
    if (this.#sessions.get(sessionId) !== session) {
      throw new Error('dsh-code-runtime-python: session invalidated while acquiring kernel')
    }
    const kernel = await PythonKernel.start({
      ...this.#config.start,
      cwd: this.#config.cwd,
      ...this.#config.env !== undefined ? { env: this.#config.env } : {},
    })
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- set by disposeAll elsewhere
    if (this.#disposed) {
      await kernel.shutdown().catch(() => {})
      throw new Error('dsh-code-runtime-python: session registry disposed while acquiring kernel')
    }
    if (this.#sessions.get(sessionId) !== session) {
      await kernel.shutdown().catch(() => {})
      throw new Error('dsh-code-runtime-python: session invalidated while acquiring kernel')
    }
    session.kernel = kernel
    return kernel
  }

  async #runOnSession(
    session: PythonSession,
    sessionId: string,
    code: string,
    bindings: CodeBindingNamespace[],
    options: PythonSessionRunOptions,
  ): Promise<KernelExecResult> {
    if (options.reset === true) {
      // Reset first, then acquire: prior kernel state is discarded and its
      // shutdown completes before the fresh kernel answers this run.
      const previous = session.kernel
      if (previous !== null) {
        session.kernel = null
        clearTimeout(session.idleTimer)
        await previous.shutdown().catch(() => {})
      }
    }
    let kernel = await this.#acquireKernel(sessionId, session)
    const first = await this.#executeOnce(kernel, sessionId, code, bindings, options)
    // A kernel that died or was killed settling the run is replaced once and
    // the run retried; otherwise return what we got.
    const needsRetry = first.killed && session === this.#sessions.get(sessionId)
    if (!needsRetry) return first
    await kernel.shutdown().catch(() => {})
    if (session !== this.#sessions.get(sessionId)) return first
    kernel = await this.#acquireKernel(sessionId, session)
    const second = await this.#executeOnce(kernel, sessionId, code, bindings, options)
    if (second.killed) {
      // Give up restoring state: report the second outcome with the first's
      // message so the caller sees that retries also died.
      return { ...second, message: second.message || first.message }
    }
    return second
  }

  #executeOnce(
    kernel: PythonKernel,
    sessionId: string,
    code: string,
    bindings: CodeBindingNamespace[],
    options: PythonSessionRunOptions,
  ): Promise<KernelExecResult> {
    return kernel.execute(sessionId, code, bindings, {
      ...options.signal !== undefined ? { signal: options.signal } : {},
      ...options.cwd !== undefined ? { cwd: options.cwd } : {},
      ...options.env !== undefined ? { env: options.env } : {},
    })
  }
}
