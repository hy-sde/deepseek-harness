/**
 * Producer-actor identity for the ported OpenWiki engine.
 *
 * Mirrors the upstream `openwiki/<version>` actor convention so generated
 * origin and verification stamps remain stable and interoperable.
 * @module @deepseek-ai/dsh-openwiki-core
 */

/** Engine version reflected in generated origin. */
export const OPENWIKI_VERSION = '0.4.3'

/** OKF origin actor for engine-owned finalization passes. */
export const OPENWIKI_PRODUCER_ACTOR = `openwiki/${OPENWIKI_VERSION}`
