/**
 * Effect-host seam for the dsh-llm-retry pilot.
 *
 * ONE `ManagedRuntime` per mounted plugin instance (i.e. per cordis context):
 * created in `apply` and disposed in the plugin's dispose effect, so no fiber
 * or timer outlives the plugin. When the planned `effect-host` host service
 * lands, this seam swaps to a shared `ctx.effectRuntime` — both sides expose
 * the same `runExit` + `dispose` pair.
 *
 * The runtime evaluates on a microtask scheduler (`MixedScheduler("sync")`)
 * rather than the default `setImmediate` dispatcher, so the wait's dispatch
 * keeps promise semantics: vitest fake-timer tests still drive the same global
 * timers the original `setTimeout` implementation armed.
 *
 * @module @deepseek-ai/dsh-llm-retry/runtime
 */

import { Cause, Duration, Effect, Exit, Layer, ManagedRuntime, Scheduler } from 'effect'

/** One Effect runtime per mounted plugin instance. */
export interface RetryRuntime {
  /**
   * Run one effect to an `Exit`-carrying promise. The promise never rejects;
   * defects and typed failures surface through the `Exit` (and cancel the
   * fiber when `signal` aborts).
   */
  runExit<A>(effect: Effect.Effect<A>, signal: AbortSignal): Promise<Exit.Exit<A>>
  /** Release runtime resources; safe to call once per mounted context. */
  dispose(): Promise<void>
}

const syncScheduler = new Scheduler.MixedScheduler('sync')

export function makeRetryRuntime(): RetryRuntime {
  const runtime = ManagedRuntime.make(Layer.empty)
  return {
    runExit: (effect, signal) =>
      runtime.runPromiseExit(effect, { signal, scheduler: syncScheduler }),
    dispose: async () => {
      await runtime.dispose()
    },
  }
}

/**
 * Cancellable delay, Effect-native: resolves `true` after the full `delayMs`
 * elapse, or `false` as soon as `signal` aborts (before or during the wait).
 *
 * Abort plumbing is `RunOptions.signal`: the runtime interrupts the fiber, the
 * pending `Clock.sleep` timer is cleared by its own finalizer, and an
 * interrupt-only cause maps back to `false` here at the facade.
 */
export function cancellableDelay(
  delayMs: number,
  signal: AbortSignal,
  runtime: RetryRuntime,
): Promise<boolean> {
  return runtime
    .runExit(Effect.sleep(Duration.millis(delayMs)).pipe(Effect.as(true)), signal)
    .then((exit) => {
      if (Exit.isSuccess(exit)) return true
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return false
      // A pure sleep cannot fail; surface anything else instead of swallowing it.
      throw Cause.squash(exit.cause)
    })
}
