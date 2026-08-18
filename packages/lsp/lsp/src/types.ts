/**
 * LSP seam vocabulary: the normalized request, provider, and result contracts. Types only — the
 * {@link LspError} taxonomy and the {@link LspProviderId} brand factory are runtime and live in
 * `index.ts`. Positions and ranges are zero-based UTF-16, matching the protocol; the model-facing
 * tool owns the one-based cursor convention. The seam exposes no protocol types, process or document
 * controls, or generic JSON-RPC escape hatch — only the four semantic operations and the two
 * write-path operations (formatting, diagnostics).
 * @module @deepseek-ai/dsh-lsp/types
 */

import type { LspProviderId } from './brand.ts'

/**
 * The four semantic queries the seam and model expose. A closed union: adding an operation is a
 * compile-enforced change across the seam, providers, and the tool. Symbols and call hierarchy are
 * not operations here; they need different schemas.
 */
export type LspOperation = 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'

/** A zero-based UTF-16 cursor coordinate, matching the LSP wire convention. */
export interface LspPosition {
  /** Zero-based line. */
  readonly line: number
  /** Zero-based UTF-16 code-unit offset within the line. */
  readonly character: number
}

/** A zero-based UTF-16 half-open range `[start, end)`. */
export interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}

/**
 * A caller's normalized query. Every field is required: `workspaceRoot` is caller-supplied,
 * `languageId` comes from the provider registration (not here), and consumers own timeouts and
 * result limits — so no field needs implementation defaulting and there is no `resolve()` step.
 */
export interface LspQueryRequest {
  /** Which semantic query to run. */
  readonly operation: LspOperation
  /** The source file to query (relative to `workspaceRoot` or absolute; the provider canonicalizes). */
  readonly filePath: string
  /** The zero-based UTF-16 cursor position to query at. */
  readonly position: LspPosition
  /** The workspace root the provider resolves against and indexes; required, never defaulted. */
  readonly workspaceRoot: string
}

/**
 * A request as a provider receives it: the caller's {@link LspQueryRequest} plus the `languageId`
 * the seam derived from the provider's extension mapping. The language id only synchronizes the
 * transient document; it does not participate in selection.
 */
export interface LspProviderQuery extends LspQueryRequest {
  /** The LSP language id for `filePath`, from this provider's extension mapping. */
  readonly languageId: string
}

/** One resolved location: a document URI and the range within it. */
export interface LspLocation {
  /** The target document URI (`file:` or otherwise), verbatim from the server. */
  readonly uri: string
  /** The range within the target document. */
  readonly range: LspRange
}

/** Normalized hover content, or `null` for no hover at the position. */
export interface LspHover {
  /** The normalized hover text (markdown or plaintext, provider-joined). */
  readonly contents: string
  /** The range the hover applies to, when the server supplied one. */
  readonly range?: LspRange
}

/**
 * The closed result union. Navigation operations (`goToDefinition`, `findReferences`,
 * `goToImplementation`) normalize to `locations`; `hover` normalizes to content or `null`.
 * Consumers `switch` on `kind` to exhaustiveness so a new arm breaks compilation until handled.
 *
 * The `locations` variant carries `resolvedWorkspaceUri`: the provider's canonical `file:` URI for
 * the request's workspace root. A caller that relativizes location URIs MUST use this, not parse the
 * request's possibly symlinked process path with host-platform rules; the execution platform may
 * differ from the caller's.
 */
export type LspQueryResult =
  | { readonly kind: 'locations'; readonly locations: readonly LspLocation[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'hover'; readonly hover: LspHover | null }

/**
 * A caller's write-path format request. The caller supplies authoritative in-memory text verbatim —
 * the seam never re-reads the file — plus the workspace the transient document lives in. Positions
 * are the LSP cable's zero-based UTF-16; line numbering is not used here, the raw text flows
 * verbatim.
 */
export interface LspFormatRequest {
  /** The source file to format (the caller owns read/write of its text). */
  readonly filePath: string
  /** The workspace the provider resolves against and indexes. */
  readonly workspaceRoot: string
  /** The authoritative current text, matched byte-for-byte to what the caller is writing. */
  readonly text: string
  /** Optional formatting preferences forwarded to `textDocument/formatting` (default tabSize 2, insertSpaces true). */
  readonly formattingOptions?: { readonly tabSize: number; readonly insertSpaces: boolean }
}

/**
 * The format result: `formattedText` is `null` when the server has no formatting provider (or
 * returned no edits), so a write path can state "no formatting happened" without an error.
 */
export type LspFormatResult = { readonly formattedText: string | null }

/** One normalized diagnostic, derived from the server's `Diagnostic` (range always present). */
export interface LspDiagnostic {
  /** The range the diagnostic applies to. */
  readonly range: LspRange
  /** LSP severity: `1` Error, `2` Warning, `3` Information, `4` Hint. */
  readonly severity?: 1 | 2 | 3 | 4
  /** The reporting source (e.g. `typescript`), when the server supplied one. */
  readonly source?: string
  /** The diagnostic message. */
  readonly message: string
}

/**
 * A caller's write-path diagnostics request. The caller asserts this content/version; diagnostics
 * must be requested against a document opened with exactly this text+version.
 */
export interface LspDiagnosticsRequest {
  /** The source file to collect diagnostics for (the caller owns its text). */
  readonly filePath: string
  /** The workspace the provider resolves against and indexes. */
  readonly workspaceRoot: string
  /** The authoritative current text, matched byte-for-byte to what the caller is writing. */
  readonly text: string
  /** The caller's document version; only a publish carrying this version is accepted. */
  readonly version: number
}

/** The diagnostics result, normalized and sorted by range (start line, start char, end line, end char). */
export interface LspDiagnosticsResult {
  /** Sorted diagnostics published for the target document; empty when the server never publishes. */
  readonly diagnostics: readonly LspDiagnostic[]
}

/**
 * A language-server backend registered on `ctx.lsp`. Each provider owns a stable {@link
 * LspProviderId} and an extension-to-language-id map (lowercase, leading-dot keys).
 * `findReferences` always includes declarations — the provider enforces this internally; callers
 * get no flag. The write-path methods receive caller-supplied in-memory content and never read the
 * file; they resolve and contain the path themselves.
 */
export interface LspProvider {
  /** Stable provider identity, reserved atomically with the extension mappings. */
  readonly id: LspProviderId
  /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
  readonly extensionToLanguage: Readonly<Record<string, string>>
  /**
   * Run one query. The seam has already selected this provider and derived `languageId`.
   * @param request - the resolved provider query (caller request + derived language id).
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns the normalized, closed-union result.
   */
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>
  /**
   * Format a document's text. The caller supplies authoritative in-memory content; the provider
   * opens a transient document with it, calls `textDocument/formatting`, and applies the returned
   * edits to the caller's text.
   * @param request - the write-path format request.
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns the formatted text, or `null` when the server has no formatting provider or returned no edits.
   */
  format(request: LspFormatRequest, signal?: AbortSignal): Promise<LspFormatResult>
  /**
   * Collect diagnostics for a document. The caller asserts the content/version; the provider opens a
   * transient document with exactly that text+version and returns the diagnostics the server
   * publishes for it (filtered to the uri and version, sorted). A server that never publishes yields
   * an empty result after the provider's bounded wait.
   * @param request - the write-path diagnostics request.
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns the normalized diagnostics (empty when none are published).
   */
  collectDiagnostics(request: LspDiagnosticsRequest, signal?: AbortSignal): Promise<LspDiagnosticsResult>
}

/**
 * The LSP capability seam (`ctx.lsp`). Owns provider registration/selection and normalized query
 * execution; exposes exactly the four operations and the two write-path operations, and no protocol
 * escape hatch.
 */
export interface LspService {
  /**
   * Register a provider, atomically reserving its id and every normalized extension. Any conflict
   * or invalid input publishes nothing and throws `LspError`; the returned disposer releases all
   * reservations. Disposed with the calling fiber.
   * @param provider - the backend to register.
   * @returns a synchronous disposer releasing the id and all extension reservations.
   */
  registerProvider(provider: LspProvider): () => void
  /**
   * Select a provider by the file's extension and run one query. Selection is per-query and
   * order-independent; no match throws `LspError` `LSP_UNAVAILABLE`.
   * @param request - the normalized query.
   * @param signal - optional cancellation forwarded to the selected provider.
   * @returns the normalized, closed-union result.
   */
  query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>
  /**
   * Select a provider by the file's extension and run one format. Selection mirrors `query`;
   * no match throws `LspError` `LSP_UNAVAILABLE`.
   * @param request - the write-path format request.
   * @param signal - optional cancellation forwarded to the selected provider.
   * @returns the formatted text, or `null` when the provider/server had nothing to format.
   */
  format(request: LspFormatRequest, signal?: AbortSignal): Promise<LspFormatResult>
  /**
   * Select a provider by the file's extension and collect diagnostics. Selection mirrors `query`;
   * no match throws `LspError` `LSP_UNAVAILABLE`.
   * @param request - the write-path diagnostics request.
   * @param signal - optional cancellation forwarded to the selected provider.
   * @returns the normalized diagnostics (empty when none were published).
   */
  collectDiagnostics(request: LspDiagnosticsRequest, signal?: AbortSignal): Promise<LspDiagnosticsResult>
}
