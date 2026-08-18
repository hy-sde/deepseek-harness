# LSP navigation

English | [中文](lsp.zh.md)

The LSP seam — a [capability seam](../../.agents/notes/implemented/architecture/2026-07-15-lsp-capability-seam.md) exposing semantic code navigation on one `ctx.lsp` service, split across packages: Service Definition ([dsh-lsp](../../packages/lsp/lsp), `ctx.lsp` + the provider registry), a generic Service Provider ([dsh-lsp-stdio](../../packages/lsp/lsp-stdio), a configured stdio language-server host), and Consumer ([dsh-tool-lsp](../../packages/lsp/tool-lsp), the `lsp` tool schema). LSP is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A provider swap does not change how the model asks for navigation.

Source: [`packages/lsp/lsp/src/types.ts`](../../packages/lsp/lsp/src/types.ts)

## Operations and coordinates

The seam and model expose exactly nine file-scoped operations; the union is closed, so adding one is a compile-enforced change across the seam, providers, and the tool. `documentSymbols` and `codeActions`/`rename`/`diagnostics` produce their own result shapes; navigation operations normalize to locations. `rename` and `codeActions` are read-only previews — the seam never writes. Positions and ranges are zero-based UTF-16, matching the protocol; the model-facing tool owns the one-based cursor convention and converts on the way in and out.

```ts type-equiv
/**
 * The model-exposed operations the seam and tool share. A closed union: adding an operation is a
 * compile-enforced change across the seam, providers, and the tool. `documentSymbols`, `codeActions`,
 * and `rename` produce their own result shapes; navigation operations normalize to locations.
 */
type LspOperation =
  | 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover' | 'goToTypeDefinition'
  | 'documentSymbols' | 'codeActions' | 'rename' | 'diagnostics'
```

```ts type-equiv
/** A zero-based UTF-16 cursor coordinate, matching the LSP wire convention. */
interface LspPosition {
  /** Zero-based line. */
  readonly line: number
  /** Zero-based UTF-16 code-unit offset within the line. */
  readonly character: number
}
```

```ts type-equiv
/** A zero-based UTF-16 half-open range `[start, end)`. */
interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}
```

## Request

Every field is required: `workspaceRoot` is caller-supplied, `languageId` comes from the provider's registration (not the request), and consumers own timeouts and result limits — so no field needs implementation defaulting and there is no `resolve()` step. The provider receives the caller's request plus the derived `languageId`, which only synchronizes the transient document and never participates in selection.

```ts type-equiv
/**
 * A caller's normalized query. Every field is required: `workspaceRoot` is caller-supplied,
 * `languageId` comes from the provider registration (not here), and consumers own timeouts and
 * result limits — so no field needs implementation defaulting and there is no `resolve()` step.
 * `newName` is present only for `rename` (the requested symbol's new name); other operations leave
 * it undefined.
 */
interface LspQueryRequest {
  /** Which semantic query to run. */
  readonly operation: LspOperation
  /** The source file to query (relative to `workspaceRoot` or absolute; the provider canonicalizes). */
  readonly filePath: string
  /** The zero-based UTF-16 cursor position to query at; `documentSymbols` ignores it. */
  readonly position: LspPosition
  /** The workspace root the provider resolves against and indexes; required, never defaulted. */
  readonly workspaceRoot: string
  /** The new symbol name for `rename`; ignored by every other operation. */
  readonly newName?: string
}
```

```ts type-equiv
/**
 * A request as a provider receives it: the caller's {@link LspQueryRequest} plus the `languageId`
 * the seam derived from the provider's extension mapping. The language id only synchronizes the
 * transient document; it does not participate in selection.
 */
interface LspProviderQuery extends LspQueryRequest {
  /** The LSP language id for `filePath`, from this provider's extension mapping. */
  readonly languageId: string
}
```

## Result

A CLOSED discriminated union over six result shapes: navigation operations normalize to `locations`, `hover` to content or `null`, `documentSymbols` to a flattened symbol tree, `codeActions` to a list (with their linked diagnostics), `rename` to per-file edit previews, and `diagnostics` to the accumulated report. Consumers `switch` on `kind` to exhaustiveness so a new arm breaks compilation until handled. `findReferences` always includes declarations — the provider enforces this internally, so callers get no flag. The `locations` variant carries `resolvedWorkspaceUri`, the provider's canonical workspace `file:` URI. A caller relativizing location URIs uses that coordinate rather than applying host-platform path rules to the possibly-symlinked request root.

```ts type-equiv
/** One resolved location: a document URI and the range within it. */
interface LspLocation {
  /** The target document URI (`file:` or otherwise), verbatim from the server. */
  readonly uri: string
  /** The range within the target document. */
  readonly range: LspRange
}
```

```ts type-equiv
/** Normalized hover content, or `null` for no hover at the position. */
interface LspHover {
  /** The normalized hover text (markdown or plaintext, provider-joined). */
  readonly contents: string
  /** The range the hover applies to, when the server supplied one. */
  readonly range?: LspRange
}
```

```ts type-equiv
/**
 * The closed result union. Navigation operations (`goToDefinition`, `findReferences`,
 * `goToImplementation`, `goToTypeDefinition`) normalize to `locations`; `hover` normalizes to
 * content or `null`. `documentSymbols`, `codeActions`, and `rename` normalize to their own shapes;
 * `diagnostics` reuses the normalized diagnostic list. Consumers `switch` on `kind` to
 * exhaustiveness so a new arm breaks compilation until handled.
 *
 * The `locations` variant carries `resolvedWorkspaceUri`: the provider's canonical `file:` URI for
 * the request's workspace root. A caller that relativizes location URIs MUST use this, not parse the
 * request's possibly symlinked process path with host-platform rules; the execution platform may
 * differ from the caller's.
 */
type LspQueryResult =
  | { readonly kind: 'locations'; readonly locations: readonly LspLocation[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'hover'; readonly hover: LspHover | null }
  | { readonly kind: 'documentSymbols'; readonly symbols: readonly LspDocumentSymbol[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'codeActions'; readonly actions: readonly LspCodeAction[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'rename'; readonly files: readonly LspRenameFile[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'diagnostics'; readonly diagnostics: readonly LspDiagnostic[]; readonly resolvedWorkspaceUri: string }
```

```ts type-equiv
/**
 * One normalized document symbol, flattened from the server's nested `DocumentSymbol` tree so the
 * seam never serializes recursive shapes. Depth starts at `0` for top-level symbols; children follow
 * their parent at `depth + 1` in document order.
 */
interface LspDocumentSymbol {
  /** The symbol name. */
  readonly name: string
  /** LSP `SymbolKind` (e.g. `2` Function, `5` Class, `6` Method, `13` Variable). */
  readonly kind: number
  /** The symbol's full range (e.g. a function body). */
  readonly range: LspRange
  /** The range of the symbol's name/identifier. */
  readonly selectionRange: LspRange
  /** Nesting depth (`0` top-level); the rows are already in document order. */
  readonly depth: number
  /** Optional detail line (signature / type parameters), when the server supplied it. */
  readonly detail?: string
}
```

```ts type-equiv
/** One normalized code action (a quick fix / refactoring offered by the server). */
interface LspCodeAction {
  /** The action title, e.g. "Extract to function" or "Fix typo". */
  readonly title: string
  /** The LSP `CodeActionKind` (e.g. `quickfix`, `refactor.extract`). */
  readonly kind?: string
  /** Whether this action is marked preferred by the server. */
  readonly isPreferred?: boolean
  /** The diagnostics this action addresses (usually quick fixes), when the server supplied them. */
  readonly diagnostics: readonly LspDiagnostic[]
}
```

```ts type-equiv
/** A single text edit inside a rename result, on one document. */
interface LspRenameFile {
  /** The target document URI for `edits`. */
  readonly uri: string
  /** The replacement edits, sorted for ascending application (apply in descending order). */
  readonly edits: readonly {
    /** The range to replace. */
    readonly range: LspRange
    /** The replacement text. */
    readonly newText: string
  }[]
}
```

```ts type-equiv
/** One normalized diagnostic, derived from the server's `Diagnostic` (range always present). */
interface LspDiagnostic {
  /** The range the diagnostic applies to. */
  readonly range: LspRange
  /** LSP severity: `1` Error, `2` Warning, `3` Information, `4` Hint. */
  readonly severity?: 1 | 2 | 3 | 4
  /** The reporting source (e.g. `typescript`), when the server supplied one. */
  readonly source?: string
  /** The diagnostic message. */
  readonly message: string
}
```

## Provider and service

A provider owns a stable branded `id` and an exclusive lowercase leading-dot extension map. `registerProvider` reserves the id and every extension atomically — an invalid or conflicting registration publishes nothing — and its disposer releases all reservations. Selection is per query and order-independent; no match throws `LspError` `LSP_UNAVAILABLE`. The seam exposes no protocol types, process/document controls, or generic JSON-RPC escape hatch.

```ts type-equiv
/**
 * A language-server backend registered on `ctx.lsp`. Each provider owns a stable {@link
 * LspProviderId} and an extension-to-language-id map (lowercase, leading-dot keys).
 * `findReferences` always includes declarations — the provider enforces this internally; callers
 * get no flag. The write-path methods receive caller-supplied in-memory content and never read the
 * file; they resolve and contain the path themselves.
 */
interface LspProvider {
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
```

```ts type-equiv
/**
 * The LSP capability seam (`ctx.lsp`). Owns provider registration/selection and normalized query
 * execution; exposes exactly the four operations and the two write-path operations, and no protocol
 * escape hatch.
 */
interface LspService {
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
```

`LspProviderId` is the seam's branded id (`Branded<'LspProviderId'>` from [dsh-brand](../../packages/util/brand)); `LspError` extends `HarnessError` with stable codes such as `LSP_INVALID_PROVIDER`, `LSP_CONFLICT`, `LSP_UNAVAILABLE`, `LSP_DISPOSED`, `LSP_UNSUPPORTED_OPERATION`, and `LSP_MALFORMED_RESPONSE`, which callers route on instead of parsing `message`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxlsp--lspservice"></a>

### `ctx.lsp` — `LspService`

The LSP capability seam (`ctx.lsp`). Owns provider registration/selection and normalized query execution; exposes exactly the four operations and the two write-path operations, and no protocol escape hatch.

```ts cordis-catalog
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
```

Source: [`packages/lsp/lsp/src/types.ts:257`](../../packages/lsp/lsp/src/types.ts)
<!-- END GENERATED cordis-surface -->
