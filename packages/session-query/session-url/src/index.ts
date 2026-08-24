/**
 * The `session://` internal-URL scheme, registered into the shared
 * internal-URL registry (`ctx.internalUrls`) so the ported read/grep tools
 * can navigate the harness's own session history as files.
 *
 * Host-plane: the handler lives with the registry it extends (the base
 * bundle) and reads the live-preferred logical corpus from `ctx.sessionQuery`
 * — an exact-read service that works even when a deployment disables content
 * search (`openAt: 'never'`); only `session://search` degrades there.
 * @module @deepseek-ai/dsh-session-url
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-internal-urls'
import type {} from '@deepseek-ai/dsh-session-query'
import { SessionProtocolHandler } from './handler.ts'

export * from './handler.ts'
export { SessionProtocolHandler }

/** Cordis plugin name used by loader diagnostics. */
export const name = 'session-url'

/**
 * Register the `session://` scheme into the mounted internal-URL registry.
 * Requires both `ctx.internalUrls` and `ctx.sessionQuery`, so this row mounts
 * after those services in an assembly that owns them (the base bundle).
 */
export function apply(ctx: Context): void {
  const iu = ctx.get('internalUrls')
  if (iu === undefined) {
    throw new Error('session-url requires the internal-urls registry (ctx.internalUrls) — mount @deepseek-ai/dsh-internal-urls first')
  }
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    throw new Error('session-url requires the session-query engine (ctx.sessionQuery) — mount @deepseek-ai/dsh-session-query-sqlite (or another engine) first')
  }
  const disposer = iu.register(new SessionProtocolHandler(query))
  ctx.effect(() => {
    return () => {
      disposer()
    }
  })
}

export default apply
