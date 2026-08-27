/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-wiki`.
 * @module @deepseek-ai/dsh-client-ui-wiki/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-wiki'

/** Cordis companion plugin name. */
export const name = 'client-ui-wiki-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the drawer's slots are additive (replaceRisk none),
 * the store keeps no cross-plugin mutable state, and the actual graph
 * availability is enforced on the host by @deepseek-ai/dsh-logseq-graph's
 * own invariant. The drawer renders its own 'wiki service absent' states.
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
