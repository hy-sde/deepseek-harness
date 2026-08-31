/**
 * One language-server instance: a connection plus the initialize handshake, the serialized abortable
 * query queue, the transient `didOpen`→request→`didClose` lifecycle, and bounded teardown. One
 * instance owns one `(provider id, canonical workspace)` process. Queries serialize through a single
 * queue so a cancellation that fails to stop the server can terminate it without killing unrelated
 * work; distinct instances run in parallel.
 * @module @deepseek-ai/dsh-lsp-stdio/instance
 */

import { LspError } from '@deepseek-ai/dsh-lsp'
import type {
  LspDiagnosticsRequest,
  LspDiagnosticsResult,
  LspFormatRequest,
  LspFormatResult,
  LspOperation,
  LspProviderQuery,
  LspQueryResult,
} from '@deepseek-ai/dsh-lsp'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { abortable, abortError } from './abort.ts'
import { LspConnection } from './connection.ts'
import type { ConnectionSpawner, ConnectionSpec, ConnectionWriter } from './connection.ts'
import type { HostSource } from './host.ts'
import type { WireInitializeResult, WireServerCapabilities, WireTextEdit } from './protocol.ts'
import {
  applyEditsToText,
  negotiatePositionEncoding,
  normalizeCodeActions,
  normalizeDiagnostics,
  normalizeDocumentSymbols,
  normalizeFormattingEdits,
  normalizeHover,
  normalizeLocations,
  normalizeRename,
  requestMethod,
  supportsFormatting,
  supportsOperation,
  supportsTransientOpen,
} from './translate.ts'

/** Everything an instance needs beyond the connection spec. */
export interface InstanceSpec extends ConnectionSpec {
  /** Canonical workspace file URI supplied by the filesystem provider. */
  readonly workspaceUri: string
  /** Static `initialize` options forwarded to the server. */
  readonly initializationOptions: unknown
  /** Graceful `shutdown`/`exit` budget before escalation (ms). */
  readonly shutdownTimeoutMs: number
  /** Bounded wait for a `textDocument/publishDiagnostics` notification during collection (ms). */
  readonly diagnosticsTimeoutMs: number
  /** Project-aware server: read-path diagnostics get the longer wait and timeouts surface as errors. */
  readonly projectAware: boolean
  /** Read-path publish-diagnostics wait budget for project-aware servers (ms). */
  readonly projectDiagnosticsWaitMs: number
}

/**
 * A single initialized server process. Not exported as a provider — the provider single-flights and
 * pools these. `query()` serializes; `dispose()` rejects queued work and tears the process down.
 */
export class LspInstance {
  private readonly connection: LspConnection
  private capabilities: WireServerCapabilities | undefined
  /** The serialization tail: each query awaits the prior one, so lifecycles never interleave. */
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  /** The one teardown transaction shared by abort, failure, and explicit disposal. */
  private teardownPromise: Promise<void> | undefined
  /** Set once the process closes, so the pool can synchronously skip a dead instance. */
  private processClosed = false
  /** Populated once `initialize` succeeds; a failed handshake rejects every query. */
  private readonly ready: Promise<void>

  /**
   * @param spec - the launch, initialize, and teardown parameters.
   * @param spawner - the subprocess seam's spawn function.
   * @param writer - optional connection writer used by transport conformance tests.
   */
  constructor(private readonly spec: InstanceSpec, spawner: ConnectionSpawner, writer?: ConnectionWriter) {
    this.connection = new LspConnection(spec, spawner, (method, params) => this.answerServerRequest(method, params), writer)
    this.ready = this.initialize()
    // A handshake rejection must not surface as an unhandled rejection before the first query awaits
    // it; queries attach the real handler.
    this.ready.catch(() => {})
    void this.connection.closed.then(() => { this.processClosed = true })
  }

  /** Synchronous liveness check: true once the process has closed or the instance was disposed. */
  get dead(): boolean {
    return this.processClosed || this.disposed || this.connection.failed
  }

  /**
   * Test whether a caught query error came from this instance's transport.
   * @param error - error caught by the provider.
   * @returns `true` only for the connection's retained fatal transport cause.
   */
  isTransportFailure(error: unknown): boolean {
    return this.connection.failedWith(error)
  }

  /**
   * Run one query through the serialized queue.
   * @param request - the resolved provider query.
   * @param source - the pre-validated, already-read host source (the provider reads before spawning).
   * @param signal - optional cancellation for this query's full lifecycle.
   * @returns the normalized result.
   */
  query(request: LspProviderQuery, source: HostSource, signal?: AbortSignal): Promise<LspQueryResult> {
    // Serialize behind prior work, but observe abort DURING the queue wait too: if an earlier query
    // hangs (e.g. a signal-less service caller), a later tool's timeout must still be able to give up
    // rather than block on the shared tail forever.
    const run = abortable(this.queue, signal)
      .then(() => this.runQuery(request, source, signal))
      .catch(async (error: unknown) => {
        if (this.isTransportFailure(error)) await this.startTeardown()
        throw error
      })
    // Keep the tail alive regardless of this query's outcome so the next caller still serializes. The
    // tail follows the ACTUAL prior work (this.queue), not the abortable view, so a caller giving up
    // on the wait does not deserialize the queue.
    this.queue = this.queue.then(() => run).then(() => undefined, () => undefined)
    return run
  }

  /**
   * Format a document through `textDocument/formatting`, applying the returned edits to the caller's
   * authoritative in-memory text.
   * @param request - the caller's write-path format request.
   * @param uri - the canonical file URI resolved by the provider.
   * @param languageId - the language id derived from the provider's extension mapping.
   * @param signal - optional cancellation for this lifecycle.
   * @returns the formatted text, or `null` when the server cannot/does not format.
   */
  format(request: LspFormatRequest, uri: string, languageId: string, signal?: AbortSignal): Promise<LspFormatResult> {
    const run = abortable(this.queue, signal)
      .then(() => this.runFormat(request, uri, languageId, signal))
      .catch(async (error: unknown) => {
        if (this.isTransportFailure(error)) await this.startTeardown()
        throw error
      })
    this.queue = this.queue.then(() => run).then(() => undefined, () => undefined)
    return run
  }

  /**
   * Collect this document's diagnostics through a transient open and a version-fresh publish wait.
   * @param request - the caller's write-path diagnostics request.
   * @param uri - the canonical file URI resolved by the provider.
   * @param languageId - the language id derived from the provider's extension mapping.
   * @param signal - optional cancellation for this lifecycle.
   * @returns the normalized diagnostics (empty on no publish or version mismatch).
   */
  collectDiagnostics(
    request: LspDiagnosticsRequest,
    uri: string,
    languageId: string,
    signal?: AbortSignal,
  ): Promise<LspDiagnosticsResult> {
    const run = abortable(this.queue, signal)
      .then(() => this.runCollectDiagnostics(request, uri, languageId, signal))
      .catch(async (error: unknown) => {
        if (this.isTransportFailure(error)) await this.startTeardown()
        throw error
      })
    this.queue = this.queue.then(() => run).then(() => undefined, () => undefined)
    return run
  }

  /**
   * Collect this document's diagnostics — read-path variant that uses the provider-read source
   * (like `query`) instead of caller-owned text: the source is already read before spawning, so this
   * opens it at version 1 and waits for a matching publish, exactly like `collectDiagnostics`.
   * @param request - the provider query (`operation` must be `'diagnostics'`; `position`/`newName` are ignored).
   * @param source - the pre-validated, already-read host source.
   * @param signal - optional cancellation for this lifecycle.
   * @returns the normalized diagnostics (empty on no publish).
   */
  diagnostics(request: LspProviderQuery, source: HostSource, signal?: AbortSignal): Promise<LspQueryResult> {
    const run = abortable(this.queue, signal)
      .then(() => this.runDiagnostics(request, source, signal))
      .catch(async (error: unknown) => {
        if (this.isTransportFailure(error)) await this.startTeardown()
        throw error
      })
    this.queue = this.queue.then(() => run).then(() => undefined, () => undefined)
    return run
  }

  private async runDiagnostics(request: LspProviderQuery, source: HostSource, signal?: AbortSignal): Promise<LspQueryResult> {
    const capabilities = await this.readyCapabilities(signal)
    if (!supportsTransientOpen(capabilities.textDocumentSync)) {
      throw new LspError('server does not support the transient textDocument/didOpen this host requires', 'LSP_UNSUPPORTED_OPERATION')
    }
    const uri = source.fileUrl
    const version = 1
    // Project-aware servers (tsserver, Roslyn, …) compute first-pass diagnostics on demand and
    // routinely overrun the base collection budget; an explicit read-path query can afford a longer
    // bounded wait, so give project-aware servers their own budget (still capped by tool timeout).
    const waitBudgetMs = this.spec.projectAware ? this.spec.projectDiagnosticsWaitMs : this.spec.diagnosticsTimeoutMs
    const deadlineSignal = deadline(signal, waitBudgetMs, 'LSP_DIAGNOSTICS_TIMEOUT')
    let opened = false
    let removeListener: (() => void) | undefined
    try {
      /* v8 ignore next -- guards an abort landing between the ready wait and didOpen; not reproducible. */
      if (signal?.aborted) throw abortError(signal)
      const received = Promise.withResolvers<unknown>()
      removeListener = this.connection.onNotification('textDocument/publishDiagnostics', (params) => {
        const record = params as Record<string, unknown> | null
        if (record === null || typeof record !== 'object') return
        if (record.uri !== uri) return
        if (record.version !== undefined && record.version !== version) return
        received.resolve(params)
      })
      try {
        await abortable(this.connection.notify('textDocument/didOpen', {
          textDocument: { uri, languageId: request.languageId, version, text: source.text },
        }), signal)
      } catch (error) {
        await this.startTeardown()
        throw error
      }
      opened = true
      const payload = await abortable(received.promise, deadlineSignal.signal).catch((error: unknown) => {
        if (timeoutOf(deadlineSignal.signal) !== undefined) return undefined
        throw error
      })
      if (payload === undefined && this.spec.projectAware) {
        // A publish-wait timeout on a project-aware server leaves the file's state unknown — the
        // server advertised diagnostics but produced none within an extended budget. Never let it
        // collapse into a clean empty report the caller renders as "OK".
        throw new LspError(`server did not publish diagnostics for ${uri} within ${waitBudgetMs}ms`, 'LSP_DIAGNOSTICS_TIMEOUT')
      }
      return {
        kind: 'diagnostics' as const,
        diagnostics: normalizeDiagnostics(payload, uri, version),
        resolvedWorkspaceUri: this.spec.workspaceUri,
      }
    } finally {
      if (removeListener !== undefined) removeListener()
      deadlineSignal[Symbol.dispose]()
      await this.closeDocument(uri, opened)
    }
  }

  private async initialize(): Promise<void> {
    const initializeResult = await this.connection.request('initialize', {
      // A subprocess provider may run in another PID namespace or machine;
      // the host PID would let the server monitor an unrelated process.
      processId: null,
      rootUri: this.spec.workspaceUri,
      workspaceFolders: [{ uri: this.spec.workspaceUri, name: 'workspace' }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: this.spec.initializationOptions,
    }) as WireInitializeResult
    const capabilities = initializeResult.capabilities
    // An omitted encoding defaults to utf-16; any other value is a protocol error we reject here.
    negotiatePositionEncoding(capabilities.positionEncoding)
    this.capabilities = capabilities
    await this.connection.notify('initialized', {})
  }

  private async runQuery(request: LspProviderQuery, source: HostSource, signal?: AbortSignal): Promise<LspQueryResult> {
    if (this.disposed) throw new LspError('LSP instance was disposed', 'LSP_DISPOSED')
    /* v8 ignore next -- the abortable queue wait rejects a pre-aborted signal before runQuery; this is a belt-and-suspenders guard. */
    if (signal?.aborted) throw abortError(signal)
    // Observe abort during the handshake wait, and never pool a poisoned instance: if the wait ends
    // in failure — an abort on a still-pending handshake, OR `initialize` rejecting (utf-8
    // negotiation, malformed result) without the process exiting — tear the instance down so a
    // permanently-rejecting/pending `ready` can't make every later query for this workspace fail.
    try {
      await abortable(this.ready, signal)
    } catch (error) {
      if (!this.dead) {
        await this.startTeardown()
      }
      throw error
    }
    const capabilities = this.capabilities
    /* v8 ignore next -- `ready` resolves only after capabilities are set, else it rejects above; defensive. */
    if (capabilities === undefined) throw new Error('LSP instance is not initialized')
    if (!supportsOperation(capabilities, request.operation)) {
      throw new LspError(`server does not support ${request.operation}`, 'LSP_UNSUPPORTED_OPERATION')
    }
    if (!supportsTransientOpen(capabilities.textDocumentSync)) {
      throw new LspError('server does not support the transient textDocument/didOpen this host requires', 'LSP_UNSUPPORTED_OPERATION')
    }

    const uri = source.fileUrl
    let opened = false
    try {
      /* v8 ignore next -- guards an abort landing between the ready wait and didOpen; not deterministically reproducible. */
      if (signal?.aborted) throw abortError(signal)
      try {
        await abortable(this.connection.notify('textDocument/didOpen', {
          textDocument: { uri, languageId: request.languageId, version: 1, text: source.text },
        }), signal)
      } catch (error) {
        // A canceled backpressured write or failed stdin leaves the protocol stream unusable before
        // `opened` can arm the didClose cleanup. Teardown here makes the pool evict the instance.
        await this.startTeardown()
        throw error
      }
      opened = true
      const payload = await this.sendRequest(request, uri, signal)
      return this.normalize(request.operation, payload)
    } finally {
      // A disposed or closed instance (e.g. an aborted request whose server ignored
      // `$/cancelRequest`) is already tearing down; sending didClose would race that teardown and let
      // the next queued query's document lifecycle overlap the still-active request.
      if (opened && !this.dead) {
        try {
          await this.connection.notify('textDocument/didClose', { textDocument: { uri } })
        } catch {
          // A close-write failure does not replace the settled result/error, but the instance can no
          // longer be trusted: invalidate it and await bounded process termination.
          try {
            await this.startTeardown()
          } catch {
            /* v8 ignore next -- teardown owns all expected process races; this only preserves the
               already-settled query outcome if an unexpected cleanup primitive itself rejects. */
          }
        }
      }
    }
  }

  private async runFormat(request: LspFormatRequest, uri: string, languageId: string, signal?: AbortSignal): Promise<LspFormatResult> {
    const capabilities = await this.readyCapabilities(signal)
    if (!supportsTransientOpen(capabilities.textDocumentSync)) {
      // Like `query`, a server without transient open cannot serve the write path at all — the
      // required didOpen is impossible, so this is a hard capability failure, not a graceful null.
      throw new LspError('server does not support the transient textDocument/didOpen this host requires', 'LSP_UNSUPPORTED_OPERATION')
    }
    // A server without documentFormattingProvider formats nothing: degrade to `null` so a write path
    // keeps the caller's text unchanged instead of failing the format-on-write.
    if (!supportsFormatting(capabilities)) return { formattedText: null }
    const options = request.formattingOptions === undefined
      ? { tabSize: 2, insertSpaces: true }
      : { tabSize: request.formattingOptions.tabSize, insertSpaces: request.formattingOptions.insertSpaces }
    let opened = false
    try {
      /* v8 ignore next -- guards an abort landing between the ready wait and didOpen; not deterministically reproducible. */
      if (signal?.aborted) throw abortError(signal)
      try {
        await abortable(this.connection.notify('textDocument/didOpen', {
          textDocument: { uri, languageId, version: 1, text: request.text },
        }), signal)
      } catch (error) {
        await this.startTeardown()
        throw error
      }
      opened = true
      const edits = await this.requestFormatting(uri, options, signal)
      // A formatting provider that returned no edits formats nothing; the write path keeps its text.
      if (edits.length === 0) return { formattedText: null }
      return { formattedText: applyEditsToText(request.text, edits) }
    } finally {
      await this.closeDocument(uri, opened)
    }
  }

  private async runCollectDiagnostics(
    request: LspDiagnosticsRequest,
    uri: string,
    languageId: string,
    signal?: AbortSignal,
  ): Promise<LspDiagnosticsResult> {
    const capabilities = await this.readyCapabilities(signal)
    if (!supportsTransientOpen(capabilities.textDocumentSync)) {
      throw new LspError('server does not support the transient textDocument/didOpen this host requires', 'LSP_UNSUPPORTED_OPERATION')
    }
    // Arm the per-uri collector BEFORE didOpen so a publish racing the client's open processing is
    // caught (version freshness — not arrival order — is the correctness property). The deadline
    // fuses caller cancellation with the collection budget; a server that never publishes (no
    // diagnostic capability) times out into an empty result instead of an error.
    const deadlineSignal = deadline(signal, this.spec.diagnosticsTimeoutMs, 'LSP_DIAGNOSTICS_TIMEOUT')
    let opened = false
    let removeListener: (() => void) | undefined
    try {
      /* v8 ignore next -- guards an abort landing between the ready wait and didOpen; not reproducible. */
      if (signal?.aborted) throw abortError(signal)
      const received = Promise.withResolvers<unknown>()
      removeListener = this.connection.onNotification('textDocument/publishDiagnostics', (params) => {
        const record = params as Record<string, unknown> | null
        if (record === null || typeof record !== 'object') return
        if (record.uri !== uri) return
        // Version freshness: only a publish carrying no version (legacy servers) or exactly the
        // opened version matches; a mismatch means a stale snapshot for some other lifecycle.
        if (record.version !== undefined && record.version !== request.version) return
        received.resolve(params)
      })
      try {
        await abortable(this.connection.notify('textDocument/didOpen', {
          textDocument: { uri, languageId, version: request.version, text: request.text },
        }), signal)
      } catch (error) {
        await this.startTeardown()
        throw error
      }
      opened = true
      const payload = await abortable(received.promise, deadlineSignal.signal).catch((error: unknown) => {
        // The bounded publish wait elapsed without a matching notification: report no diagnostics.
        // A caller cancellation is still an error, classified (like a query) by its abort reason.
        if (timeoutOf(deadlineSignal.signal) !== undefined) return undefined
        throw error
      })
      return { diagnostics: normalizeDiagnostics(payload, uri, request.version) }
    } finally {
      /* v8 ignore next -- `removeListener` is always assigned before any throw can reach this
         finally; the undefined guard is defensive against future reordering. */
      if (removeListener !== undefined) removeListener()
      deadlineSignal[Symbol.dispose]()
      await this.closeDocument(uri, opened)
    }
  }

  /** Await the handshake and return the capabilities, tearing down a poisoned instance on failure. */
  private async readyCapabilities(signal?: AbortSignal): Promise<WireServerCapabilities> {
    if (this.disposed) throw new LspError('LSP instance was disposed', 'LSP_DISPOSED')
    /* v8 ignore next -- the abortable queue wait rejects a pre-aborted signal before these run methods; belt-and-suspenders. */
    if (signal?.aborted) throw abortError(signal)
    // Observe abort during the handshake wait, and never pool a poisoned instance (same policy as
    // runQuery): a failed `ready` must not make every later write-path call for this workspace hang.
    try {
      await abortable(this.ready, signal)
    } catch (error) {
      if (!this.dead) {
        await this.startTeardown()
      }
      throw error
    }
    /* v8 ignore next -- `ready` resolves only after capabilities are set; defensive. */
    if (this.capabilities === undefined) throw new Error('LSP instance is not initialized')
    return this.capabilities
  }

  /** Send `textDocument/formatting` with the resolved options and normalize its `TextEdit[]` result. */
  private async requestFormatting(
    uri: string,
    options: { tabSize: number; insertSpaces: boolean },
    signal?: AbortSignal,
  ): Promise<WireTextEdit[]> {
    const params = {
      textDocument: { uri },
      options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
    }
    const requestId = this.connection.peekNextId()
    const send = this.connection.request('textDocument/formatting', params)
    const payload = signal === undefined ? await send : await this.raceAbort(send, requestId, signal)
    return normalizeFormattingEdits(payload)
  }

  /** Await a transient document's didClose; a close-write failure invalidates the instance. */
  private async closeDocument(uri: string, opened: boolean): Promise<void> {
    // A disposed or closed instance (e.g. a request whose server ignored `$/cancelRequest`) is
    // already tearing down; sending didClose would race that teardown and let the next queued
    // operation's document lifecycle overlap the still-active one.
    if (!opened || this.dead) return
    try {
      await this.connection.notify('textDocument/didClose', { textDocument: { uri } })
    } catch {
      // A close-write failure does not replace the settled result, but the instance can no longer be
      // trusted: invalidate it and await bounded process termination.
      try {
        await this.startTeardown()
      } catch {
        /* v8 ignore next -- teardown owns all expected process races; this only preserves the
           already-settled outcome if an unexpected cleanup primitive itself rejects. */
      }
    }
  }

  private async sendRequest(
    request: LspProviderQuery,
    uri: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const position = request.position
    const params: Record<string, unknown> = {
      textDocument: { uri },
      position: { line: position.line, character: position.character },
      // findReferences always includes declarations: the caller gets no flag and impact analysis
      // never omits the defining site.
      ...(request.operation === 'findReferences' ? { context: { includeDeclaration: true } } : {}),
      // rename carries the requested new name on the wire.
      ...(request.operation === 'rename' && request.newName !== undefined ? { newName: request.newName } : {}),
      // codeAction needs a range + context: the seam passes a zero-width range at the cursor and an
      // empty trigger context (callers collect their own diagnostics for context if they need it).
      ...(request.operation === 'codeActions'
        ? {
          range: {
            start: { line: position.line, character: position.character },
            end: { line: position.line, character: position.character },
          },
          context: { diagnostics: [], triggerKind: 1 },
        }
        : {}),
    }
    const requestId = this.connection.peekNextId()
    const send = this.connection.request(requestMethod(request.operation), params)
    if (signal === undefined) return send
    return this.raceAbort(send, requestId, signal)
  }

  /**
   * Race a pending request against abort. On abort, send `$/cancelRequest` and give the server a
   * bounded grace to acknowledge; if it does not settle in time, invalidate and tear down the
   * instance so the still-active request cannot overlap the next queued query's document lifecycle.
   */
  private async raceAbort(send: Promise<unknown>, requestId: number, signal: AbortSignal): Promise<unknown> {
    try {
      return await abortable(send, signal)
    } catch (error) {
      if (!signal.aborted) throw error
      this.connection.cancel(requestId)
      // Wait, bounded, for the server to honor the cancellation. If it does not, the request is still
      // running: terminate the instance (disposal awaits process close) so nothing outlives the query.
      const grace = deadline(undefined, this.spec.killGraceMs, 'LSP_CANCEL_GRACE')
      try {
        // `settled` is true if the request finished (either outcome) before the grace elapsed.
        const settled = await Promise.race([
          send.then(markSettled, markSettled),
          new Promise<boolean>((resolve) => {
            /* v8 ignore next -- the cancel-grace deadline signal is freshly armed and not yet aborted here; defensive. */
            if (grace.signal.aborted) { resolve(false); return }
            grace.signal.addEventListener('abort', () => { resolve(false) }, { once: true })
          }),
        ])
        if (!settled) await this.startTeardown()
      } finally {
        grace[Symbol.dispose]()
      }
      throw error
    }
  }

  private normalize(operation: LspOperation, payload: unknown): LspQueryResult {
    if (operation === 'hover') {
      return { kind: 'hover', hover: normalizeHover(payload) }
    }
    if (operation === 'documentSymbols') {
      return {
        kind: 'documentSymbols',
        symbols: normalizeDocumentSymbols(payload),
        resolvedWorkspaceUri: this.spec.workspaceUri,
      }
    }
    if (operation === 'codeActions') {
      return {
        kind: 'codeActions',
        actions: normalizeCodeActions(payload),
        resolvedWorkspaceUri: this.spec.workspaceUri,
      }
    }
    if (operation === 'rename') {
      return {
        kind: 'rename',
        files: normalizeRename(payload),
        resolvedWorkspaceUri: this.spec.workspaceUri,
      }
    }
    // Navigation operations normalize to locations. The filesystem provider owns URI syntax for
    // the execution platform, which may differ from the harness host. Preserve that coordinate
    // through rendering instead of reparsing `spec.cwd` there.
    return { kind: 'locations', locations: normalizeLocations(payload), resolvedWorkspaceUri: this.spec.workspaceUri }
  }

  private answerServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'workspace/configuration') {
      // Answer every requested item with the one static configuration value.
      const record = params as { items?: unknown[] } | null
      /* v8 ignore next -- a configuration request always carries an items array; the empty fallback is defensive. */
      const items = Array.isArray(record?.items) ? record.items : []
      return Promise.resolve(items.map(() => this.spec.configuration))
    }
    if (LIFECYCLE_NOOP_METHODS.has(method)) {
      // Accept lifecycle bookkeeping requests with an empty result; we register nothing dynamic.
      return Promise.resolve(null)
    }
    if (method === 'workspace/applyEdit') {
      // This host never applies edits or runs commands.
      return Promise.reject(new Error('workspace/applyEdit is not permitted by this host'))
    }
    return Promise.reject(new Error(`unsupported server request: ${method}`))
  }

  /**
   * Reject queued work, attempt graceful `shutdown`/`exit`, then escalate SIGTERM→SIGKILL, awaiting
   * process close so nothing outlives disposal.
   */
  async dispose(): Promise<void> {
    await this.startTeardown()
  }

  /** Publish disposal once and make every caller await the same quiescence boundary. */
  private startTeardown(): Promise<void> {
    this.disposed = true
    this.teardownPromise ??= this.tearDown()
    return this.teardownPromise
  }

  private async tearDown(): Promise<void> {
    const shutdownDeadline = deadline(undefined, this.spec.shutdownTimeoutMs, 'LSP_SHUTDOWN')
    try {
      await this.gracefulShutdown(shutdownDeadline.signal)
    } catch {
      // Graceful shutdown failed or timed out; process-tree cleanup below remains authoritative.
    } finally {
      shutdownDeadline[Symbol.dispose]()
    }
    await this.forceTerminate()
  }

  /** Best-effort LSP `shutdown`/`exit`, including process close, bounded by `signal`. */
  private async gracefulShutdown(signal: AbortSignal): Promise<void> {
    await abortable(this.connection.request('shutdown', null), signal)
    await this.connection.notify('exit', null)
    await abortable(this.connection.closed, signal)
  }

  /**
   * Terminate the tree (the seam escalates SIGTERM→`killGraceMs`→SIGKILL),
   * then await leader and helper exit. The awaits are unbounded on purpose:
   * the seam's escalation already committed to SIGKILL, so quiescence — not
   * another timer — is the postcondition disposal owes its callers.
   */
  private async forceTerminate(): Promise<void> {
    this.connection.terminate()
    await Promise.all([
      this.connection.closed,
      this.connection.waitForProcessTreeExit(),
    ])
  }
}

/** Server→client request methods this host acknowledges with an empty result (no dynamic registration). */
const LIFECYCLE_NOOP_METHODS = new Set([
  'window/workDoneProgress/create',
  'client/registerCapability',
  'client/unregisterCapability',
])

/** Mark a settled request in the cancel-grace race (either outcome means the request finished). */
function markSettled(): boolean {
  return true
}

/**
 * The client capabilities advertised at `initialize`: UTF-16 positions, workspace folders and
 * configuration, markdown/plaintext hover, and link support for definition/implementation. No
 * dynamic registration; the server's returned capabilities are authoritative.
 */
const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: { workspaceFolders: true, configuration: true },
  textDocument: {
    synchronization: { dynamicRegistration: false },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
  },
} as const
