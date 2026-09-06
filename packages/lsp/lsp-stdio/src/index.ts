/**
 * Generic stdio language-server backend for `ctx.lsp`. One plugin instance configures a named table
 * of server commands and registers one isolated provider for each entry. Every provider lazily
 * single-flights one server process per canonical workspace target, serves transient-open queries
 * through it, and replaces a selected transport that fails before or during the next read-only
 * query. Providers read sources through `ctx.fs` and launch servers through
 * `ctx.subprocess`, so both local and remote implementations share one host.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is effect-scoped: disposal
 * unregisters from `ctx.lsp` and tears down every live server.
 * @module @deepseek-ai/dsh-lsp-stdio
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LspError, LspProviderId, finalExtension } from '@deepseek-ai/dsh-lsp'
import type {
  LspDiagnosticsRequest,
  LspDiagnosticsResult,
  LspFormatRequest,
  LspFormatResult,
  LspProvider,
  LspProviderQuery,
  LspQueryResult,
} from '@deepseek-ai/dsh-lsp'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { abortable, abortError } from './abort.ts'
import { canonicalizeWorkspace, readHostSource, resolveSourceUrl } from './host.ts'
import type { HostWorkspace } from './host.ts'
import { LspInstance } from './instance.ts'
import type { ConnectionSpawner } from './connection.ts'
import type { InstanceSpec } from './instance.ts'
import { selectTypeScriptServer } from './typescript.ts'
import type { TypeScriptNativeConfig } from './typescript.ts'

export { canonicalizeWorkspace, readHostSource, resolveSourceUrl } from './host.ts'
export { encodeMessage, MessageDecoder } from './framing.ts'
export {
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
export { LspInstance } from './instance.ts'
export { LspConnection } from './connection.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'lsp-stdio'

/** Services required by this plugin. */
export const inject = ['fs', 'lsp', 'subprocess']

const DEFAULT_MAX_MESSAGE_BYTES = 16_000_000
const DEFAULT_MAX_STDERR_BYTES = 1_000_000
const DEFAULT_MAX_DOCUMENT_BYTES = 4_000_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_KILL_GRACE_MS = 2_000
const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 4_000
const DEFAULT_PROJECT_DIAGNOSTICS_WAIT_MS = 10_000

/** One configured local language server and its host bounds. */
export interface LspLocalServerConfig {
  /** Executable to spawn (absolute, or resolved on PATH at load). */
  command: string
  /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
  extensionToLanguage: Record<string, string>
  /** Arguments passed to the executable (no shell). Default `[]`. */
  args?: string[]
  /** Extra env vars merged on top of the scrubbed ambient env. Default `{}`. */
  env?: Record<string, string>
  /** Static `initialize` options forwarded to the server. Default `null`. */
  initializationOptions?: unknown
  /** Static answer to every `workspace/configuration` item. Default `null`. */
  configuration?: unknown
  /** Largest single framed message accepted from the server (bytes). Default 16000000. */
  maxMessageBytes?: number
  /** Largest stderr tail retained for diagnostics (bytes). Default 1000000. */
  maxStderrBytes?: number
  /** Largest source file this host will open (bytes). Default 4000000. */
  maxDocumentBytes?: number
  /** Graceful `shutdown`/`exit` budget before escalation (ms). Default 5000. */
  shutdownTimeoutMs?: number
  /** Request-cancel and SIGTERM→SIGKILL grace (ms). Default 2000. */
  killGraceMs?: number
  /** Bounded wait for a `textDocument/publishDiagnostics` notification during collection (ms). Default 4000. */
  diagnosticsTimeoutMs?: number
  /** Project-aware servers (tsserver, Roslyn, …) compute first-pass diagnostics on demand and
   * routinely overrun {@link diagnosticsTimeoutMs}; an explicit read-path `diagnostics` query can
   * afford a longer bounded wait. When true, the read path uses {@link projectDiagnosticsWaitMs}
   * and a publish-wait timeout survives as an error instead of collapsing into a clean empty
   * result. The write path (edits/format) always keeps its degrade-to-empty contract. Default false. */
  projectAware?: boolean
  /** Read-path publish-diagnostics wait budget for {@link projectAware} servers (ms). Default 10000. */
  projectDiagnosticsWaitMs?: number
  /**
   * When set, this entry is a TypeScript wrapper server and selection inspects
   * each workspace's TypeScript install, keeping exactly one server per
   * workspace: a TypeScript 7+ install (no `lib/tsserver.js`) spawns the native
   * `tsc --lsp --stdio` (the workspace's own launcher, or the resolved native
   * command on PATH), and every other case keeps the configured command. The
   * single provider serves both, so two projects with different TypeScript
   * versions in one session each get the right server. Absent when unused;
   * selection is a no-op then. Detection reads the host filesystem path, so
   * this option only applies when the workspace path is host-visible.
   */
  typescriptNative?: TypeScriptNativeConfig
}

/** Plugin configuration: provider id → local language-server configuration. */
export interface Config {
  /** Non-empty table of stable provider ids to independent local server configurations. */
  servers: Record<string, LspLocalServerConfig>
}

/** One server config after schemastery fills every default. */
type ResolvedServerConfig = Required<Omit<LspLocalServerConfig, 'typescriptNative'>> & {
  /** Present only when the deployment opts into per-workspace native TypeScript selection. */
  typescriptNative?: Required<TypeScriptNativeConfig>
}
type WorkspaceKey = HostWorkspace['target']['targetKey']

const LspLocalServerConfig: z<LspLocalServerConfig> = z.object({
  command: z.string().required(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  extensionToLanguage: z.dict(String).required(),
  initializationOptions: z.any().default(null),
  configuration: z.any().default(null),
  maxMessageBytes: z.number().default(DEFAULT_MAX_MESSAGE_BYTES),
  maxStderrBytes: z.number().default(DEFAULT_MAX_STDERR_BYTES),
  maxDocumentBytes: z.number().default(DEFAULT_MAX_DOCUMENT_BYTES),
  shutdownTimeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  killGraceMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_KILL_GRACE_MS),
  diagnosticsTimeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_DIAGNOSTICS_TIMEOUT_MS),
  projectAware: z.boolean().default(false),
  projectDiagnosticsWaitMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_PROJECT_DIAGNOSTICS_WAIT_MS),
  typescriptNative: z.object({
    command: z.string().default('tsc'),
  }),
})

export const Config: z<Config> = z.object({
  servers: z.dict(LspLocalServerConfig).required(),
})

/** Propagate teardown failures only after every sibling has settled. */
function throwTeardownFailures(results: readonly PromiseSettledResult<void>[], message: string): void {
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}

/**
 * Register the configured stdio LSP providers. Resolves every executable at load (after credential
 * scrubbing) before publishing any provider; each process launches lazily on its first matching
 * query.
 * @param ctx - the plugin context carrying `fs`, `lsp`, and `subprocess`.
 * @param config - the resolved plugin configuration (schemastery has filled every default).
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const entries = Object.entries(config.servers)
  if (entries.length === 0) throw new Error('lsp-stdio: servers must contain at least one server')

  const setupAbort = new AbortController()
  const stopSetupCancellation = ctx.on('internal/plugin', (fiber) => {
    // An async plugin callback must observe its own disposal before Cordis can
    // run effect cleanup, because unload otherwise waits for this callback.
    if (fiber === ctx.fiber && fiber.uid === null) {
      setupAbort.abort(new Error('lsp-stdio setup disposed'))
    }
  })

  // Resolve every server-local setting before registration so a bad later command or bound cannot
  // publish an earlier provider. Registry-level mapping conflicts are rolled back below.
  const providers = await (async () => {
    const lookups = entries.map(async ([providerId, rawConfig]) => {
      if (providerId.trim() === '') throw new Error('lsp-stdio: server ids must be non-empty strings')
      const resolved = rawConfig as ResolvedServerConfig
      validateServerConfig(providerId, resolved)
      const executable = await ctx.subprocess.resolveExecutable(
        resolved.command,
        resolved.env,
        setupAbort.signal,
      )
      setupAbort.signal.throwIfAborted()
      // The native launcher may legitimately be absent (no TypeScript on this host);
      // selection then keeps the configured wrapper unless a workspace-local install
      // decides. An abort during this lookup still propagates via the check below.
      const nativeExecutable = resolved.typescriptNative === undefined
        ? null
        : await ctx.subprocess.resolveExecutable(resolved.typescriptNative.command, resolved.env, setupAbort.signal)
          .catch(() => null)
      setupAbort.signal.throwIfAborted()
      return new LocalLspProvider(
        providerId,
        ctx.fs,
        resolved,
        executable,
        nativeExecutable,
        spec => ctx.subprocess.spawn(spec),
      )
    })
    try {
      return await Promise.all(lookups)
    } catch (error: unknown) {
      setupAbort.abort(error)
      await Promise.allSettled(lookups)
      throw error
    } finally {
      stopSetupCancellation()
    }
  })()

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      for (const provider of providers) disposers.push(ctx.lsp.registerProvider(provider))
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return async () => {
      // Remove every route before process teardown so no new query can enter a draining provider.
      for (const dispose of disposers.reverse()) dispose()
      const results = await Promise.allSettled(providers.map(provider => provider.disposeAll()))
      throwTeardownFailures(results, 'lsp-stdio provider teardown failed')
    }
  }, 'lsp-stdio.registerProviders')
}

/** Validate one resolved server entry before any provider in the table is registered. */
function validateServerConfig(providerId: string, resolved: ResolvedServerConfig): void {
  // Teardown budgets feed `deadline()`, whose `<= 0` is the internal no-timeout sentinel; a
  // nonpositive value would let a server that ignores shutdown hang disposal forever. Fail at load.
  assertTimer(providerId, 'shutdownTimeoutMs', resolved.shutdownTimeoutMs)
  assertTimer(providerId, 'killGraceMs', resolved.killGraceMs)
  assertTimer(providerId, 'diagnosticsTimeoutMs', resolved.diagnosticsTimeoutMs)  // Byte caps must be positive: a nonpositive stderr cap defeats the retained-tail bound
  // (`slice(-0)` keeps everything), `maxMessageBytes: 0` makes every response fatal, and a bad
  // document cap fails later in the read path instead of at load.
  assertPositiveInteger(providerId, 'maxStderrBytes', resolved.maxStderrBytes)
  assertPositiveInteger(providerId, 'maxMessageBytes', resolved.maxMessageBytes)
  assertPositiveInteger(providerId, 'maxDocumentBytes', resolved.maxDocumentBytes)
  if (resolved.typescriptNative !== undefined && resolved.typescriptNative.command.trim() === '') {
    throw new Error(`lsp-stdio: servers.${providerId}.typescriptNative.command must be non-empty`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(providerId: string, name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`lsp-stdio: servers.${providerId}.${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** Reject a nonpositive or non-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(providerId: string, name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`lsp-stdio: servers.${providerId}.${name} must be a positive integer`)
  }
}

/** A pooled generic provider: one server process per canonical workspace, created on demand. */
class LocalLspProvider implements LspProvider {
  readonly id: LspProviderId
  readonly extensionToLanguage: Readonly<Record<string, string>>
  /** One live instance per stable canonical workspace identity. */
  private readonly instances = new Map<WorkspaceKey, LspInstance>()
  /** One complete source-read→open→query→close serialization tail per canonical workspace. */
  private readonly queues = new Map<WorkspaceKey, Promise<void>>()
  /** Workspace canonicalizations that have not entered a provider-owned queue yet. */
  private readonly workspaceLookups = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  private disposed = false

  constructor(
    providerId: string,
    private readonly fs: Context['fs'],
    private readonly config: ResolvedServerConfig,
    private readonly executable: string,
    private readonly nativeExecutable: string | null,
    private readonly spawner: ConnectionSpawner,
  ) {
    this.id = LspProviderId(providerId)
    this.extensionToLanguage = config.extensionToLanguage
  }

  /** Read the disposed flag through a method so a `query()` await cannot narrow it to a literal. */
  private isDisposed(): boolean {
    return this.disposed
  }

  /** Reject work that cannot publish or use a provider-owned instance. */
  private assertActive(signal?: AbortSignal): void {
    /* v8 ignore next -- the seam unregisters this provider before disposal; direct in-flight calls
       exercise the post-await check instead. */
    if (this.isDisposed()) throw new LspError('lsp-stdio provider is disposed', 'LSP_DISPOSED')
    if (signal?.aborted) throw abortError(signal)
  }

  /** Fuse caller cancellation with provider disposal for every filesystem and protocol await. */
  private querySignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([signal, this.lifetime.signal])
  }

  async query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
    // Honor an already-aborted signal before provider I/O so a canceled request never starts a server.
    this.assertActive(signal)
    const querySignal = this.querySignal(signal)
    const workspaceResult = canonicalizeWorkspace(this.fs, request.workspaceRoot, querySignal)
    const workspaceLookup = workspaceResult.then(() => undefined, () => undefined)
    this.workspaceLookups.add(workspaceLookup)
    let workspace: HostWorkspace
    try {
      workspace = await workspaceResult
    } finally {
      this.workspaceLookups.delete(workspaceLookup)
    }
    this.assertActive(querySignal)
    const workspaceKey = workspace.target.targetKey
    return this.enqueue(workspaceKey, querySignal, async () => {
      this.assertActive(querySignal)
      // Read inside the workspace queue but before spawning: a queued query sees current bytes when
      // its turn starts, while an invalid source still cannot leave an idle process pooled.
      const source = await readHostSource(this.fs, request.filePath, workspace, this.config.maxDocumentBytes, querySignal)
      // Disposal may have snapshotted the instance map while host I/O was pending. Re-check before a
      // synchronous get-or-create so every spawned process remains owned by teardown.
      this.assertActive(querySignal)
      let instance = this.instanceFor(workspaceKey, workspace)
      try {
        // The diagnostics operation collects through the publish listener (the provider-read source
        // standing in for a caller-owned text+version), not a request/reply — route it separately.
        if (request.operation === 'diagnostics') {
          return await instance.diagnostics(request, source, querySignal)
        }
        return await instance.query(request, source, querySignal)
      } catch (error) {
        // A selected child can have died while idle or fail during the next write. Queries are
        // read-only, so replace that transport once and retry transparently.
        if (!instance.isTransportFailure(error)) throw error
        await instance.dispose()
        this.evictIfCurrent(workspaceKey, instance)
        this.assertActive(querySignal)
        instance = this.instanceFor(workspaceKey, workspace)
        if (request.operation === 'diagnostics') {
          return await instance.diagnostics(request, source, querySignal)
        }
        return await instance.query(request, source, querySignal)
      } finally {
        // Reach quiescence before dropping a dead slot; a replacement must survive this ownership check.
        if (instance.dead) {
          await instance.dispose()
          this.evictIfCurrent(workspaceKey, instance)
        }
      }
    })
  }

  async format(request: LspFormatRequest, signal?: AbortSignal): Promise<LspFormatResult> {
    // Honor an already-aborted signal before provider I/O so a canceled request never starts a server.
    this.assertActive(signal)
    const formatSignal = this.querySignal(signal)
    const workspaceResult = canonicalizeWorkspace(this.fs, request.workspaceRoot, formatSignal)
    const workspaceLookup = workspaceResult.then(() => undefined, () => undefined)
    this.workspaceLookups.add(workspaceLookup)
    let workspace: HostWorkspace
    try {
      workspace = await workspaceResult
    } finally {
      this.workspaceLookups.delete(workspaceLookup)
    }
    this.assertActive(formatSignal)
    const workspaceKey = workspace.target.targetKey
    return this.enqueue(workspaceKey, formatSignal, async () => {
      this.assertActive(formatSignal)
      // The caller owns the authoritative text, so resolve only the URI — still inside the queue
      // before spawning, so an invalid source cannot leave an idle process pooled.
      const uri = await resolveSourceUrl(this.fs, request.filePath, workspace, formatSignal)
      const languageId = this.languageFor(request.filePath)
      // Disposal may have snapshotted the instance map while host I/O was pending. Re-check before a
      // synchronous get-or-create so every spawned process remains owned by teardown.
      this.assertActive(formatSignal)
      let instance = this.instanceFor(workspaceKey, workspace)
      try {
        return await instance.format(request, uri, languageId, formatSignal)
      } catch (error) {
        // A selected child can have died while idle or fail during the next write. Formatting is
        // idempotent over the caller's in-memory text, so replace that transport once and retry.
        if (!instance.isTransportFailure(error)) throw error
        await instance.dispose()
        this.evictIfCurrent(workspaceKey, instance)
        this.assertActive(formatSignal)
        instance = this.instanceFor(workspaceKey, workspace)
        return await instance.format(request, uri, languageId, formatSignal)
      } finally {
        // Reach quiescence before dropping a dead slot; a replacement must survive this ownership check.
        if (instance.dead) {
          await instance.dispose()
          this.evictIfCurrent(workspaceKey, instance)
        }
      }
    })
  }

  async collectDiagnostics(request: LspDiagnosticsRequest, signal?: AbortSignal): Promise<LspDiagnosticsResult> {
    this.assertActive(signal)
    const diagnosticsSignal = this.querySignal(signal)
    const workspaceResult = canonicalizeWorkspace(this.fs, request.workspaceRoot, diagnosticsSignal)
    const workspaceLookup = workspaceResult.then(() => undefined, () => undefined)
    this.workspaceLookups.add(workspaceLookup)
    let workspace: HostWorkspace
    try {
      workspace = await workspaceResult
    } finally {
      this.workspaceLookups.delete(workspaceLookup)
    }
    this.assertActive(diagnosticsSignal)
    const workspaceKey = workspace.target.targetKey
    return this.enqueue(workspaceKey, diagnosticsSignal, async () => {
      this.assertActive(diagnosticsSignal)
      const uri = await resolveSourceUrl(this.fs, request.filePath, workspace, diagnosticsSignal)
      const languageId = this.languageFor(request.filePath)
      this.assertActive(diagnosticsSignal)
      let instance = this.instanceFor(workspaceKey, workspace)
      try {
        return await instance.collectDiagnostics(request, uri, languageId, diagnosticsSignal)
      } catch (error) {
        /* v8 ignore start -- a collect lifecycle is notification-only (no in-flight request), so a
           selected child that died while idle surfaces its transport failure only when the pooled
           connection is already failed at didOpen-write time — a timing race pinned at the instance
           level; the replace-once block stays as contract parity with `query` and `format`. */
        // Replace the transport once when the selected child failed, mirroring query's policy.
        if (!instance.isTransportFailure(error)) throw error
        await instance.dispose()
        this.evictIfCurrent(workspaceKey, instance)
        this.assertActive(diagnosticsSignal)
        instance = this.instanceFor(workspaceKey, workspace)
        return await instance.collectDiagnostics(request, uri, languageId, diagnosticsSignal)
      } finally {
        // Reach quiescence before dropping a dead slot; a replacement must survive this ownership check.
        if (instance.dead) {
          await instance.dispose()
          this.evictIfCurrent(workspaceKey, instance)
        }
      }
      /* v8 ignore stop */
    })
  }

  /** Resolve the language id for a source path from this provider's extension mapping. */
  private languageFor(filePath: string): string {
    const languageId = this.extensionToLanguage[finalExtension(filePath)]
    if (languageId === undefined) {
      /* v8 ignore next -- the seam routes only mapped extensions here; this backs an out-of-contract direct call. */
      throw new LspError(`no LSP provider handles "${filePath}"`, 'LSP_UNAVAILABLE')
    }
    return languageId
  }

  /** Serialize one complete query lifecycle for a canonical workspace. */
  private enqueue<T>(workspace: WorkspaceKey, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(workspace) ?? Promise.resolve()
    const result = abortable(previous, signal).then(run)
    // The tail follows the actual prior work even when this caller aborts its wait. It never rejects,
    // so later callers serialize without inheriting an earlier query's outcome.
    const tail = previous.then(() => result).then(() => undefined, () => undefined)
    this.queues.set(workspace, tail)
    void tail.then(() => {
      if (this.queues.get(workspace) === tail) this.queues.delete(workspace)
    })
    return result
  }

  /** Return or synchronously publish the one instance for a canonical workspace. */
  private instanceFor(workspaceKey: WorkspaceKey, workspace: HostWorkspace): LspInstance {
    this.assertActive()
    const existing = this.instances.get(workspaceKey)
    if (existing !== undefined) return existing
    const created = this.createInstance(workspace)
    this.instances.set(workspaceKey, created)
    return created
  }

  /** Drop the slot iff it still contains this instance. */
  private evictIfCurrent(workspace: WorkspaceKey, instance: LspInstance): void {
    /* v8 ignore next -- mismatch requires another query to replace the slot before this finally runs. */
    if (this.instances.get(workspace) === instance) this.instances.delete(workspace)
  }

  private createInstance(workspace: HostWorkspace): LspInstance {
    // Per-workspace TypeScript server selection: a TS7 workspace spawns the native
    // `tsc --lsp --stdio` while a classic one keeps the configured wrapper, and the
    // single provider serves both. Other servers pass through unchanged.
    const selection = this.config.typescriptNative === undefined
      ? null
      : selectTypeScriptServer({
        command: this.executable,
        args: this.config.args,
        typescriptNative: this.config.typescriptNative,
      }, workspace.canonicalPath, this.nativeExecutable)
    const spec: InstanceSpec = {
      command: selection?.command ?? this.executable,
      args: selection?.args ?? this.config.args,
      cwd: workspace.canonicalPath,
      workspaceUri: workspace.fileUrl,
      env: this.config.env,
      configuration: this.config.configuration,
      initializationOptions: this.config.initializationOptions,
      maxMessageBytes: this.config.maxMessageBytes,
      maxStderrBytes: this.config.maxStderrBytes,
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      killGraceMs: this.config.killGraceMs,
      diagnosticsTimeoutMs: this.config.diagnosticsTimeoutMs,
      projectAware: this.config.projectAware,
      projectDiagnosticsWaitMs: this.config.projectDiagnosticsWaitMs,
    }
    return new LspInstance(spec, this.spawner)
  }

  /** Dispose every live instance and block further queries. */
  async disposeAll(): Promise<void> {
    this.disposed = true
    this.lifetime.abort(new LspError('lsp-stdio provider is disposed', 'LSP_DISPOSED'))
    const live = [...this.instances.values()]
    const draining = [...this.queues.values()]
    const resolving = [...this.workspaceLookups]
    this.instances.clear()
    const results = await Promise.allSettled([
      ...live.map(instance => instance.dispose()),
      ...draining,
      ...resolving,
    ])
    this.queues.clear()
    this.workspaceLookups.clear()
    throwTeardownFailures(results, 'lsp-stdio instance teardown failed')
  }
}
