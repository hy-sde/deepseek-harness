import type { ChildProcess } from 'node:child_process'
import type { SubprocessHandle } from './types.ts'

/**
 * Grace windows and platform semantics for one teardown pass.
 *
 * @param eofGraceMs - Milliseconds the target may keep running after its stdin
 * writer is ended, letting it flush durable state before any signal.
 * @param termGraceMs - Milliseconds to wait after the graceful signal before
 * forcing termination. Must satisfy `0 <= termGraceMs <= eofGraceMs`.
 * @param platform - Platform the ladder runs on; defaults to `process.platform`.
 * On `win32` the graceful-signal tier is skipped entirely and the ladder goes
 * straight to forced termination.
 */
export interface TerminationLadderConfig {
  readonly eofGraceMs: number
  readonly termGraceMs: number
  readonly platform?: NodeJS.Platform
}

/**
 * A target the ladder can tear down without knowing its process kind.
 *
 * Both `ChildProcess` and the dsh-subprocess `SubprocessHandle` satisfy this
 * structurally through {@link childProcessTarget} and
 * {@link subprocessHandleTarget}; hand-rolled implementations are equally
 * valid. Each adapter carries the listener and timer hygiene of the site it
 * was extracted from.
 */
export interface TerminationLadderTarget {
  /**
   * End the target's stdin writer, requesting cooperative shutdown. Absent
   * when the target owns its stdin writer (for example an SDK query object)
   * and the ladder must not touch it.
   */
  readonly endStdin?: () => void
  /** Whether the target has already exited; an exited target skips the ladder. */
  hasExited(): boolean
  /**
   * Resolve `true` when the target exits within `graceMs`, `false` when the
   * window elapses first. Must not leak timers or listeners after settling.
   * @param graceMs - Observation window in milliseconds.
   * @returns Promise resolving `true` on observed exit, `false` on timeout.
   */
  exitWithin(graceMs: number): Promise<boolean>
  /** Begin the graceful-signal tier. Idempotent for targets whose graceful
   * and forced tiers share one verb. */
  signalTerm(): void
  /**
   * Begin forced termination and await the exit proof. Implementations throw
   * when forced termination fails or the exit proof cannot be observed.
   * @param graceMs - Bound for the forced-termination confirmation window.
   * @returns Promise resolving once the target's exit is proven.
   */
  forceTerminate(graceMs: number): Promise<void>
}

/**
 * Thrown by the `TerminationLadder` constructor when the configured grace
 * windows violate the ladder invariants. Fails loud at the earliest
 * resolvable point — plugin load for validated configs, disposal for
 * caller-assembled ones.
 */
export class TerminationLadderConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TerminationLadderConfigError'
  }
}

/**
 * Shared EOF → SIGTERM → SIGKILL teardown machine for child processes and
 * managed subprocess ranges.
 *
 * The ladder ends the target's stdin writer and gives it `eofGraceMs` to exit
 * cooperatively, then (outside `win32`) sends the graceful signal and gives it
 * `termGraceMs` more, then forces termination and awaits the exit proof. It
 * resolves only on the actual exit edge and never leaks timers or listeners.
 * Waiting longer to flush than to die is the standing rule — the constructor
 * rejects `eofGraceMs < termGraceMs`.
 */
export class TerminationLadder {
  private readonly eofGraceMs: number
  private readonly termGraceMs: number
  private readonly platform: NodeJS.Platform

  /**
   * @param config - Grace windows and platform semantics.
   * @throws `TerminationLadderConfigError` when a grace is not a finite
   * number, `termGraceMs` is negative, or `eofGraceMs < termGraceMs`.
   */
  constructor(config: TerminationLadderConfig) {
    const { eofGraceMs, termGraceMs, platform = process.platform } = config
    if (!Number.isFinite(eofGraceMs)) {
      throw new TerminationLadderConfigError(
        `termination-ladder: eofGraceMs must be a finite number, got ${String(eofGraceMs)}`,
      )
    }
    if (!Number.isFinite(termGraceMs)) {
      throw new TerminationLadderConfigError(
        `termination-ladder: termGraceMs must be a finite number, got ${String(termGraceMs)}`,
      )
    }
    if (termGraceMs < 0) {
      throw new TerminationLadderConfigError(
        `termination-ladder: termGraceMs must be a non-negative number, got ${String(termGraceMs)}`,
      )
    }
    if (eofGraceMs < termGraceMs) {
      throw new TerminationLadderConfigError(
        `termination-ladder: eofGraceMs (${String(eofGraceMs)}) must be greater than or equal to termGraceMs (${String(termGraceMs)})`,
      )
    }
    this.eofGraceMs = eofGraceMs
    this.termGraceMs = termGraceMs
    this.platform = platform
  }

  /**
   * Walk the ladder for one target. Resolves once the target has exited;
   * throws the single collected failure, or an `AggregateError` naming every
   * collected failure when more than one tier misbehaved.
   *
   * @param target - The teardown target.
   * @returns Promise resolving after the target's exit is proven.
   */
  async run(target: TerminationLadderTarget): Promise<void> {
    if (target.hasExited()) return
    const failures: unknown[] = []
    target.endStdin?.()
    let exited = false
    if (this.eofGraceMs > 0) {
      try {
        exited = await target.exitWithin(this.eofGraceMs)
      } catch (error: unknown) {
        failures.push(error)
      }
      // Settle outside the tier's catch: its own throw is a result, not a tier failure.
      if (exited) return settle(failures)
    }
    if (this.platform !== 'win32') {
      target.signalTerm()
      if (this.termGraceMs > 0) {
        try {
          exited = await target.exitWithin(this.termGraceMs)
        } catch (error: unknown) {
          failures.push(error)
        }
        if (exited) return settle(failures)
      }
    }
    try {
      await target.forceTerminate(this.termGraceMs)
    } catch (error: unknown) {
      failures.push(error)
    }
    settle(failures)
  }
}

/**
 * Throw the collected failures in their canonical shape: nothing on success,
 * the lone failure bare, several failures as one `AggregateError`.
 *
 * @param failures - Failures collected while walking the ladder.
 */
function settle(failures: readonly unknown[]): void {
  if (failures.length === 0) return
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, 'subprocess teardown failed')
}

/**
 * Race the child's exit against a timer. Neither outcome leaves anything
 * behind on the child: the exit listener is removed on timeout and the timer
 * is cleared on exit, so the ladder's tiers never accumulate listeners. An
 * exit already recorded at entry resolves immediately, so an OS marker that
 * lands between tiers is honored.
 *
 * @param child - The child process to observe.
 * @param graceMs - Observation window in milliseconds.
 * @returns Promise resolving `true` on observed exit, `false` on timeout.
 */
function childExitsWithin(child: ChildProcess, graceMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    // `.unref()` so a pending grace timer never keeps the parent's loop alive.
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, graceMs).unref()
    child.once('exit', onExit)
  })
}

/**
 * Send `SIGKILL`, then reject unless an exit edge arrives within the window:
 * the kill error, the child's `error` event, or the confirmation timeout. An
 * exit already recorded at entry resolves without a second signal.
 *
 * @param child - The child process to force-terminate.
 * @param graceMs - Confirmation window in milliseconds.
 * @returns Promise resolving once the child exit is proven.
 */
function forceTerminateChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let accepted = false
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const settle = (complete: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      complete()
    }
    const onExit = (): void => { settle(resolve) }
    const onError = (error: Error): void => { settle(() => { reject(error) }) }
    child.once('exit', onExit)
    child.once('error', onError)
    const timer = setTimeout(() => {
      const disposition = accepted ? 'accepted' : 'refused'
      settle(() => {
        reject(new Error(`runtime process did not exit within ${String(graceMs)}ms after SIGKILL was ${disposition}`))
      })
    }, graceMs).unref()
    try {
      accepted = child.kill('SIGKILL')
      if (child.exitCode !== null || child.signalCode !== null) settle(resolve)
    } catch (error: unknown) {
      settle(() => { reject(new Error('SIGKILL failed', { cause: error })) })
    }
  })
}

/**
 * Adapt a `ChildProcess` to the ladder target interface, carrying the
 * `dsh-sdk-client` dispose hygiene verbatim: entry exit checks, unref'd
 * timers, and full listener cleanup.
 *
 * @param child - The child process to adapt.
 * @returns Ladder target over the child process.
 */
export function childProcessTarget(child: ChildProcess): TerminationLadderTarget {
  return {
    endStdin: () => {
      child.stdin?.end()
    },
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
    exitWithin: (graceMs: number) => childExitsWithin(child, graceMs),
    signalTerm: () => {
      child.kill('SIGTERM')
    },
    forceTerminate: (graceMs: number) => forceTerminateChild(child, graceMs),
  }
}

/**
 * Adapt a dsh-subprocess `SubprocessHandle` to the ladder target interface.
 *
 * The managed range owns its termination procedure: `terminate()` begins the
 * provider's bounded SIGTERM→SIGKILL escalation, so the graceful tier begins
 * it and the forced tier re-issues it only when the graceful tier never ran
 * (the `win32` path), then awaits the exit proof without a second derived
 * grace that could overflow the provider's own timer.
 *
 * @param handle - The managed subprocess range to adapt.
 * @returns Ladder target over the managed range.
 */
export function subprocessHandleTarget(handle: SubprocessHandle): TerminationLadderTarget {
  let signaled = false
  let rangeGone = false
  // Observing `done` also defuses its rejection for this adapter; the ladder
  // still surfaces provider-observation failures through `exitWithin` and
  // `waitForExit`.
  void handle.done.then(
    () => {
      rangeGone = true
    },
    () => {},
  )
  return {
    endStdin: () => {
      try {
        handle.stdin?.end()
      } catch {
        // Concurrently closing the stdin writer does not change range ownership.
      }
    },
    hasExited: () => rangeGone,
    exitWithin: async (graceMs: number) => {
      const controller = new AbortController()
      const timer = setTimeout(() => {
        controller.abort()
      }, graceMs)
      try {
        return await handle.waitForExit(controller.signal)
      } finally {
        clearTimeout(timer)
      }
    },
    signalTerm: () => {
      signaled = true
      handle.terminate()
    },
    forceTerminate: async () => {
      if (!signaled) handle.terminate()
      await handle.waitForExit()
    },
  }
}
