/**
 * Shared cancellation helpers for the local LSP provider's host-I/O, queue, and protocol phases.
 * @module @deepseek-ai/dsh-lsp-stdio/abort
 */

import { timeoutOf } from '@deepseek-ai/dsh-timeout'
import { Effect, Scheduler } from 'effect'

/**
 * Effect's default scheduler dispatches on `setImmediate`; the sync scheduler
 * dispatches on `queueMicrotask`, which vitest's fake timers do not mock. The
 * fork's tests use fake timers heavily, so every plugin-side Effect runtime
 * must pin the sync scheduler or cancel-without-advancing tests deadlock.
 */
const syncScheduler = new Scheduler.MixedScheduler('sync')

/**
 * Build an abort Error carrying the signal's reason and preserving timeout classification.
 * @param signal - the aborted signal whose reason to surface.
 * @returns the timeout reason if present, else the Error reason, else a generic aborted Error.
 */
export function abortError(signal: AbortSignal): Error {
  const timeout = timeoutOf(signal)
  if (timeout !== undefined) return timeout
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  return new Error('LSP query aborted')
}

/**
 * Throw the signal's classified abort error when it has already fired.
 * @param signal - the optional query cancellation signal.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

/**
 * One `abortable` wait's result, carried in the success channel so the race
 * never needs an untagged `Error` failure channel (the transport pool must
 * see the ORIGINAL rejection object by identity, so nothing may wrap it).
 */
type AbortOutcome<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'failed'; readonly error: Error }
  | { readonly kind: 'aborted'; readonly error: Error }

/**
 * Await work while allowing a query signal to abandon its wait; the underlying work keeps its own
 * handlers and continues to its owner-defined quiescence boundary.
 *
 * `Effect.raceFirst` is the `Promise.race` analogue (first termination wins,
 * whichever it is) — deliberately not `Effect.race`, whose first-success
 * semantics would hang on a failing `work` until the signal fired. Both sides
 * are `Effect.callback`s; a work rejection/abort is carried as a VALUE, and
 * the facade rethrows it, so the rejection crosses the boundary as the
 * **same Error object** (the pool distinguishes transport failures by
 * identity, `failedWith`). On a signal win the work fiber is interrupted but
 * the promise itself keeps running detached — its `.then` stays attached, so
 * no settlement is lost as an unhandled rejection.
 * @param work - the owned asynchronous work.
 * @param signal - optional query cancellation.
 * @returns the work result, or a rejection carrying the classified abort reason.
 */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.reject(abortError(signal))
  const waitWork: Effect.Effect<AbortOutcome<T>> = Effect.callback((resume) => {
    work.then(
      (value) => {
        resume(Effect.succeed({ kind: 'done' as const, value }))
      },
      (error: unknown) => {
        resume(
          Effect.succeed({
            kind: 'failed' as const,
            error: error instanceof Error ? error : new Error(String(error)),
          }),
        )
      },
    )
  })
  const waitAbort: Effect.Effect<AbortOutcome<T>> = Effect.callback((resume) => {
    const onAbort = (): void => {
      resume(Effect.succeed({ kind: 'aborted' as const, error: abortError(signal) }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // The returned cleanup effect runs when the race interrupts this fiber
    // (the work won), replacing the hand-rolled `.finally` removal.
    return Effect.sync(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
  return Effect.runPromise(Effect.raceFirst(waitWork, waitAbort), { scheduler: syncScheduler }).then(
    (outcome) => {
      if (outcome.kind !== 'done') throw outcome.error
      return outcome.value
    },
  )
}
