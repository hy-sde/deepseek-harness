/**
 * Resolution options for filesystem calls in the Session's current directory.
 * Non-agent calls leave directory defaults to the filesystem provider.
 * @module @deepseek-ai/dsh-tool-fs/session-cwd
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-working-directory'

const PARENT_PATH_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/

/**
 * The calling agent's working directory for this call, or `undefined` when
 * none applies. Resolved through the working-directory service; parent
 * traversal in the resolved directory or the requested path makes a
 * symlinked directory's filesystem identity observable, so those
 * canonicalize first.
 * @param ctx - context containing the working-directory service.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @param requestedPath - the path the provider will resolve, when known.
 * @returns the calling agent's session cwd, or undefined for a non-agent caller (the backend then applies its own default).
 */
export async function sessionCwd(ctx: Context, exec: ToolExecution, requestedPath?: string): Promise<string | undefined> {
  if (exec.agent === undefined) return undefined
  const ensured = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  if (requestedPath === undefined || (!PARENT_PATH_SEGMENT.test(ensured) && !PARENT_PATH_SEGMENT.test(requestedPath))) return ensured
  return canonicalPath(ensured)
}

/**
 * Resolution options shared by all model-facing filesystem tools.
 * @param ctx - context containing the working-directory service.
 * @param exec - the tool-execution context supplying session cwd and cancellation.
 * @param requestedPath - the path the provider will resolve, when known.
 * @returns provider resolution options for the current tool call.
 */
export async function sessionResolveOptions(
  ctx: Context,
  exec: ToolExecution,
  requestedPath?: string,
): Promise<{ cwd?: string; signal?: AbortSignal }> {
  const cwd = await sessionCwd(ctx, exec, requestedPath)
  return {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
  }
}
