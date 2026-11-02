export * as core from "../core/index.ts";
export * from "./schemas.ts";
export * from "./checks.ts";
export * from "./errors.ts";
export * from "./parse.ts";
export * from "./compat.ts";

export type { infer } from "../core/index.ts";
export type { JSONType } from "../core/util.ts";
export type { CompileOptions } from "../core/index.ts";
export {
  globalRegistry,
  type GlobalMeta,
  registry,
  config,
  memoizer,
  $output,
  $input,
  $brand,
  clone,
  regexes,
  treeifyError,
  prettifyError,
  formatError,
  flattenError,
  TimePrecision,
  util,
  NEVER,
  INVALID,
  toZod,
  compile,
  withParser,
  ZodCompileAsyncError,
  ZodCompileUnsupportedError,
  getDiscriminatedOption,
} from "../core/index.ts";
export { toJSONSchema } from "../core/json-schema-processors.ts";
export { fromJSONSchema } from "./from-json-schema.ts";
export { deepPartial } from "./deep-partial.ts";
// Types and values both, from one module — re-exporting the types from core would collide.
export { input, output } from "./in-out.ts";

export * as locales from "../locales/index.ts";

// iso must be exported from top-level https://github.com/colinhacks/zod/issues/4491
export { ZodISODateTime, ZodISODate, ZodISOTime, ZodISODuration } from "./iso.ts";
export * as iso from "./iso.ts";

// coerce
export type {
  ZodCoercedString,
  ZodCoercedNumber,
  ZodCoercedBigInt,
  ZodCoercedBoolean,
  ZodCoercedDate,
} from "./coerce.ts";
export * as coerce from "./coerce.ts";
