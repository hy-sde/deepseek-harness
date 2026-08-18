/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-hashline`.
 * @module @deepseek-ai/dsh-hashline/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-hashline'

/** Cordis companion plugin name. */
export const name = 'hashline-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the hashline patch language is a pure computation
 * library (parse → apply) with no independent durable state or lifecycle
 * stream; its relations are validated behaviorally by the hashline specs.
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
