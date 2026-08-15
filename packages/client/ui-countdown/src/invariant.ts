/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-countdown`.
 * @module @deepseek-ai/dsh-client-ui-countdown/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-countdown'

/** Cordis companion plugin name. */
export const name = 'client-ui-countdown-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the sidebar-footer slot is additive (replaceRisk
 * none), the timer keeps no event or cross-plugin mutable state, and all
 * finish behavior is browser-local (chime + Notification).
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
