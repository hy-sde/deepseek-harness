/**
 * SDK-client transport teardown: stdin EOF (cooperative quiesce), then
 * SIGTERM, then SIGKILL, resolving only after the process has actually
 * exited — the shared `TerminationLadder` from `@deepseek-ai/dsh-subprocess`.
 * The SDK client runs OUTSIDE any harness context, so the `ctx.subprocess`
 * service is unavailable; it rides the package's pure termination ladder
 * instead, which carries no runtime dependencies. This module stays the
 * seam's documented exception for SDK-managed transports.
 *
 * @module @deepseek-ai/dsh-sdk-client/dispose
 */

import { TerminationLadder, childProcessTarget } from '@deepseek-ai/dsh-subprocess'
import type { ChildProcess } from 'node:child_process'

/**
 * Tear the runtime down to quiescence, resolving only after exit: close stdin
 * and allow cooperative flush, then use the host's graceful and forced
 * termination semantics. POSIX sends `SIGTERM` before `SIGKILL`; Windows
 * skips directly to forced termination because Node maps both signals to
 * `TerminateProcess`.
 * @param child - the runtime child process to tear down.
 * @param graces - the EOF and termination-confirmation windows (ms; the EOF
 * window is widened to at least the termination window).
 * @param platform - the host platform, injectable for unit coverage.
 * @throws When forced termination errors or the child does not report exit
 * within `disposeGraceMs`.
 */
export async function disposeRuntimeProcess(
  child: ChildProcess,
  graces: { disposeEofGraceMs: number; disposeGraceMs: number },
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  // The shared ladder keeps the EOF window at least as wide as the termination
  // window. Public dispose options never documented that invariant, so widen
  // the EOF window instead of rejecting a config whose teardown always
  // completed before the ladder existed — close() must not skip transport
  // close over a grace-ordering quibble.
  await new TerminationLadder({
    eofGraceMs: Math.max(graces.disposeEofGraceMs, graces.disposeGraceMs),
    termGraceMs: graces.disposeGraceMs,
    platform,
  }).run(childProcessTarget(child))
}
