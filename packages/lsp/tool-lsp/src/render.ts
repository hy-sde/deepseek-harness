/**
 * Pure formatting and coordinate conversion for the `lsp` tool: one-based↔zero-based UTF-16 cursor
 * conversion, workspace-grouped location rendering with `file:`-URI resolution, complete-result
 * capping, and UI presentation. No I/O — a UI may call the presenter on live streaming and on
 * replay, so it depends only on the tool arguments.
 * @module @deepseek-ai/dsh-tool-lsp/render
 */

import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { LspDocumentSymbol, LspHover, LspLocation, LspOperation, LspPosition } from '@deepseek-ai/dsh-lsp'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The operations the tool exposes, as a runtime tuple for schema enum + validation. */
export const LSP_OPERATIONS: readonly LspOperation[] = [
  'goToDefinition',
  'findReferences',
  'goToImplementation',
  'goToTypeDefinition',
  'hover',
  'documentSymbols',
  'codeActions',
  'rename',
  'diagnostics',
]

/** Default cap on rendered locations before an omission marker is appended. */
export const DEFAULT_MAX_LOCATIONS = 100

/** Default cap on the complete rendered tool result, including truncation metadata. */
export const DEFAULT_MAX_RESULT_CHARS = 16_000

/** Validated `lsp` arguments after coordinate checks. */
export interface LspToolInput {
  readonly operation: LspOperation
  readonly filePath: string
  /** Zero-based UTF-16 position converted from the one-based model coordinates. */
  readonly position: LspPosition
  /** The new name for `rename`, when provided. */
  readonly newName?: string
}

/** The raw, schema-typed argument shape. */
export interface LspToolArgs {
  readonly operation: string
  readonly file_path: string
  readonly line: number
  readonly character: number
  readonly new_name?: string
}

/**
 * Validate and convert model arguments: `operation` must be one of the registered operations;
 * `line`/`character` are positive one-based integers converted to the seam's zero-based position.
 * For operations that do not consult the cursor (`documentSymbols`, `diagnostics`, `rename` needing
 * no position), the caller passes 1:1 and the seam argument is accepted. `new_name` is passed through
 * for `rename` and rejected (when present) for operations that do not use it.
 * @param args - the schema-validated raw arguments.
 * @returns the validated input with a zero-based position.
 * @throws Error when the operation is unknown or a coordinate is not a positive integer.
 */
export function parseLspArgs(args: LspToolArgs): LspToolInput {
  if (!isOperation(args.operation)) {
    throw new Error(`operation must be one of ${LSP_OPERATIONS.join(', ')}`)
  }
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const line = oneBased(args.line, 'line')
  const character = oneBased(args.character, 'character')
  if (args.new_name !== undefined && args.operation !== 'rename') {
    throw new Error(`new_name is only meaningful for rename, not ${args.operation}`)
  }
  if (args.operation === 'rename' && (args.new_name === undefined || args.new_name.trim().length === 0)) {
    throw new Error('rename requires a non-empty new_name')
  }
  return {
    operation: args.operation,
    filePath: args.file_path,
    // The model counts from 1; the seam (and protocol) count from 0.
    position: { line: line - 1, character: character - 1 },
    ...(args.new_name === undefined ? {} : { newName: args.new_name }),
  }
}

/** Whether a string is one of the four operations. */
function isOperation(value: string): value is LspOperation {
  return (LSP_OPERATIONS as readonly string[]).includes(value)
}

/** The one-word LSP severity label for `1` Error … `4` Hint. */
function severityLabel(severity: number): string {
  switch (severity) {
    case 1: return 'Error'
    case 2: return 'Warning'
    case 3: return 'Information'
    case 4: return 'Hint'
    default: return String(severity)
  }
}

/** Validate a one-based coordinate is a positive integer. */
function oneBased(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (one-based)`)
  }
  return value
}

/**
 * Render a locations result grouped by file, converting each zero-based location back to a one-based
 * `path:line:character` entry. A `file:` URI inside the workspace becomes a workspace-relative path;
 * outside it, a URI-derived absolute path; a non-`file:` URI is kept verbatim. Applies `maxLocations` and
 * appends an omission marker when it truncates by count, then applies the complete result cap.
 * @param locations - the seam's locations (possibly empty).
 * @param workspaceUri - the provider's canonical workspace `file:` URI.
 * @param maxLocations - the cap before truncation.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered text; a distinct no-result line when there are none.
 */
export function formatLocations(
  locations: readonly LspLocation[],
  workspaceUri: string,
  maxLocations: number,
  maxResultChars: number,
): string {
  if (locations.length === 0) return boundResult('No results.', maxResultChars, 'locations')
  const shown = locations.slice(0, maxLocations)
  const omitted = locations.length - shown.length
  const grouped = new Map<string, string[]>()
  for (const location of shown) {
    const path = renderUri(location.uri, workspaceUri)
    const line = location.range.start.line + 1
    const character = location.range.start.character + 1
    const entries = grouped.get(path) ?? []
    entries.push(`${path}:${line}:${character}`)
    grouped.set(path, entries)
  }
  const lines: string[] = []
  for (const entries of grouped.values()) lines.push(...entries)
  if (omitted > 0) {
    lines.push(`… ${omitted} more location${omitted === 1 ? '' : 's'} omitted (limit ${maxLocations}).`)
  }
  return boundResult(lines.join('\n'), maxResultChars, 'locations')
}

/**
 * Render a hover result, applying `maxResultChars` last and keeping its marker within the cap.
 * @param hover - the normalized hover, or `null` for no hover.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered hover text; a distinct no-result line for `null`.
 */
export function formatHover(hover: LspHover | null, maxResultChars: number): string {
  const text = hover === null ? 'No hover information.' : hover.contents
  return boundResult(text, maxResultChars, 'hover')
}

/**
 * Render a document-symbol result as a tree: each symbol on one `line:column NAME [detail]` line,
 * indented by depth (the file is shown once as the title line). Nested children follow their parent.
 * @param filePath - the queried file, as the model passed it.
 * @param symbols - the normalized hierarchical symbols (possibly empty).
 * @param maxSymbols - the cap on rendered symbols before an omission marker.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered tree; a distinct no-result line when the list is empty.
 */
export function formatDocumentSymbols(
  filePath: string,
  symbols: readonly LspDocumentSymbol[],
  maxSymbols: number,
  maxResultChars: number,
): string {
  if (symbols.length === 0) return boundResult('No symbols found.', maxResultChars, 'symbols')
  const lines = [`Symbols in ${filePath}:`]
  let count = 0
  for (const symbol of symbols) {
    if (count >= maxSymbols) break
    count++
    const pos = symbol.selectionRange.start
    const detail = symbol.detail === undefined ? '' : ` — ${symbol.detail}`
    lines.push(`${'  '.repeat(symbol.depth)}${pos.line + 1}:${pos.character + 1} ${symbol.name}${detail}`)
  }
  if (symbols.length - count > 0) {
    lines.push(`… ${symbols.length - count} more symbol(s) omitted (limit ${maxSymbols}).`)
  }
  return boundResult(lines.join('\n'), maxResultChars, 'symbols')
}

/**
 * Render a code-action result: one numbered `title` line per action with kind/preferred markers.
 * @param actions - the normalized actions (possibly empty).
 * @param maxActions - the cap on rendered actions before an omission marker.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered list; a distinct no-result line when empty.
 */
export function formatCodeActions(
  actions: readonly { title: string; kind?: string; isPreferred?: boolean }[],
  maxActions: number,
  maxResultChars: number,
): string {
  if (actions.length === 0) return boundResult('No code actions available.', maxResultChars, 'code actions')
  const lines: string[] = []
  for (const [index, action] of actions.entries()) {
    if (lines.length >= maxActions) break
    const markers = [
      ...(action.isPreferred === true ? ['preferred'] : []),
      ...(action.kind === undefined ? [] : [action.kind]),
    ]
    lines.push(`${index}. ${action.title}${markers.length > 0 ? ` [${markers.join(', ')}]` : ''}`)
  }
  const omitted = actions.length - lines.length
  if (omitted > 0) lines.push(`… ${omitted} more action(s) omitted (limit ${maxActions}).`)
  return boundResult(lines.join('\n'), maxResultChars, 'code actions')
}

/**
 * Render a rename result: one block per affected file with its `path:line:newText` edits, using the
 * workspace `file:` URI to relativize `file:` targets. Non-`file:` targets stay verbatim.
 * @param files - the normalized per-file edits (possibly empty).
 * @param workspaceUri - the provider's canonical workspace `file:` URI.
 * @param maxEdits - the cap on rendered edits before an omission marker.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered rename; a no-edit line when the map is empty.
 */
export function formatRename(
  files: readonly { uri: string; edits: readonly { range: { start: LspPosition; end: LspPosition }; newText: string }[] }[],
  workspaceUri: string,
  maxEdits: number,
  maxResultChars: number,
): string {
  if (files.length === 0) return boundResult('Rename returned no edits.', maxResultChars, 'rename')
  const lines: string[] = []
  let count = 0
  fileLoop: for (const file of files) {
    const path = renderUri(file.uri, workspaceUri)
    lines.push(`${path}:`)
    count++
    for (const edit of file.edits) {
      if (count >= maxEdits) {
        lines.push(`… more edits omitted (limit ${maxEdits}).`)
        break fileLoop
      }
      count++
      const start = edit.range.start
      lines.push(`  ${start.line + 1}:${start.character + 1} → ${edit.newText.replaceAll('\n', '\\n')}`)
    }
  }
  return boundResult(lines.join('\n'), maxResultChars, 'rename')
}

/**
 * Render a diagnostics result, one `${path}:${line} [Severity] [source] message` line per diagnostic.
 * The path is the file the diagnostics were collected for, as the model passed it.
 * @param filePath - the queried file, as the model passed it.
 * @param diagnostics - the normalized diagnostics (possibly empty).
 * @param maxDiagnostics - the cap on rendered diagnostics before an omission marker.
 * @param maxResultChars - the complete rendered-text cap, including truncation metadata.
 * @returns the rendered list; a clean "no diagnostics" line when empty.
 */
export function formatDiagnostics(
  filePath: string,
  diagnostics: readonly {
    range: { start: LspPosition }
    severity?: number
    source?: string
    message: string
  }[],
  maxDiagnostics: number,
  maxResultChars: number,
): string {
  if (diagnostics.length === 0) return boundResult('No diagnostics.', maxResultChars, 'diagnostics')
  const lines: string[] = []
  let shown = 0
  for (const diagnostic of diagnostics) {
    if (shown >= maxDiagnostics) break
    shown++
    const start = diagnostic.range.start
    const severity = diagnostic.severity === undefined ? '' : ` [${severityLabel(diagnostic.severity)}]`
    const source = diagnostic.source === undefined ? '' : ` (${diagnostic.source})`
    lines.push(`${filePath}:${start.line + 1}${severity}${source} — ${diagnostic.message}`)
  }
  const omitted = diagnostics.length - shown
  if (omitted > 0) lines.push(`… ${omitted} more diagnostic(s) omitted (limit ${maxDiagnostics}).`)
  return boundResult(lines.join('\n'), maxResultChars, 'diagnostics')
}

/** Bound a complete rendered result, including the truncation notice itself. */
function boundResult(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text
  const notice = `\n… ${label} truncated (limit ${maxChars} characters).`
  if (notice.length >= maxChars) return notice.slice(0, maxChars)
  return `${text.slice(0, maxChars - notice.length)}${notice}`
}

/**
 * Resolve a location URI without applying the harness host's path rules. A valid `file:` URI becomes
 * workspace-relative when it is under the provider's canonical workspace URI, or a URI-derived
 * absolute path otherwise; malformed and non-`file:` URIs remain verbatim.
 * @param uri - the target URI from the seam.
 * @param workspaceUri - the provider's canonical workspace `file:` URI.
 * @returns the display path or the verbatim URI.
 */
export function renderUri(uri: string, workspaceUri: string): string {
  if (!uri.startsWith('file:')) return uri
  let target: URL
  let workspace: URL
  try {
    target = new URL(uri)
    workspace = new URL(workspaceUri)
  } catch {
    return uri
  }
  if (workspace.protocol !== 'file:') return uri
  // A `file:` URI does not carry its world's OS, so a leading `/X:` segment is
  // read as a Windows drive. A POSIX workspace literally rooted at `/c:/...`
  // would mis-render (display only; edits and reads use the exact URI).
  const drivePath = /^\/[a-z](?::|%3A)/iu
  const windowsWorld = workspace.hostname.length > 0 || drivePath.test(workspace.pathname)
  const targetWindowsWorld = windowsWorld && (target.hostname.length > 0 || drivePath.test(target.pathname))
  const workspacePath = filePath(workspace, windowsWorld)
  const targetPath = filePath(target, targetWindowsWorld)
  if (workspacePath === undefined || targetPath === undefined) return uri
  if (windowsWorld !== targetWindowsWorld) return targetPath
  const path = windowsWorld ? win32 : posix
  const relative = path.relative(workspacePath, targetPath)
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  const rendered = relative === '' ? '.' : outside ? targetPath : relative
  return windowsWorld ? rendered.replaceAll('\\', '/') : rendered
}

/** Decode a file URL for its execution world while containing malformed URL failures. */
function filePath(url: URL, windows: boolean): string | undefined {
  try {
    const path = fileURLToPath(url, { windows })
    return path.includes('\0') ? undefined : path
  } catch {
    // `fileURLToPath` rejects malformed escapes, authorities, and encoded path separators.
    return undefined
  }
}

/**
 * UI presentation for a pending `lsp` call. Uses a generic search card; the title carries the
 * operation and one-based cursor, and `locations` focuses the queried line. The shared location
 * shape has no character, so the title preserves the column.
 * @param args - the raw tool arguments.
 * @returns the generic call view.
 */
export function presentLspCall(args: LspToolArgs): GenericCallView {
  return {
    card: 'generic',
    kind: 'search',
    title: `LSP ${args.operation} ${args.file_path}:${args.line}:${args.character}`,
    locations: [{ path: args.file_path, line: args.line }],
  }
}
