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
 * Services this row requires to register the scheme handler. Declared as hard
 * injects so Cordis guarantees activation order: the sqlite engine publishes
 * `sessionQuery` synchronously at the start of its own apply, and this plugin
 * must not race ahead of it. When an assembly provides neither `internalUrls`
 * nor `sessionQuery`, the row simply stays dormant ("waiting for …") instead
 * of throwing and failing boot.
 */
export const inject = ['internalUrls', 'sessionQuery']

/**
 * Register the `session://` scheme into the mounted internal-URL registry.
 * Requires both `ctx.internalUrls` and `ctx.sessionQuery` (declared above).
 */
export function apply(ctx: Context): void {
  const disposer = ctx.internalUrls.register(new SessionProtocolHandler(ctx.sessionQuery))
  ctx.effect(() => {
    return () => {
      disposer()
    }
  })
}

/** Cordis plugin object (loader reads `inject` from this shape). */
export default { name, inject, apply }
