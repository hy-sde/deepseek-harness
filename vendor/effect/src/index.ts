/**
 * @stability stable
 * @since 2.0.0
 */

export {
  /**
   * @stability stable
   * @category re-exports
   * @since 2.0.0
   */
  absurd,
  /**
   * @stability stable
   * @category re-exports
   * @since 2.0.0
   */
  cast,
  /**
   * @stability stable
   * @category re-exports
   * @since 2.0.0
   */
  flow,
  /**
   * @stability stable
   * @category re-exports
   * @since 2.0.0
   */
  hole,
  /**
   * @stability stable
   * @category re-exports
   * @since 2.0.0
   */
  identity,
  /**
   * @stability stable
   * @category re-exports
   * @since 2.0.0
   */
  pipe
} from "./Function.ts"

/**
 * Trimmed vendored fork (`vendor/effect`, mod-log in `vendor/README.md`):
 * re-exports only the combinator core used by the Harness — Effect, Cause,
 * Data, Exit, Deferred, Scheduler. All other upstream namespaces (Schema,
 * Stream, Channel, Layer, Request, Metric, scheduling, platform subsystems)
 * are removed upstream of this file.
 */

/**
 * @stability stable
 * @since 2.0.0
 */
export * as Cause from "./Cause.ts"

/**
 * @stability stable
 * @since 2.0.0
 */
export * as Data from "./Data.ts"

/**
 * @stability stable
 * @since 2.0.0
 */
export * as Deferred from "./Deferred.ts"

/**
 * @stability stable
 * @since 2.0.0
 */
export * as Effect from "./Effect.ts"

/**
 * @stability stable
 * @since 2.0.0
 */
export * as Exit from "./Exit.ts"

/**
 * @stability stable
 * @since 2.0.0
 */
export * as Scheduler from "./Scheduler.ts"
