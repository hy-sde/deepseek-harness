/**
 * Cooperative tool-call timeout enforcer. A tool declares `timeoutMs` and
 * promises to honor `exec.signal`; this wrapper arms that deadline and maps its
 * own expiry to `TOOL_TIMEOUT` without racing or abandoning the tool promise.
 *
 * The wrapper body runs as an Effect (B1 pilot pattern): `acquireRelease`
 * owns the `exec.signal` swap so the caller's signal is restored on every exit
 * path (success, failure, interruption) instead of a hand-rolled try/finally,
 * and the promise boundary is an explicit `Effect.tryPromise`/`either` adapter.
 * The deadline itself stays with `@deepseek-ai/dsh-timeout` — `deadline()` is
 * precisely the cooperative abort mechanism (signal + classified reason); the
 * Effect `timeout*` family was deliberately NOT used here because it
 * interrupts/abandons the source on expiry, which would break the cooperative
 * contract that the tool reaches quiescence before the result is replaced.
 *
 * FIXME: settle the intended `@deepseek-ai/dsh-timeout-guard` rename before the
 * first tagged release — suggestion only, aligning the name with its `guard/`
 * home; decide at resolution time
 * ([regrouping Agent Note](../../../../.agents/notes/implemented/architecture/2026-07-29-package-regrouping.md)).
 *
 * @module @deepseek-ai/dsh-tool-call-timeout-policy
 */

import { Cause, Effect, Exit, Scheduler } from 'effect'
import type { Context } from '@deepseek-ai/cordis'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * The code owned by this plugin, used BOTH as the internal {@link deadline}
 * classification code AND as the structured error `code` on the replacement
 * tool result. Scoping {@link timeoutOf} to it keeps a nested outer deadline
 * (another `tools/execute` wrapper's timer that fired first) from being misread
 * as this plugin's own timeout — it reads as an ordinary upstream cancel.
 */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'timeout-policy'

/** The tool registry service this plugin wraps (`tools/execute`) and reads (`get`). */
export const inject = ['tools']

/**
 * Microtask scheduler for the promise boundary: Effect's default scheduler
 * dispatches on `setImmediate`, which vitest fake timers mock — a deadlock in
 * the timer-driven timeout tests. The mixed "sync" scheduler dispatches through
 * `queueMicrotask` (never faked) while `deadline()`'s `setTimeout` still drives
 * real fake-timer advances.
 */
const syncScheduler = new Scheduler.MixedScheduler('sync')

/**
 * The structured result substituted when this plugin's deadline wins. `content`
 * is the model-facing message; `error.code` is the same {@link TOOL_TIMEOUT}
 * this plugin owns, so a retry/sandbox plugin (and replay) can route on it.
 *
 * @param timeoutMs - the elapsed budget, rendered into the model-facing message.
 * @returns the `isError` {@link ToolExecutionResult} with a `TOOL_TIMEOUT` error.
 */
function toolTimeoutResult(timeoutMs: number): ToolExecutionResult {
  const message = `tool call timed out after ${timeoutMs}ms`
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: 'ToolTimeoutError', code: TOOL_TIMEOUT } },
  }
}

/**
 * Register the timeout wrapper. It resolves the caller-visible tool definition,
 * temporarily replaces `exec.signal`, delegates, restores the upstream signal,
 * and replaces the result only when this wrapper's own timer fired.
 */
export function apply(ctx: Context): void {
  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const timeoutMs = ctx.tools.get(exec.name, exec.agent)?.timeoutMs
    // A tool that declares no budget: no deadline, delegate unchanged.
    if (timeoutMs === undefined) return next()

    // `using` keeps the deadline timer armed for the whole dispatch (cleared when
    // this async listener settles); the listener must stay async — a sync return
    // would close the using-scope immediately and clear the timer at 0ms.
    using d = deadline(exec.signal, timeoutMs, TOOL_TIMEOUT)
    const upstream = exec.signal

    return await Effect.runPromise(
      Effect.scoped(
        // Swap the derived deadline onto exec for dispatch and restore the
        // caller's signal on every exit path, so post-execute listeners never
        // see this plugin's (possibly already-aborted) timeout signal.
        Effect.acquireRelease(
          Effect.sync(() => { exec.signal = d.signal }),
          () => Effect.sync(() => { exec.signal = upstream }),
        ).pipe(
          Effect.flatMap(() =>
            Effect.tryPromise(() => next()).pipe(
              Effect.exit,
              Effect.flatMap((exit) => {
                // If OUR timer fired (scoped by code — a nested outer deadline reads as
                // undefined here), the tool/capability saw the abort and reached
                // quiescence; replace whatever it returned (its own abort result) with the
                // structured TOOL_TIMEOUT the model sees. A provider-owned abort ERROR
                // result is replaced the same way; a caller cancel keeps its own path.
                if (timeoutOf(d.signal, TOOL_TIMEOUT) !== undefined) {
                  return Effect.succeed(toolTimeoutResult(timeoutMs))
                }
                // A real failure keeps its error: rethrow the original as a defect
                // so the caller's promise rejects with exactly what it threw.
                if (Exit.isFailure(exit)) return Effect.die(Cause.squash(exit.cause))
                return Effect.succeed(exit.value)
              }),
            ),
          ),
        ),
      ),
      { scheduler: syncScheduler },
    )
  })
}
