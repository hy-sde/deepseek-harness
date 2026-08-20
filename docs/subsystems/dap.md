# DAP debugging

English | [中文](dap.zh.md)

The DAP seam — exposing live debugging on one `ctx.dap` service, packaged as Service+Provider ([dsh-dap](../../packages/debug/dap), `ctx.dap` + adapter resolution + the session manager) and Consumer ([dsh-tool-debug](../../packages/debug/tool-debug), the `debug` tool schema). Unlike LSP the provider cannot be remote: a DAP adapter is a local binary that owns the debuggee, so the seam is one package, not definition/provider/consumer. The model asks for debugging through the `debug` tool; the seam owns the protocol.

Source: [`packages/debug/dap/src/types.ts`](../../packages/debug/dap/src/types.ts)

## Coordinates

Every operation returns `{ snapshot, ... }` where `snapshot` is the live session summary the consumer renders. Breakpoints are keyed by normalized source path; adapter selection is by extension then root markers; the session manager serializes breakpoint mutations per session tree so the model never observes torn state.

```ts type-equiv
/** Snapshot summary of a debug session's state. */
interface DapSessionSummary {
  id: string
  adapter: string
  cwd: string
  program: string | undefined
  status: DapSessionStatus
  launchedAt: string
  lastUsedAt: string
  threadId: number | undefined
  frameId: number | undefined
  stopReason: string | undefined
  stopDescription: string | undefined
  frameName: string | undefined
  instructionPointerReference: string | undefined
  source: DapSource | undefined
  line: number | undefined
  column: number | undefined
  breakpointFiles: number
  breakpointCount: number
  functionBreakpointCount: number
  outputBytes: number
  outputTruncated: boolean
  exitCode: number | undefined
  needsConfigurationDone: boolean
  parentSessionId: string | undefined
  childSessionIds: string[] | undefined
}
```

```ts type-equiv
/** Outcome of a `continue` call. */
interface DapContinueOutcome {
  snapshot: DapSessionSummary
  state: 'running' | 'stopped' | 'terminated'
  timedOut: boolean
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdap--dap"></a>

### `ctx.dap` — `Dap`

`ctx.dap`: one session manager per isolated realm. The manager owns the active-session pointer, adapter processes, breakpoint state, and captured output; every model-facing operation (see `@deepseek-ai/dsh-tool-debug`) delegates here. Lifecycle is fiber-scoped: disposal terminates every live adapter and stops the idle-cleanup timer.

```ts cordis-catalog
/**
 * Launch a program under the given adapter (or auto-select one).
 * @param args - launch arguments, forwarded to the session manager.
 * @returns the new session summary once the debuggee is configured.
 */
launch(...args: Parameters<DapSessionManager['launch']>): Promise<DapSessionSummary>

/**
 * Attach to a running process by pid, or to a port (debugpy listen/attach).
 * @param args - attach arguments, forwarded to the session manager.
 * @returns the new session summary once the debuggee is configured.
 */
attach(...args: Parameters<DapSessionManager['attach']>): Promise<DapSessionSummary>

/**
 * The currently active session summary, or null.
 * @returns the active session summary, or null when no session is active.
 */
getActiveSession(): DapSessionSummary | null

/**
 * Every live (and lingering) session summary under this manager.
 * @returns the list of session summaries.
 */
listSessions(): DapSessionSummary[]

/**
 * Capabilities of the active session, or null when none.
 * @returns the active session's capabilities, or null when no session is active.
 */
getCapabilities(): DapCapabilities | null

/**
 * Read a source breakpoint at `file:line`; returns the updated list.
 * @param args - setBreakpoint arguments, forwarded to the session manager.
 * @returns the updated breakpoint list for the file and the session snapshot.
 */
setBreakpoint( ...args: Parameters<DapSessionManager['setBreakpoint']> ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapBreakpointRecord[]; sourcePath: string }>

/**
 * Remove a source breakpoint at `file:line`.
 * @param args - removeBreakpoint arguments, forwarded to the session manager.
 * @returns the updated breakpoint list for the file and the session snapshot.
 */
removeBreakpoint( ...args: Parameters<DapSessionManager['removeBreakpoint']> ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapBreakpointRecord[] }>

/**
 * Set a function breakpoint by qualified name.
 * @param args - setFunctionBreakpoint arguments, forwarded to the session manager.
 * @returns the updated function breakpoint list and the session snapshot.
 */
setFunctionBreakpoint( ...args: Parameters<DapSessionManager['setFunctionBreakpoint']> ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapFunctionBreakpointRecord[] }>

/**
 * Remove a function breakpoint by name.
 * @param args - removeFunctionBreakpoint arguments, forwarded to the session manager.
 * @returns the updated function breakpoint list and the session snapshot.
 */
removeFunctionBreakpoint( ...args: Parameters<DapSessionManager['removeFunctionBreakpoint']> ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapFunctionBreakpointRecord[] }>

/**
 * Resume execution of the active thread.
 * @param args - continue arguments (signal, timeout), forwarded to the session manager.
 * @returns the stop outcome with the resulting session snapshot.
 */
continue(...args: Parameters<DapSessionManager['continue']>): Promise<DapContinueOutcome>

/**
 * Pause the debuggee.
 * @param args - pause arguments (signal, timeout), forwarded to the session manager.
 * @returns the session snapshot after the pause.
 */
pause(...args: Parameters<DapSessionManager['pause']>): Promise<DapSessionSummary>

/**
 * Step into the current frame.
 * @param args - stepIn arguments, forwarded to the session manager.
 * @returns the stop outcome with the resulting session snapshot.
 */
stepIn(...args: Parameters<DapSessionManager['stepIn']>): Promise<DapContinueOutcome>

/**
 * Step out of the current frame.
 * @param args - stepOut arguments, forwarded to the session manager.
 * @returns the stop outcome with the resulting session snapshot.
 */
stepOut(...args: Parameters<DapSessionManager['stepOut']>): Promise<DapContinueOutcome>

/**
 * Step over the current line.
 * @param args - stepOver arguments, forwarded to the session manager.
 * @returns the stop outcome with the resulting session snapshot.
 */
stepOver(...args: Parameters<DapSessionManager['stepOver']>): Promise<DapContinueOutcome>

/**
 * List the debuggee's threads.
 * @param args - threads arguments, forwarded to the session manager.
 * @returns the aggregated thread list and the session snapshot.
 */
threads(...args: Parameters<DapSessionManager['threads']>): Promise<{ snapshot: DapSessionSummary; threads: DapThread[] }>

/**
 * List the current thread's stack frames.
 * @param args - stackTrace arguments, forwarded to the session manager.
 * @returns the stack frames, total frame count, and the session snapshot.
 */
stackTrace( ...args: Parameters<DapSessionManager['stackTrace']> ): Promise<{ snapshot: DapSessionSummary; stackFrames: DapStackFrame[]; totalFrames: number | undefined }>

/**
 * List the scopes of a stack frame.
 * @param args - scopes arguments, forwarded to the session manager.
 * @returns the scopes and the session snapshot.
 */
scopes(...args: Parameters<DapSessionManager['scopes']>): Promise<{ snapshot: DapSessionSummary; scopes: DapScope[] }>

/**
 * List the variables of a variable reference.
 * @param args - variables arguments, forwarded to the session manager.
 * @returns the variables and the session snapshot.
 */
variables( ...args: Parameters<DapSessionManager['variables']> ): Promise<{ snapshot: DapSessionSummary; variables: DapVariable[] }>

/**
 * Evaluate an expression in the current frame.
 * @param args - evaluate arguments, forwarded to the session manager.
 * @returns the evaluation result and the session snapshot.
 */
evaluate( ...args: Parameters<DapSessionManager['evaluate']> ): Promise<{ snapshot: DapSessionSummary; evaluation: DapEvaluateResponse | undefined }>

/**
 * Captured stdout/stderr output of the active session (bounded).
 * @param limitBytes - optional cap on the number of returned output bytes.
 * @returns the tail of the captured output and the session snapshot.
 */
getOutput(limitBytes?: number): DapOutputSnapshot

/**
 * Terminate the active session's whole tree.
 * @param args - terminate arguments, forwarded to the session manager.
 * @returns the final session snapshot, or null when no session was active.
 */
terminate(...args: Parameters<DapSessionManager['terminate']>): Promise<DapSessionSummary | null>

/**
 * Set an instruction pointer breakpoint.
 * @param args - setInstructionBreakpoint arguments, forwarded to the session manager.
 * @returns the updated instruction breakpoint list and the session snapshot.
 */
setInstructionBreakpoint( ...args: Parameters<DapSessionManager['setInstructionBreakpoint']> ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapInstructionBreakpointRecord[] }>

/**
 * Remove an instruction pointer breakpoint.
 * @param args - removeInstructionBreakpoint arguments, forwarded to the session manager.
 * @returns the updated instruction breakpoint list and the session snapshot.
 */
removeInstructionBreakpoint( ...args: Parameters<DapSessionManager['removeInstructionBreakpoint']> ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapInstructionBreakpointRecord[] }>

/**
 * Query data-breakpoint availability for a variable/expression.
 * @param args - dataBreakpointInfo arguments, forwarded to the session manager.
 * @returns the data-breakpoint info and the session snapshot.
 */
dataBreakpointInfo( ...args: Parameters<DapSessionManager['dataBreakpointInfo']> ): Promise<{ snapshot: DapSessionSummary; info: DapDataBreakpointInfoResponse }>

/**
 * Set a data breakpoint (write/read hardware breakpoint).
 * @param args - setDataBreakpoint arguments, forwarded to the session manager.
 * @returns the updated data breakpoint list and the session snapshot.
 */
setDataBreakpoint( ...args: Parameters<DapSessionManager['setDataBreakpoint']> ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapDataBreakpointRecord[] }>

/**
 * Remove a data breakpoint.
 * @param args - removeDataBreakpoint arguments, forwarded to the session manager.
 * @returns the updated data breakpoint list and the session snapshot.
 */
removeDataBreakpoint( ...args: Parameters<DapSessionManager['removeDataBreakpoint']> ): Promise<{ snapshot: DapSessionSummary; breakpoints: DapDataBreakpointRecord[] }>

/**
 * Disassemble instructions around a memory reference.
 * @param args - disassemble arguments, forwarded to the session manager.
 * @returns the disassembled instructions and the session snapshot.
 */
disassemble( ...args: Parameters<DapSessionManager['disassemble']> ): Promise<{ snapshot: DapSessionSummary; instructions: DapDisassembledInstruction[] }>

/**
 * Read raw process memory (base64 buffer string).
 * @param args - readMemory arguments, forwarded to the session manager.
 * @returns the memory read result and the session snapshot.
 */
readMemory( ...args: Parameters<DapSessionManager['readMemory']> ): Promise<{ snapshot: DapSessionSummary; address: string; data: string | undefined; unreadableBytes: number | undefined }>

/**
 * Write raw process memory (base64 buffer string).
 * @param args - writeMemory arguments, forwarded to the session manager.
 * @returns the memory write result and the session snapshot.
 */
writeMemory( ...args: Parameters<DapSessionManager['writeMemory']> ): Promise<{ snapshot: DapSessionSummary; offset: number | undefined; bytesWritten: number | undefined }>

/**
 * List loaded modules of the debuggee.
 * @param args - modules arguments, forwarded to the session manager.
 * @returns the loaded modules and the session snapshot.
 */
modules(...args: Parameters<DapSessionManager['modules']>): Promise<{ snapshot: DapSessionSummary; modules: DapModule[] }>

/**
 * List source files loaded by the debuggee.
 * @param args - loadedSources arguments, forwarded to the session manager.
 * @returns the loaded sources and the session snapshot.
 */
loadedSources( ...args: Parameters<DapSessionManager['loadedSources']> ): Promise<{ snapshot: DapSessionSummary; sources: DapSource[] }>

/**
 * Send an unstandardized DAP request to the active adapter.
 * @param args - customRequest arguments, forwarded to the session manager.
 * @returns the adapter response body and the session snapshot.
 */
customRequest( ...args: Parameters<DapSessionManager['customRequest']> ): Promise<{ snapshot: DapSessionSummary; body: unknown }>

/** Dispose every session under this manager. */
disposeManager(): void

/**
 * Classify a launch program as file/directory on disk.
 * @param program - the launch program path.
 * @param cwd - the working directory used for resolution.
 * @returns the classification of the program.
 */
async classifyProgram(program: string, cwd: string): Promise<LaunchProgramKind>

/**
 * Select (or auto-select) a launch adapter for `program` in `cwd`.
 * @param program - the launch program path.
 * @param cwd - the working directory used for adapter resolution.
 * @param options - optional adapter name, program kind, and abort signal.
 * @returns the launch adapter selection.
 */
async selectLaunchAdapter( program: string, cwd: string, options?: { adapter?: string; programKind?: LaunchProgramKind; signal?: AbortSignal }, ): Promise<LaunchAdapterSelection>

/**
 * Select an attach adapter: explicit name, otherwise the best installed default.
 * @param cwd - the working directory used for adapter resolution.
 * @param options - optional adapter name, port, and abort signal.
 * @returns the resolved attach adapter, or null when none is available.
 */
async selectAttachAdapter( cwd: string, options?: { adapter?: string; port?: number; signal?: AbortSignal }, ): Promise<DapResolvedAdapter | null>

/**
 * Every configured adapter whose command resolves under `cwd`.
 * @param cwd - the working directory used for adapter resolution.
 * @param signal - optional abort signal.
 * @returns the names of the available adapters.
 */
async listAdapters(cwd: string, signal?: AbortSignal): Promise<string[]>

/**
 * Resolve one named adapter under `cwd`, or null when unavailable.
 * @param name - the adapter name to resolve.
 * @param cwd - the working directory used for adapter resolution.
 * @param signal - optional abort signal.
 * @returns the resolved adapter, or null when unavailable.
 */
async resolveAdapter(name: string, cwd: string, signal?: AbortSignal): Promise<DapResolvedAdapter | null>

/**
 * Compute adapter-specific launch overrides for a resolved program.
 * @param adapter - the resolved adapter.
 * @param program - the launch program path.
 * @param programKind - the classification of the launch program.
 * @returns the adapter-specific launch override arguments.
 */
resolveLaunchOverrides( adapter: DapResolvedAdapter, program: string, programKind: LaunchProgramKind, ): Record<string, unknown>
```

Source: [`packages/debug/dap/src/index.ts:126`](../../packages/debug/dap/src/index.ts)
<!-- END GENERATED cordis-surface -->
