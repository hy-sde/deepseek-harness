/**
 * Pure protocol translation for the local host: what the server's capabilities allow, how its
 * `Location`/`LocationLink`/`Hover` payloads and write-path `TextEdit`/`PublishDiagnostics`
 * payloads normalize into the seam's contracts, and how returned formats apply to in-memory text.
 * No I/O or process state — every function here is a pure transform, which the fake-stdio tests pin
 * exactly.
 * @module @deepseek-ai/dsh-lsp-stdio/translate
 */

import type {
  LspCodeAction,
  LspDiagnostic,
  LspDocumentSymbol,
  LspHover,
  LspLocation,
  LspOperation,
  LspRange,
  LspRenameFile,
} from '@deepseek-ai/dsh-lsp'
import { LspError } from '@deepseek-ai/dsh-lsp'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  WireCodeAction,
  WireDocumentSymbol,
  WireHover,
  WireLocation,
  WireLocationLink,
  WireMarkedString,
  WirePosition,
  WireProviderCapability,
  WireRange,
  WireServerCapabilities,
  WireSymbolInformation,
  WireTextDocumentSyncKind,
  WireTextEdit,
  WireWorkspaceEdit,
} from './protocol.ts'

/**
 * The `textDocument/*` request method for each LSP operation. `diagnostics` sends no request — the
 * publish-listener path collects it — so it is unreachable here and excluded from the mapping.
 * @param operation - the LSP operation to map.
 * @returns the LSP request method name.
 */
export function requestMethod(operation: LspOperation): string {
  switch (operation) {
    case 'goToDefinition': return 'textDocument/definition'
    case 'findReferences': return 'textDocument/references'
    case 'goToImplementation': return 'textDocument/implementation'
    case 'goToTypeDefinition': return 'textDocument/typeDefinition'
    case 'hover': return 'textDocument/hover'
    case 'documentSymbols': return 'textDocument/documentSymbol'
    case 'codeActions': return 'textDocument/codeAction'
    case 'rename': return 'textDocument/rename'
    // diagnostics never sends a request (publish-listener path); reaching it here is an internal
    // error, not a wire method.
    case 'diagnostics': throw malformedResponse('LSP diagnostics does not use a request method')
    /* v8 ignore next -- exhaustive over the closed LspOperation union; unreachable. */
    default: return assertNever(operation, 'requestMethod')
  }
}

/** The `ServerCapabilities` provider field backing each operation. */
function capabilityValue(capabilities: WireServerCapabilities, operation: LspOperation): WireProviderCapability {
  switch (operation) {
    case 'goToDefinition': return capabilities.definitionProvider
    case 'findReferences': return capabilities.referencesProvider
    case 'goToImplementation': return capabilities.implementationProvider
    case 'goToTypeDefinition': return capabilities.typeDefinitionProvider
    case 'hover': return capabilities.hoverProvider
    case 'documentSymbols': return capabilities.documentSymbolProvider
    case 'codeActions': return capabilities.codeActionProvider
    case 'rename': return capabilities.renameProvider
    // Diagnostics are collected through the publish-listener path, not a capability request, so
    // there is no capability slot to inspect here.
    case 'diagnostics': return undefined
    /* v8 ignore next -- exhaustive over the closed LspOperation union; unreachable. */
    default: return assertNever(operation, 'capabilityValue')
  }
}

/** A provider capability is present when the server sent `true` or an options object (not `false`/absent). */
function supportsCapability(value: WireProviderCapability): boolean {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  return true
}

/**
 * Whether the server advertises the requested operation.
 * @param capabilities - the server's `initialize` capabilities.
 * @param operation - the LSP operation to check.
 * @returns true when the corresponding provider capability is present.
 */
export function supportsOperation(capabilities: WireServerCapabilities, operation: LspOperation): boolean {
  return supportsCapability(capabilityValue(capabilities, operation))
}

/**
 * Whether the server advertises `textDocument/formatting` support.
 * @param capabilities - the server's `initialize` capabilities.
 * @returns true when `documentFormattingProvider` is present.
 */
export function supportsFormatting(capabilities: WireServerCapabilities): boolean {
  return supportsCapability(capabilities.documentFormattingProvider)
}

/**
 * Whether a `textDocumentSync` value permits the transient `didOpen`/`didClose` this host relies on.
 * The legacy enum form implies open/close for `Full`/`Incremental`; the options form requires an
 * explicit `openClose: true`, because the protocol defaults an omitted `openClose` to false.
 * @param sync - the server's advertised `textDocumentSync` capability.
 * @returns true when transient open/close is supported.
 */
export function supportsTransientOpen(sync: WireServerCapabilities['textDocumentSync']): boolean {
  if (sync === undefined) return false
  if (typeof sync === 'number') return isOpenCloseKind(sync)
  return sync.openClose === true
}

/** Legacy enum: `Full` (1) or `Incremental` (2) imply open/close support; `None` (0) does not. */
function isOpenCloseKind(kind: WireTextDocumentSyncKind): boolean {
  return kind === 1 || kind === 2
}

/**
 * Normalize the negotiated position encoding. An omitted encoding defaults to `utf-16`; any value
 * other than `utf-16` is a protocol error this host does not support.
 * @param encoding - the server's advertised `positionEncoding`, if any.
 * @returns the string `'utf-16'`.
 * @throws Error for any non-`utf-16` encoding.
 */
export function negotiatePositionEncoding(encoding: string | undefined): 'utf-16' {
  if (encoding === undefined || encoding === 'utf-16') return 'utf-16'
  throw new Error(`server negotiated unsupported position encoding "${encoding}"; this host requires utf-16`)
}

/** Convert a wire range to the seam's range (structurally identical, but re-shaped as `readonly`). */
function toRange(range: WireRange): LspRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

/** Whether a record is a `LocationLink` (has `targetUri` + `targetSelectionRange`). */
function isLocationLink(value: Record<string, unknown>): boolean {
  return typeof value.targetUri === 'string' && isRange(value.targetSelectionRange)
}

/** Whether a record is a `Location` (has string `uri` + a range). */
function isLocation(value: Record<string, unknown>): boolean {
  return typeof value.uri === 'string' && isRange(value.range)
}

/** Structural range guard used by both location shapes. */
function isRange(value: unknown): value is WireRange {
  if (value === null || typeof value !== 'object') return false
  const range = value as Record<string, unknown>
  return isPosition(range.start) && isPosition(range.end)
}

/** Structural position guard. */
function isPosition(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const position = value as Record<string, unknown>
  return isProtocolCoordinate(position.line) && isProtocolCoordinate(position.character)
}

/** Whether a wire coordinate is a valid nonnegative integer. */
function isProtocolCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Normalize a navigation result (`Location`, `Location[]`, `LocationLink[]`, or `null`) to the seam's
 * locations. `Location` maps directly; `LocationLink` maps `targetUri` + `targetSelectionRange`.
 * @param payload - the raw `textDocument/definition|references|implementation` result.
 * @returns the normalized locations (empty for `null`/`[]`).
 * @throws Error when an element is neither a `Location` nor a `LocationLink`.
 */
export function normalizeLocations(payload: unknown): LspLocation[] {
  if (payload === null) return []
  if (payload === undefined) throw malformedResponse('LSP navigation result was missing')
  const elements = Array.isArray(payload) ? payload : [payload]
  const locations: LspLocation[] = []
  for (const element of elements) {
    if (element === null || typeof element !== 'object') {
      throw malformedResponse('LSP navigation result contained a non-object entry')
    }
    const record = element as Record<string, unknown>
    if (isLocationLink(record)) {
      const link = record as unknown as WireLocationLink
      locations.push({ uri: link.targetUri, range: toRange(link.targetSelectionRange) })
    } else if (isLocation(record)) {
      const location = record as unknown as WireLocation
      locations.push({ uri: location.uri, range: toRange(location.range) })
    } else {
      throw malformedResponse('LSP navigation result contained neither a Location nor a LocationLink')
    }
  }
  return locations
}

/**
 * Normalize a `textDocument/documentSymbol` result (hierarchical `DocumentSymbol[]` OR flat
 * `SymbolInformation[]`) into the seam's flat, depth-annotated shape. `DocumentSymbol` entries map
 * directly, flattening nested `children` after their parent at `depth + 1` (document order);
 * `SymbolInformation` entries are leaf symbols with `selectionRange` derived from `location.range`.
 * @param payload - the raw `textDocument/documentSymbol` result.
 * @returns the normalized flat symbols (empty for `null`/`[]`).
 * @throws Error when an element is structurally neither form of document symbol.
 */
export function normalizeDocumentSymbols(payload: unknown): LspDocumentSymbol[] {
  if (payload === null) return []
  if (payload === undefined) throw malformedResponse('LSP documentSymbol result was missing')
  if (!Array.isArray(payload)) throw malformedResponse('LSP documentSymbol result was not an array')
  const out: LspDocumentSymbol[] = []
  for (const element of payload) appendSymbol(out, element, 0)
  return out
}

/** Shape one symbol and append it plus its flattened descendants; rejects entries missing every marker. */
function appendSymbol(out: LspDocumentSymbol[], value: unknown, depth: number): void {
  if (value === null || typeof value !== 'object') {
    throw malformedResponse('LSP documentSymbol result contained a non-object entry')
  }
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || typeof record.kind !== 'number') {
    throw malformedResponse('LSP documentSymbol result contained a malformed symbol')
  }
  // Hierarchical DocumentSymbol: explicit selectionRange + children; missing range is tolerated
  // (a symbol still shows its name) but selectionRange-less entries have no navigable extent.
  if (isRange(record.selectionRange)) {
    const symbol = record as unknown as WireDocumentSymbol
    const selectionRange = record.selectionRange
    if (!isRange(selectionRange)) throw malformedResponse('LSP documentSymbol selectionRange was not a range')
    const range = symbol.range === undefined ? selectionRange : toRange(symbol.range)
    out.push({
      name: symbol.name,
      kind: symbol.kind,
      range,
      selectionRange: toRange(selectionRange),
      depth,
      ...(isNonNullish(symbol.detail) ? { detail: symbol.detail } : {}),
    })
    if (Array.isArray(symbol.children)) {
      for (const child of symbol.children) appendSymbol(out, child, depth + 1)
    }
    return
  }
  // Flat SymbolInformation: location-backed leaf with no children.
  const info = record as unknown as WireSymbolInformation
  // `location` is required on the wire type; keep the runtime guard for
  // malformed providers by narrowing the leaf through `unknown`.
  const location: unknown = info.location
  if (location !== undefined && isLocation(location as Record<string, unknown>)) {
    out.push({
      name: info.name,
      kind: info.kind,
      range: toRange(info.location.range),
      selectionRange: toRange(info.location.range),
      depth,
    })
    return
  }
  throw malformedResponse('LSP documentSymbol result contained a symbol with neither selectionRange nor location')
}

/** Whether a value is a present detail string (empty strings are still kept). */
function isNonNullish(value: unknown): value is string {
  return typeof value === 'string' || typeof value === 'number'
}

/**
 * Normalize a `textDocument/codeAction` result into the seam's actions. Commands are kept as
 * actions with just a title (the seam does not execute server commands); a `CodeAction` maps its
 * title, kind, preference, and the diagnostics it addresses. Edits are not resolved here — the
 * caller previews and applies through the filesystem seam, not by running unresolved edits.
 * @param payload - the raw `textDocument/codeAction` result.
 * @returns the normalized actions (empty for `null`/`[]`).
 * @throws Error when an element is structurally neither a code action nor a command.
 */
export function normalizeCodeActions(payload: unknown): LspCodeAction[] {
  if (payload === null) return []
  if (payload === undefined) throw malformedResponse('LSP codeAction result was missing')
  if (!Array.isArray(payload)) throw malformedResponse('LSP codeAction result was not an array')
  const actions: LspCodeAction[] = []
  for (const element of payload) {
    if (element === null || typeof element !== 'object') {
      throw malformedResponse('LSP codeAction result contained a non-object entry')
    }
    const record = element as Record<string, unknown>
    if (typeof record.title !== 'string') {
      throw malformedResponse('LSP codeAction result contained an action without a title')
    }
    // A raw Command carries title+command; keep only the title (commands are not executed).
    if (typeof record.command === 'string' && !Array.isArray(record.diagnostics)) {
      actions.push({ title: record.title, diagnostics: [] })
      continue
    }
    const action = record as unknown as WireCodeAction
    actions.push({
      title: action.title,
      ...(action.kind === undefined ? {} : { kind: action.kind }),
      ...(action.isPreferred === undefined ? {} : { isPreferred: action.isPreferred }),
      diagnostics: Array.isArray(action.diagnostics)
        ? action.diagnostics.map(toDiagnostic).filter((item): item is LspDiagnostic => item !== null)
        : [],
    })
  }
  return actions
}

/**
 * Normalize a `textDocument/rename` result (`WorkspaceEdit | null`) into the seam's per-file edits,
 * taking only the `changes` map. `documentChanges` variants are unsupported and surface as an empty
 * result rather than guessing their shape.
 * @param payload - the raw `textDocument/rename` result.
 * @returns the normalized per-file edits (empty for `null`).
 * @throws Error when the payment is structurally invalid.
 */
export function normalizeRename(payload: unknown): LspRenameFile[] {
  if (payload === null) return []
  if (payload === undefined) throw malformedResponse('LSP rename result was missing')
  if (typeof payload !== 'object') throw malformedResponse('LSP rename result was not an object')
  const edit = payload as unknown as WireWorkspaceEdit
  // `changes` is optional on the wire type; keep the null guard for malformed
  // providers by narrowing through `unknown`.
  const changes: unknown = edit.changes
  if (changes === null || changes === undefined) return []
  const files: LspRenameFile[] = []
  for (const [uri, rawEdits] of Object.entries(changes as Record<string, unknown>)) {
    if (rawEdits === null || rawEdits === undefined) continue
    if (!Array.isArray(rawEdits)) throw malformedResponse('LSP rename result contained a non-array edit list')
    const edits: Array<{
      readonly range: LspRange
      readonly newText: string
    }> = []
    for (const element of rawEdits) {
      if (element === null || typeof element !== 'object') {
        throw malformedResponse('LSP rename result contained a non-object TextEdit')
      }
      const record = element as Record<string, unknown>
      if (!isRange(record.range) || typeof record.newText !== 'string') {
        throw malformedResponse('LSP rename result contained a malformed TextEdit')
      }
      edits.push({ range: toRange(record.range), newText: record.newText })
    }
    files.push({ uri, edits })
  }
  return files
}

/** Render one `MarkedString` (string form verbatim; object form as a language-tagged fenced block). */
function renderMarkedString(value: WireMarkedString): string {
  if (typeof value === 'string') return value
  return `\`\`\`${value.language}\n${value.value}\n\`\`\``
}

/**
 * Normalize a `Hover` (or `null`) to the seam's hover. `MarkupContent` uses its `value`; a string
 * `MarkedString` is verbatim; a language-tagged `MarkedString` becomes a fenced code block; an array
 * joins its rendered parts with one blank line. The model-facing tool owns the complete result cap.
 * @param payload - the raw `textDocument/hover` result.
 * @returns the normalized hover, or `null` when there is no content.
 * @throws Error when the payload is a non-null, non-object, or structurally invalid hover.
 */
export function normalizeHover(payload: unknown): LspHover | null {
  if (payload === null) return null
  if (payload === undefined) throw malformedResponse('LSP hover result was missing')
  if (typeof payload !== 'object') throw malformedResponse('LSP hover result was not an object')
  const hover = payload as WireHover
  const contents = renderHoverContents(hover.contents)
  if (contents === '') return null
  const range = hover.range
  if (range === undefined) return { contents }
  if (!isRange(range)) throw malformedResponse('LSP hover result contained a malformed range')
  return { contents, range: toRange(range) }
}

/** Render the three `Hover.contents` encodings into one string (input is untrusted wire data). */
function renderHoverContents(contents: unknown): string {
  if (contents === null || contents === undefined) {
    throw malformedResponse('LSP hover result had no contents')
  }
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents.map((value) => {
      if (isMarkedString(value)) return renderMarkedString(value)
      throw malformedResponse('LSP hover contents contained a malformed MarkedString')
    }).join('\n\n')
  }
  if (typeof contents !== 'object') {
    throw malformedResponse('LSP hover contents were not MarkupContent, MarkedString, or an array')
  }
  const record = contents as Record<string, unknown>
  if (record.kind === 'markdown' || record.kind === 'plaintext') {
    if (typeof record.value !== 'string') {
      throw malformedResponse('LSP hover MarkupContent value was not a string')
    }
    return record.value
  }
  if (typeof record.language === 'string' && typeof record.value === 'string') {
    return renderMarkedString({ language: record.language, value: record.value })
  }
  throw malformedResponse('LSP hover contents were not MarkupContent, MarkedString, or an array')
}

/** Whether an untrusted value is either form of `MarkedString`. */
function isMarkedString(value: unknown): value is WireMarkedString {
  if (typeof value === 'string') return true
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.language === 'string' && typeof record.value === 'string'
}

/**
 * Normalize a `textDocument/formatting` result into `TextEdit[]`. `null` — the protocol's no-edit
 * marker — yields `[]`; any non-array payload or malformed member throws.
 * @param payload - the raw `textDocument/formatting` result.
 * @returns the validated edits (empty for `null`).
 * @throws Error when the payload is structurally invalid.
 */
export function normalizeFormattingEdits(payload: unknown): WireTextEdit[] {
  if (payload === null) return []
  if (payload === undefined) throw malformedResponse('LSP formatting result was missing')
  if (!Array.isArray(payload)) throw malformedResponse('LSP formatting result was not a TextEdit array or null')
  const edits: WireTextEdit[] = []
  for (const element of payload) {
    if (element === null || typeof element !== 'object') {
      throw malformedResponse('LSP formatting result contained a non-object entry')
    }
    const record = element as Record<string, unknown>
    if (!isRange(record.range) || typeof record.newText !== 'string') {
      throw malformedResponse('LSP formatting result contained a malformed TextEdit')
    }
    edits.push({ range: toRange(record.range), newText: record.newText })
  }
  return edits
}

/**
 * Apply normalized `TextEdit`s to in-memory text. LSP requires edits in ascending position order
 * without overlaps; applying in descending position order leaves every remaining edit's range valid
 * as the suffix changes, and each position is clipped to the document so a server bug cannot corrupt
 * the string math. Character offsets count UTF-16 code units, matching JS strings.
 * @param text - the original document text.
 * @param edits - the validated edits to apply (any order; sorted descending internally).
 * @returns the edited text, unchanged for an empty edit list.
 */
export function applyEditsToText(text: string, edits: readonly WireTextEdit[]): string {
  if (edits.length === 0) return text
  const descending = [...edits].sort(compareEditsDescending)
  let result = text
  for (const edit of descending) {
    const start = textOffset(result, edit.range.start)
    const end = textOffset(result, edit.range.end)
    result = result.slice(0, start) + edit.newText + result.slice(end)
  }
  return result
}

/**
 * Normalize a `textDocument/publishDiagnostics` payload for the target document. Only a publish
 * whose `uri` equals the target and whose `version` (when present) equals the opened version is
 * accepted — a version-mismatched publish is a stale snapshot and is dropped. The result is sorted
 * by range (start line, start char, end line, end char).
 * @param payload - the raw `PublishDiagnostics` params, or `null`/a non-object (never published).
 * @param targetUri - the URI the diagnostics were collected for.
 * @param version - the document version the document was opened at.
 * @returns the normalized, sorted diagnostics (empty for a non-matching or absent publish).
 */
export function normalizeDiagnostics(payload: unknown, targetUri: string, version: number): LspDiagnostic[] {
  if (payload === null || typeof payload !== 'object') return []
  const publish = payload as Record<string, unknown>
  if (publish.uri !== targetUri) return []
  if (publish.version !== undefined && publish.version !== version) return []
  const raw = publish.diagnostics
  if (!Array.isArray(raw)) return []
  const diagnostics: LspDiagnostic[] = []
  for (const element of raw) {
    const diagnostic = toDiagnostic(element)
    if (diagnostic !== null) diagnostics.push(diagnostic)
  }
  diagnostics.sort(compareDiagnostics)
  return diagnostics
}

/** Validate and shape one untrusted wire diagnostic, or drop it when structurally invalid. */
function toDiagnostic(value: unknown): LspDiagnostic | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!isRange(record.range) || typeof record.message !== 'string') return null
  const severity = isSeverity(record.severity) ? record.severity : undefined
  const source = typeof record.source === 'string' ? record.source : undefined
  return {
    range: toRange(record.range),
    message: record.message,
    ...(severity === undefined ? {} : { severity }),
    ...(source === undefined ? {} : { source }),
  }
}

/** Whether an untrusted value is a valid LSP severity (1 Error, 2 Warning, 3 Info, 4 Hint). */
function isSeverity(value: unknown): value is 1 | 2 | 3 | 4 {
  return value === 1 || value === 2 || value === 3 || value === 4
}

/** Sort two diagnostics by range: start line, start char, end line, end char. */
function compareDiagnostics(a: LspDiagnostic, b: LspDiagnostic): number {
  const byStart = comparePositions(a.range.start, b.range.start)
  if (byStart !== 0) return byStart
  return comparePositions(a.range.end, b.range.end)
}

/** Order two edits so the LATER one (in document order) is applied first. */
function compareEditsDescending(a: WireTextEdit, b: WireTextEdit): number {
  const byStart = comparePositions(b.range.start, a.range.start)
  if (byStart !== 0) return byStart
  return comparePositions(b.range.end, a.range.end)
}

/** Ascending document order: by line, then by UTF-16 character. */
function comparePositions(a: WirePosition, b: WirePosition): number {
  if (a.line !== b.line) return a.line - b.line
  return a.character - b.character
}

/**
 * The absolute offset of an LSP position in `text`, clipped to the document. Line terminators are
 * `\n`, `\r\n`, or `\r`; a position past the last line clamps to the end, and a character past the
 * line's end clamps to the line end.
 */
function textOffset(text: string, position: WirePosition): number {
  let offset = 0
  let line = 0
  while (line < position.line && offset < text.length) {
    const nl = text.indexOf('\n', offset)
    const cr = text.indexOf('\r', offset)
    const at = pickTerminator(nl, cr)
    if (at === undefined) break
    offset = at + (text[at] === '\r' && text[at + 1] === '\n' ? 2 : 1)
    line++
  }
  if (line < position.line) return text.length
  const end = lineEndIndex(text, offset)
  return Math.min(offset + position.character, end)
}

/** The line terminator position at or after `from`, or `undefined` when the rest has none. */
function lineEndIndex(text: string, from: number): number {
  const nl = text.indexOf('\n', from)
  const cr = text.indexOf('\r', from)
  return pickTerminator(nl, cr) ?? text.length
}

/** The earliest of a `\n` and `\r` occurrence, preferring an equal-position candidate deterministically. */
function pickTerminator(nl: number, cr: number): number | undefined {
  if (nl < 0 && cr < 0) return undefined
  if (cr < 0) return nl
  if (nl < 0) return cr
  return Math.min(nl, cr)
}

/** Create the stable structured error used for malformed server result payloads. */
function malformedResponse(message: string): LspError {
  return new LspError(message, 'LSP_MALFORMED_RESPONSE')
}
