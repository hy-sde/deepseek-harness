/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-url`.
 * @module @deepseek-ai/dsh-session-url/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-url'

/** Cordis companion plugin name. */
export const name = 'session-url-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the handler registers into the internal-URL registry
 * (whose registration invariants the router owns) and reads the session-query
 * read model exactly like the session-query tools — it adds no event or
 * mutable-data relationship of its own.
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
