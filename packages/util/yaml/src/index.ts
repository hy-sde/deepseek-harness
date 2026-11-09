import { parseAllDocuments, stringify, type Document, type ScalarTag } from 'yaml'
import { stringifyString } from 'yaml/util'

/**
 * A `!!js` expression node — a scalar string the entry-list Loader evaluates
 * as a JavaScript expression at entry activation. The `__jsExpr` field marks
 * the parsed value so it cannot be confused with a plain string.
 */
export interface JsExpr {
  __jsExpr: string
}

/**
 * Check whether a parsed value is a {@link JsExpr} node.
 * @param value - the parsed scalar value to test.
 * @returns true when the value carries the `__jsExpr` marker with a string payload.
 */
export function isJsExpr(value: unknown): value is JsExpr {
  return typeof value === 'object' && value !== null && '__jsExpr' in value && typeof (value as JsExpr).__jsExpr === 'string'
}

/**
 * The entry-list `!!js` tag. Only explicitly tagged scalars resolve to
 * {@link JsExpr} — plain strings stay strings, mirroring the js-yaml schema
 * this dialect replaces (whose implicit resolution was always shadowed by the
 * core `str` type).
 */
export const jsExprTag: ScalarTag = {
  tag: 'tag:yaml.org,2002:js',
  identify: isJsExpr,
  resolve(value, onError) {
    if (typeof value !== 'string' || value.trim() === '') {
      onError('The !!js tag requires a non-empty plain string value')
      return null
    }
    return { __jsExpr: value }
  },
  stringify(item, ctx, onComment, onChompKeep) {
    const value = item.value
    if (typeof value === 'object' && value !== null && typeof (value as JsExpr).__jsExpr === 'string') {
      return stringifyString({ value: (value as JsExpr).__jsExpr }, ctx, onComment, onChompKeep)
    }
    return stringifyString(item, ctx, onComment, onChompKeep)
  },
}

/**
 * Options for {@link load} and {@link loadAll}.
 */
export interface YamlLoadOptions {
  /**
   * Register the entry-list `!!js` expression dialect (see {@link jsExprTag}).
   */
  entryList?: boolean
}

/**
 * Parse a YAML document. The js-yaml-compatible replacement for
 * `yaml.load(source, { schema })`: the core schema is always used, and
 * `{ entryList: true }` plays the role of the extended entry-list schema.
 * Empty input (whitespace only) parses to `undefined`, matching js-yaml;
 * a comment-only document parses to `null` in both parsers. The return type
 * is `any`, mirroring js-yaml's own `load` signature.
 *
 * Like js-yaml, a multi-document stream (a stray `---` separator) is rejected
 * instead of silently parsing only the first document.
 *
 * Parse failures are rethrown with only the message's first line: eemeli
 * composes multi-line errors that quote the offending source, and callers
 * surface these messages in diagnostics that must not leak configuration
 * values. The retained line still carries the `at line N, column M` location.
 */
/**
 * Parse a YAML document.
 * @param source - the YAML document text to parse.
 * @param options - parser options; `entryList` registers the `!!js` dialect.
 * @returns the parsed document as `unknown`, `undefined` for empty input, or `null` for a comment-only document.
 */
export function load(source: string, options?: YamlLoadOptions): unknown {
  if (source.trim() === '') return undefined
  const documents = parseAllDocuments(source, options?.entryList ? { customTags: [jsExprTag] } : undefined)
  if (documents.length > 1) throw new SyntaxError('expected a single document in the stream, but found more')
  const document = documents[0]
  // A non-empty source that yields no document is comment-only; both parsers give null.
  if (document === undefined) return null
  throwOnParseLog(document)
  return document.toJS()
}

/**
 * Parse every document in a YAML stream — the js-yaml-compatible replacement
 * for `yaml.loadAll(source, { schema })`. Documents that carry no content
 * (e.g. a trailing `---`) parse to `undefined`, matching js-yaml's empty
 * document behavior. Parse failures are rethrown with only the message's
 * first line, like {@link load}.
 */
/**
 * Parse every document in a YAML stream.
 * @param source - the YAML stream text to parse.
 * @param options - parser options; `entryList` registers the `!!js` dialect.
 * @returns every parsed document as `unknown`; content-less documents map to `undefined`.
 */
export function loadAll(source: string, options?: YamlLoadOptions): unknown[] {
  const documents = parseAllDocuments(source, options?.entryList ? { customTags: [jsExprTag] } : undefined)
  for (const document of documents) throwOnParseLog(document)
  return documents
    .map((document) => {
      const value = document.toJS()
      return value === null && document.contents === null ? undefined : value
    })
}

/**
 * js-yaml threw on anything its schema could not resolve — most visibly
 * unknown tags like `!!js` outside the entry-list dialect. eemeli yaml only
 * warns for unresolved tags (the document still parses to `null`), so parse
 * logs are promoted here: any error, or any `TAG_RESOLVE_FAILED` warning,
 * becomes a single-line SyntaxError. The retained line still carries the
 * `at line N, column M` location, and quoting the source is dropped so
 * diagnostics cannot leak configuration values.
 */
function throwOnParseLog(document: Document): void {
  const tagWarnings = document.warnings.filter(warning => (warning as { code?: string }).code === 'TAG_RESOLVE_FAILED')
  const first = document.errors[0] ?? tagWarnings[0]
  if (first === undefined) return
  throw new SyntaxError(first.message.split('\n', 1)[0])
}

/**
 * Options for {@link dump}.
 */
export interface YamlDumpOptions {
  /**
   * Register the entry-list `!!js` expression dialect (see {@link jsExprTag}).
   */
  entryList?: boolean
  /**
   * Dump shared object references as copies instead of YAML anchors and
   * aliases — js-yaml's `noRefs: true`.
   */
  noRefs?: boolean
  /**
   * Maximum line width for folded content; `-1` (js-yaml's unlimited) is
   * mapped to eemeli yaml's `0`.
   */
  lineWidth?: number
}

/**
 * Serialize a value as YAML. The js-yaml-compatible replacement for
 * `yaml.dump(value, { schema, ... })`. Single-quote style is forced to match
 * the output the js-yaml era produced.
 */
/**
 * Serialize a value as YAML.
 * @param value - the value to serialize.
 * @param options - serializer options; `entryList` writes `!!js` scalars back.
 * @returns the YAML text.
 */
export function dump(value: unknown, options?: YamlDumpOptions): string {
  return stringify(value, {
    ...(options?.entryList === true ? { customTags: [jsExprTag] } : {}),
    aliasDuplicateObjects: !options?.noRefs,
    singleQuote: true,
    ...(options?.lineWidth !== undefined ? { lineWidth: options.lineWidth === -1 ? 0 : options.lineWidth } : {}),
  })
}
