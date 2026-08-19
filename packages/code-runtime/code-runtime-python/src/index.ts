/**
 * Persistent Python code runtime: the additive seam backend of the
 * code-execution family (see ../../README.md), for runs that may carry a
 * `sessionId` and keep kernel state across them. One long-lived `python3`
 * subprocess per session runs the embedded runner over NDJSON (src/runner),
 * bridging bindings and capturing output; the session registry serializes and
 * reaps sessions; the outer `OutputLedger` enforces the combined output cap.
 * This is process confinement, not a security boundary: model code has
 * bash-equivalent trust.
 * @module @deepseek-ai/dsh-code-runtime-python
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  CodeRuntime,
  DUNDER_MEMBER,
  PORTABLE_RESERVED_WORDS,
  RESERVED_BINDING_GLOBALS,
  RESERVED_ERROR_MEMBERS,
} from '@deepseek-ai/dsh-code-runtime'
import type {
  CodeBindingNamespace,
  CodeJsonValue,
  CodeRunFailure,
  CodeRunRequest,
  CodeRunResult,
} from '@deepseek-ai/dsh-code-runtime'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { PythonKernel } from './kernel.ts'
import type { KernelExecResult } from './kernel.ts'
import { PythonSessionRegistry } from './session.ts'

/**
 * Plugin config: every execution cap, changeable from `cordis.yml` (no
 * hardcoded tunables), mirroring the worker-thread backend's shape where the
 * two share a knob.
 */
export interface Config {
  /**
   * Explicit `python3`-compatible interpreter path. Defaults to discovery
   * (`python3` on PATH), which fails loud at first kernel spawn when absent.
   */
  pythonPath?: string
  /** Wall-clock ceiling in milliseconds: the backstop for a run nothing can interrupt synchronously. */
  maxWallMs?: number
  /** Hard cap for combined serialized log-, completion-, and failure payload bytes. */
  maxOutputBytes?: number
  /** Reap a session idle for at least this many milliseconds; `0` disables reaping. */
  sessionIdleMs?: number
  /** How long to wait after SIGINT before escalating to SIGTERM (then SIGKILL). */
  interruptEscalationMs?: number
  /** How long to wait for the bootstrap `ready` frame. */
  startupTimeoutMs?: number
  /** Grace period for the kernel to exit after an `exit` frame. */
  shutdownGraceMs?: number
}

/** {@link Config} after schemastery fills the defaults. `pythonPath` stays optional (no default). */
type ResolvedConfig = Omit<Required<Config>, 'pythonPath'> & Pick<Config, 'pythonPath'>

/** Smallest cap that can represent the counted payloads: an empty logs array plus an empty JSON failure message. */
const MIN_OUTPUT_BYTES = 4

/** Constructor for a timeout-flavored abort reason, surfacing the budget in the result. */
class RunTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** The seam's language-portable identifier subset (see `CodeBindingNamespace.global`). */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Outer-output ledger for one run: admits log entries, the completion value,
 * and the failure message against one combined byte cap. Independent of the
 * worker-thread backend's ledger, but with the same semantics — a value is a
 * compact JSON serialization, text is UTF-8 byte-counted.
 */
class OutputLedger {
  private bytes = 2 // JSON serialization of the empty logs array: []
  private entries = 0

  constructor(private readonly maxBytes: number) {}

  private textBytes(text: string): number {
    return Buffer.byteLength(text, 'utf8')
  }

  /** Admit one exact log entry, or report that the hard cap was crossed. */
  admit(text: string, sink: string[]): boolean {
    const separatorBytes = this.entries > 0 ? 1 : 0
    const stringBytes = this.textBytes(text)
    if (this.bytes + stringBytes + separatorBytes > this.maxBytes) return false
    this.bytes += stringBytes + separatorBytes
    this.entries += 1
    sink.push(text)
    return true
  }

  /** Finalize a successful absent-or-JSON completion against the combined cap. */
  success(logs: string[], value?: CodeJsonValue): CodeRunResult {
    if (value === undefined) return { logs }
    const valueBytes = this.compactJsonBytes(value)
    if (valueBytes === undefined || this.bytes + valueBytes > this.maxBytes) return this.limit(logs)
    return { logs, value }
  }

  /** Finalize a failure diagnostic, with output-limit taking precedence over the cap. */
  failure(logs: string[], error: CodeRunFailure): CodeRunResult {
    const messageBytes = this.textBytes(error.message)
    if (this.bytes + messageBytes <= this.maxBytes) return { logs, error }
    return this.limit(logs)
  }

  /** Build the explicit output-limit failure while retaining fitting logs. */
  limit(logs: string[]): CodeRunResult {
    const fullMessage = `outer output exceeded ${this.maxBytes} bytes`
    const messageBytes = this.textBytes(fullMessage)
    const retained: string[] = []
    let retainedBytes = 2
    for (const text of logs) {
      const separatorBytes = retained.length > 0 ? 1 : 0
      if (retainedBytes + this.textBytes(text) + separatorBytes + messageBytes > this.maxBytes) break
      retained.push(text)
      retainedBytes += this.textBytes(text) + separatorBytes
    }
    return { logs: retained, error: { kind: 'output-limit', message: fullMessage } }
  }

  private compactJsonBytes(value: CodeJsonValue): number | undefined {
    let text: string
    try {
      text = JSON.stringify(value)
    } catch {
      return undefined
    }
    return this.textBytes(text)
  }
}

/**
 * The shipped persistent Python backend (`ctx.codeRuntime`). Every cap comes
 * from validated config; runs without a `sessionId` behave one-shot (a fresh
 * kernel is spawned and shut down for exactly one program), runs with one go
 * through the session registry and keep kernel state.
 */
export class PythonCodeRuntime extends CodeRuntime {
  static Config: z<Config> = z.object({
    pythonPath: z.string(),
    maxWallMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(67_108_864),
    sessionIdleMs: z.number().default(0),
    interruptEscalationMs: z.number().default(5_000),
    startupTimeoutMs: z.number().default(15_000),
    shutdownGraceMs: z.number().default(1_000),
  })

  readonly language = 'python'
  readonly isolation = 'process'
  override readonly persistent = true

  private readonly config: ResolvedConfig
  private readonly registry: PythonSessionRegistry
  private readonly ledgerFactory: () => OutputLedger
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config as ResolvedConfig
    const numericKeys = ['maxWallMs', 'maxOutputBytes', 'sessionIdleMs',
      'interruptEscalationMs', 'startupTimeoutMs', 'shutdownGraceMs'] as const
    for (const key of numericKeys) {
      const value = this.config[key]
      if (!(Number.isFinite(value) && value >= 0)) {
        throw new Error(`dsh-code-runtime-python: config.${key} must be a non-negative number, got ${String(value)}`)
      }
    }
    if (!Number.isSafeInteger(this.config.maxOutputBytes) || this.config.maxOutputBytes < MIN_OUTPUT_BYTES) {
      throw new Error(`dsh-code-runtime-python: config.maxOutputBytes must be a safe integer of at least ${MIN_OUTPUT_BYTES}`)
    }
    if (this.config.maxWallMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`dsh-code-runtime-python: config.maxWallMs must be at most ${MAX_TIMER_DELAY_MS} (Node clamps a longer setTimeout delay to 1ms)`)
    }
    this.ledgerFactory = () => new OutputLedger(this.config.maxOutputBytes)
    this.registry = new PythonSessionRegistry({
      start: {
        pythonPath: this.config.pythonPath ?? 'python3',
        startupTimeoutMs: this.config.startupTimeoutMs,
        interruptEscalationMs: this.config.interruptEscalationMs,
        shutdownGraceMs: this.config.shutdownGraceMs,
      },
      cwd: process.cwd(),
      env: process.env,
      sessionIdleMs: this.config.sessionIdleMs,
    })
    ctx.effect(() => () => this.teardown(), 'python code-runtime teardown')
  }

  /**
   * Terminate every session kernel to quiescence; fail in-flight runs as
   * aborted (the registry's dispose path does the awaiting).
   */
  async teardown(): Promise<void> {
    this.disposed = true
    await this.registry.disposeAll()
  }

  /**
   * Execute one program. Program outcomes resolve with `result.error`; the
   * method rejects only for Service Definition contract misuse (a disposed
   * runtime, an invalid binding namespace). With a non-empty `request.sessionId`
   * the program runs in that session's persistent kernel and `executionCount`
   * is reported; `reset: true` discards the session's prior state first.
   */
  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('dsh-code-runtime-python: run() after disposal')
    const bindings = this.validateBindings(request)
    if (request.signal?.aborted) {
      return this.ledgerFactory().failure([], { kind: 'abort', message: String(request.signal.reason) })
    }

    // Wall-clock budget: this run's abort source. The kernel turns it into
    // SIGINT (and escalation), so a busy cell is interrupted hard.
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new RunTimeoutError(`wall-clock ceiling reached (${this.config.maxWallMs}ms)`))
    }, this.config.maxWallMs)
    timer.unref()
    const onOuter = (): void => { controller.abort(request.signal?.reason) }
    request.signal?.addEventListener('abort', onOuter, { once: true })

    try {
      const sessionId = request.sessionId
      const outcome: KernelExecResult = sessionId !== undefined && sessionId.length > 0
        ? await this.registry.executeOnSession(sessionId, request.program, bindings, {
          ...request.reset !== undefined ? { reset: request.reset } : {},
          signal: controller.signal,
        })
        : await this.runOneShot(request.program, bindings, controller.signal)

      return this.finalize(outcome, timedOut)
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onOuter)
    }
  }

  /** One fresh kernel for exactly one program: the one-shot path. */
  private async runOneShot(
    program: string,
    bindings: CodeBindingNamespace[],
    signal: AbortSignal,
  ): Promise<KernelExecResult> {
    const kernel = await PythonKernel.start({
      pythonPath: this.config.pythonPath ?? 'python3',
      cwd: process.cwd(),
      env: process.env,
      startupTimeoutMs: this.config.startupTimeoutMs,
      interruptEscalationMs: this.config.interruptEscalationMs,
      shutdownGraceMs: this.config.shutdownGraceMs,
    })
    try {
      return await kernel.execute(randomUUID(), program, bindings, { signal })
    } finally {
      await kernel.shutdown().catch(() => {})
    }
  }

  /**
   * Map a kernel outcome onto the seam's failure taxonomy through the output
   * ledger. Budget expiry owns a run that hit the wall clock (whether or not
   * the kernel survived to acknowledge it); everything else interrupted is an
   * abort; a died kernel is an abort unless the budget already owns the run.
   */
  private finalize(outcome: KernelExecResult, timedOut: boolean): CodeRunResult {
    const ledger = this.ledgerFactory()
    const logs = outcome.logs.map(entry => entry.text)
    if (timedOut) {
      const message = outcome.killed
        ? `wall-clock ceiling reached (${this.config.maxWallMs}ms); kernel killed after unresponsive interrupt`
        : `wall-clock ceiling reached (${this.config.maxWallMs}ms)`
      return ledger.failure(logs, { kind: 'timeout', message })
    }
    if (outcome.killed) {
      return ledger.failure(logs, { kind: 'abort', message: outcome.message || 'run interrupted' })
    }
    if (outcome.cancelled) {
      return ledger.failure(logs, { kind: 'abort', message: outcome.message || 'run interrupted' })
    }
    if (outcome.status === 'error') {
      if (outcome.invalidOutput) {
        return ledger.failure(logs, { kind: 'invalid-output', message: outcome.message || 'program completion must be lossless JSON' })
      }
      return ledger.failure(logs, { kind: 'exception', message: outcome.message || 'program failed' })
    }
    const result = outcome.value === undefined
      ? ledger.success(logs)
      : ledger.success(logs, outcome.value)
    return { ...result, ...outcome.executionCount !== undefined ? { executionCount: outcome.executionCount } : {} }
  }

  /** Reject malformed binding globals or typed-error declarations as contract misuse. */
  private validateBindings(request: CodeRunRequest): CodeBindingNamespace[] {
    const bindings = new Map<string, CodeBindingNamespace>()
    for (const namespace of request.bindings) {
      if (!IDENTIFIER.test(namespace.global) || PORTABLE_RESERVED_WORDS.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-python: binding global ${JSON.stringify(namespace.global)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(namespace.global) || bindings.has(namespace.global)) {
        throw new Error(`dsh-code-runtime-python: reserved or duplicate binding global ${JSON.stringify(namespace.global)}`)
      }
      bindings.set(namespace.global, namespace)
    }
    const errorClassNames = new Set<string>()
    for (const namespace of request.bindings) {
      const descriptor = namespace.errorClass
      if (descriptor === undefined) continue
      if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-python: binding error class ${JSON.stringify(descriptor.name)} is not a usable identifier`)
      }
      if (RESERVED_BINDING_GLOBALS.has(descriptor.name) || bindings.has(descriptor.name) || errorClassNames.has(descriptor.name)) {
        throw new Error(`dsh-code-runtime-python: reserved or duplicate injected global ${JSON.stringify(descriptor.name)}`)
      }
      const member = descriptor.memberNameProperty
      if (member.length === 0 || RESERVED_ERROR_MEMBERS.has(member) || DUNDER_MEMBER.test(member)) {
        throw new Error(`dsh-code-runtime-python: binding error member property ${JSON.stringify(descriptor.memberNameProperty)} is not usable`)
      }
      errorClassNames.add(descriptor.name)
    }
    return request.bindings
  }
}

export default PythonCodeRuntime
