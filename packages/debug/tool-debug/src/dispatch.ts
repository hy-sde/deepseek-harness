/**
 * Per-operation handlers behind the `debug` tool's action dispatch. Each
 * handler validates its action's inputs, calls `ctx.dap`, and renders the
 * result through `render.ts`; `dispatchDebugAction` routes by `input.action`
 * and owns no behavior beyond that selection.
 * @module @deepseek-ai/dsh-tool-debug/dispatch
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  DapCapabilities,
  DapEvaluateArguments,
  DapResolvedAdapter,
  DapSessionSummary,
} from '@deepseek-ai/dsh-dap'
import { resolveCallCwd, resolveToCwd } from './session.ts'
import type { DebugToolArgs } from './types.ts'
import {
  formatBreakpoints,
  formatCustomResponse,
  formatDataBreakpointInfo,
  formatDataBreakpoints,
  formatDisassembly,
  formatEvaluation,
  formatFunctionBreakpoints,
  formatInstructionBreakpoints,
  formatLoadedSources,
  formatMemoryRead,
  formatModules,
  formatScopes,
  formatSessionSnapshot,
  formatSessions,
  formatStackFrames,
  formatThreads,
  formatVariables,
  makeDebugOutput,
  projectSession,
} from './render.ts'
import type { DebugOutputSession, DebugToolOutput } from './render.ts'

/** Adapter-unavailable hints keyed by well-known adapter ids. */
export const ADAPTER_UNAVAILABLE_MESSAGES: Readonly<Record<string, string>> = {
  debugpy: "adapter 'debugpy' is not available: install with 'pip install debugpy'",
  dlv: "adapter 'dlv' is not available: install with 'go install github.com/go-delve/delve/cmd/dlv@latest'",
  rdbg: "adapter 'rdbg' is not available: install with 'gem install debug'",
  'js-debug-adapter':
    "adapter 'js-debug-adapter' is not available: download it from https://github.com/microsoft/vscode-js-debug",
}

async function requireAdapter(adapter: DapResolvedAdapter | null, name: string | undefined, cwd: string, dap: Context['dap']): Promise<DapResolvedAdapter> {
  if (adapter !== null) return adapter
  const available = await dap.listAdapters(cwd)
  const names = available.length > 0 ? available.join(', ') : 'none'
  if (name) {
    const hint = ADAPTER_UNAVAILABLE_MESSAGES[name]
    throw new Error(
      hint ?? `adapter '${name}' is not available. Installed adapters: ${names}`,
    )
  }
  throw new Error(`No debugger adapter available. Installed adapters: ${names}`)
}

function requireSession(dap: Context['dap']): DapSessionSummary {
  const snapshot = dap.getActiveSession()
  if (!snapshot) {
    throw new Error('No active debug session. Launch or attach first.')
  }
  return snapshot
}

function requireCapability(dap: Context['dap'], capability: keyof DapCapabilities, description: string): void {
  requireSession(dap)
  if (dap.getCapabilities()?.[capability] !== true) {
    throw new Error(`Current adapter does not support ${description}`)
  }
}

function resolveDisassemblyReference(dap: Context['dap'], memoryReference: string | undefined): string {
  if (memoryReference) return memoryReference
  const snapshot = requireSession(dap)
  if (snapshot.instructionPointerReference) {
    return snapshot.instructionPointerReference
  }
  throw new Error(
    'disassemble requires memory_reference unless the current stop location has an instruction pointer reference',
  )
}

/** Validate breakpoint references used by instruction/data breakpoint ops. */
function requireBreakpointInput(kind: 'instruction' | 'data-id', input: DebugToolArgs): string {
  if (kind === 'instruction') {
    const reference = input.instruction_reference
    if (!reference) {
      throw new Error('instruction_reference is required for instruction breakpoint operations')
    }
    return reference
  }
  const dataId = input.data_id
  if (!dataId) {
    throw new Error('data_id is required for data breakpoint operations')
  }
  return dataId
}

/** Project a session summary into the canonical plain session record. */
function acc(snapshot: DapSessionSummary): { session: DebugOutputSession } {
  return { session: projectSession(snapshot) }
}

/** Everything a per-operation handler receives besides the parsed `input`. */
export interface DebugDispatchContext {
  /** The DAP service seam the handler calls. */
  readonly dap: Context['dap']
  /** Session workspace the call resolves relative paths against. */
  readonly workspace: string
  /** Combined tool-execution and per-request timeout abort signal. */
  readonly signal: AbortSignal
  /** Per-request timeout budget in ms. */
  readonly requestTimeoutMs: number
  /** Cap on the total rendered result length. */
  readonly maxResultChars: number
}

/**
 * Route one parsed debug call to its per-operation handler.
 * @param ctx - the dispatch context (dap service, workspace, timeouts).
 * @param input - the parsed debug tool arguments.
 * @returns the constructed tool output value.
 */
export async function dispatchDebugAction(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  switch (input.action) {
    case 'launch': return handleLaunch(ctx, input)
    case 'attach': return handleAttach(ctx, input)
    case 'set_breakpoint': return handleSetBreakpoint(ctx, input)
    case 'remove_breakpoint': return handleRemoveBreakpoint(ctx, input)
    case 'set_instruction_breakpoint': return handleSetInstructionBreakpoint(ctx, input)
    case 'remove_instruction_breakpoint': return handleRemoveInstructionBreakpoint(ctx, input)
    case 'data_breakpoint_info': return handleDataBreakpointInfo(ctx, input)
    case 'set_data_breakpoint': return handleSetDataBreakpoint(ctx, input)
    case 'remove_data_breakpoint': return handleRemoveDataBreakpoint(ctx, input)
    case 'continue':
    case 'step_over':
    case 'step_in':
    case 'step_out': return handleContinueOrStep(ctx, input)
    case 'pause': return handlePause(ctx, input)
    case 'evaluate': return handleEvaluate(ctx, input)
    case 'stack_trace': return handleStackTrace(ctx, input)
    case 'threads': return handleThreads(ctx, input)
    case 'scopes': return handleScopes(ctx, input)
    case 'variables': return handleVariables(ctx, input)
    case 'disassemble': return handleDisassemble(ctx, input)
    case 'read_memory': return handleReadMemory(ctx, input)
    case 'write_memory': return handleWriteMemory(ctx, input)
    case 'modules': return handleModules(ctx, input)
    case 'loaded_sources': return handleLoadedSources(ctx, input)
    case 'custom_request': return handleCustomRequest(ctx, input)
    case 'output': return handleOutput(ctx)
    case 'terminate': return handleTerminate(ctx, input)
    case 'sessions': return handleSessions(ctx)
    default: {
      // exhaustive over the union; unreachable after parseDebugArgs validation
      throw new Error(`Unsupported debug action: ${String(input.action)}`)
    }
  }
}

/** Launch a program under a resolved adapter and render the post-launch snapshot. */
async function handleLaunch(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  if (!input.program) throw new Error('program is required for launch')
  const { dap, workspace, signal, requestTimeoutMs, maxResultChars } = ctx
  const cwd = resolveCallCwd(input, workspace)
  const program = resolveToCwd(input.program, cwd)
  const programKind = await dap.classifyProgram(program, cwd)
  const selection = await dap.selectLaunchAdapter(program, cwd, {
    ...(input.adapter ? { adapter: input.adapter } : {}),
    programKind,
    signal,
  })
  if (selection.kind === 'unavailable') {
    const hint = ADAPTER_UNAVAILABLE_MESSAGES[selection.adapterName]
    throw new Error(
      hint ??
        `adapter '${selection.adapterName}' is not available: configured command '${selection.command}' did not resolve. Check the DAP adapter config for this workspace.`,
    )
  }
  if (selection.kind === 'none') {
    const available = await dap.listAdapters(cwd)
    throw new Error(
      `No debugger adapter available. Installed adapters: ${available.length > 0 ? available.join(', ') : 'none'}`,
    )
  }
  const { adapter } = selection
  if (programKind === 'directory' && !adapter.acceptsDirectoryProgram) {
    throw new Error(
      `launch program resolves to a directory: ${program}. Pass an executable file path or choose an adapter that supports package directories.`,
    )
  }
  const extraLaunchArguments = dap.resolveLaunchOverrides(adapter, program, programKind)
  const snapshot = await dap.launch(
    { adapter, program, ...(input.args ? { args: input.args } : {}), cwd, extraLaunchArguments },
    signal,
    requestTimeoutMs,
  )
  const text = formatSessionSnapshot(snapshot).join('\n')
  return makeDebugOutput('launch', text, acc(snapshot), maxResultChars)
}

/** Attach to a process by pid or port and render the post-attach snapshot. */
async function handleAttach(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  if (input.pid === undefined && input.port === undefined) {
    throw new Error('attach requires pid or port')
  }
  const { dap, workspace, signal, requestTimeoutMs, maxResultChars } = ctx
  const cwd = resolveCallCwd(input, workspace)
  const adapter = await requireAdapter(
    await dap.selectAttachAdapter(cwd, {
      ...(input.adapter ? { adapter: input.adapter } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      signal,
    }),
    input.adapter,
    cwd,
    dap,
  )
  const snapshot = await dap.attach(
    {
      adapter,
      cwd,
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.host ? { host: input.host } : {}),
    },
    signal,
    requestTimeoutMs,
  )
  const text = formatSessionSnapshot(snapshot).join('\n')
  return makeDebugOutput('attach', text, acc(snapshot), maxResultChars)
}

/** Set one source (file+line) or function breakpoint and render the list. */
async function handleSetBreakpoint(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, workspace, signal, requestTimeoutMs, maxResultChars } = ctx
  if (input.function) {
    const response = await dap.setFunctionBreakpoint(input.function, input.condition, signal, requestTimeoutMs)
    const text = formatFunctionBreakpoints(response.breakpoints)
    return makeDebugOutput('set_breakpoint', text, acc(response.snapshot), maxResultChars)
  }
  if (!input.file || input.line === undefined) {
    throw new Error('set_breakpoint requires file+line or function')
  }
  const file = resolveToCwd(input.file, workspace)
  const response = await dap.setBreakpoint(file, input.line, input.condition, signal, requestTimeoutMs)
  const text = formatBreakpoints(file, response.breakpoints)
  return makeDebugOutput('set_breakpoint', text, acc(response.snapshot), maxResultChars)
}

/** Remove one source (file+line) or function breakpoint and render the list. */
async function handleRemoveBreakpoint(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, workspace, signal, requestTimeoutMs, maxResultChars } = ctx
  if (input.function) {
    const response = await dap.removeFunctionBreakpoint(input.function, signal, requestTimeoutMs)
    const text = formatFunctionBreakpoints(response.breakpoints)
    return makeDebugOutput('remove_breakpoint', text, acc(response.snapshot), maxResultChars)
  }
  if (!input.file || input.line === undefined) {
    throw new Error('remove_breakpoint requires file+line or function')
  }
  const file = resolveToCwd(input.file, workspace)
  const response = await dap.removeBreakpoint(file, input.line, signal, requestTimeoutMs)
  const text = formatBreakpoints(file, response.breakpoints)
  return makeDebugOutput('remove_breakpoint', text, acc(response.snapshot), maxResultChars)
}

/** Set one instruction breakpoint and render the list. */
async function handleSetInstructionBreakpoint(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  requireCapability(dap, 'supportsInstructionBreakpoints', 'instruction breakpoints')
  const instructionReference = requireBreakpointInput('instruction', input)
  const response = await dap.setInstructionBreakpoint(
    instructionReference,
    input.offset,
    input.condition,
    input.hit_condition,
    signal,
    requestTimeoutMs,
  )
  const text = formatInstructionBreakpoints(response.breakpoints)
  return makeDebugOutput('set_instruction_breakpoint', text, acc(response.snapshot), maxResultChars)
}

/** Remove one instruction breakpoint and render the list. */
async function handleRemoveInstructionBreakpoint(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  requireCapability(dap, 'supportsInstructionBreakpoints', 'instruction breakpoints')
  const instructionReference = requireBreakpointInput('instruction', input)
  const response = await dap.removeInstructionBreakpoint(
    instructionReference,
    input.offset,
    signal,
    requestTimeoutMs,
  )
  const text = formatInstructionBreakpoints(response.breakpoints)
  return makeDebugOutput('remove_instruction_breakpoint', text, acc(response.snapshot), maxResultChars)
}

/** Report data-breakpoint information for a variable or data name. */
async function handleDataBreakpointInfo(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  requireCapability(dap, 'supportsDataBreakpoints', 'data breakpoints')
  if (!input.name) throw new Error('name is required for data_breakpoint_info')
  const response = await dap.dataBreakpointInfo(
    input.name,
    input.variable_ref ?? input.scope_id,
    input.frame_id,
    signal,
    requestTimeoutMs,
  )
  const text = formatDataBreakpointInfo(response.info)
  return makeDebugOutput('data_breakpoint_info', text, acc(response.snapshot), maxResultChars)
}

/** Set one data breakpoint and render the list. */
async function handleSetDataBreakpoint(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  requireCapability(dap, 'supportsDataBreakpoints', 'data breakpoints')
  const dataId = requireBreakpointInput('data-id', input)
  const response = await dap.setDataBreakpoint(
    dataId,
    input.access_type,
    input.condition,
    input.hit_condition,
    signal,
    requestTimeoutMs,
  )
  const text = formatDataBreakpoints(response.breakpoints)
  return makeDebugOutput('set_data_breakpoint', text, acc(response.snapshot), maxResultChars)
}

/** Remove one data breakpoint and render the list. */
async function handleRemoveDataBreakpoint(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  requireCapability(dap, 'supportsDataBreakpoints', 'data breakpoints')
  const dataId = requireBreakpointInput('data-id', input)
  const response = await dap.removeDataBreakpoint(dataId, signal, requestTimeoutMs)
  const text = formatDataBreakpoints(response.breakpoints)
  return makeDebugOutput('remove_data_breakpoint', text, acc(response.snapshot), maxResultChars)
}

/**
 * Continue or step, then render the resulting execution state; the four
 * actions share one code path and differ only in the service call and verb.
 */
async function handleContinueOrStep(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  // Call through the service object (never a detached reference, which
  // would lose `this` on the prototype-backed delegating service).
  const outcome =
    input.action === 'continue'
      ? await dap.continue(signal, requestTimeoutMs)
      : input.action === 'step_over'
        ? await dap.stepOver(signal, requestTimeoutMs)
        : input.action === 'step_in'
          ? await dap.stepIn(signal, requestTimeoutMs)
          : await dap.stepOut(signal, requestTimeoutMs)
  const verb =
    input.action === 'continue'
      ? 'Continue'
      : input.action === 'step_over'
        ? 'Step over'
        : input.action === 'step_in'
          ? 'Step in'
          : 'Step out'
  const lines = formatSessionSnapshot(outcome.snapshot)
  if (outcome.timedOut) {
    lines.push(
      `Program is still running after ${Math.round(requestTimeoutMs / 1000)}s. Use pause to interrupt and inspect state.`,
    )
  } else if (outcome.state === 'stopped') {
    const location =
      outcome.snapshot.source?.path && outcome.snapshot.line !== undefined
        ? `${outcome.snapshot.source.path}:${outcome.snapshot.line}`
        : 'unknown location'
    lines.push(`${verb} stopped at ${location}.`)
  } else if (outcome.state === 'terminated') {
    lines.push(
      `Program terminated${outcome.snapshot.exitCode !== undefined ? ` with exit code ${outcome.snapshot.exitCode}` : ''}.`,
    )
  } else {
    lines.push('Program is running.')
  }
  const text = lines.join('\n')
  return makeDebugOutput(
    input.action,
    text,
    { ...acc(outcome.snapshot), state: outcome.state, timedOut: outcome.timedOut },
    maxResultChars,
  )
}

/** Pause the program and render the stop snapshot. */
async function handlePause(ctx: DebugDispatchContext, _input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  const snapshot = await dap.pause(signal, requestTimeoutMs)
  const text = [...formatSessionSnapshot(snapshot), 'Program paused.'].join('\n')
  return makeDebugOutput('pause', text, acc(snapshot), maxResultChars)
}

/** Evaluate an expression in a frame or global context. */
async function handleEvaluate(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  if (!input.expression) throw new Error('expression is required for evaluate')
  const evaluationContext: DapEvaluateArguments['context'] =
    (input.context as DapEvaluateArguments['context']) ?? 'repl'
  const response = await dap.evaluate(input.expression, evaluationContext, input.frame_id, signal, requestTimeoutMs)
  const text = formatEvaluation(response.evaluation ?? { result: '', variablesReference: 0 })
  return makeDebugOutput('evaluate', text, acc(response.snapshot), maxResultChars)
}

/** Render the current thread's stack frames. */
async function handleStackTrace(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  const response = await dap.stackTrace(input.levels, signal, requestTimeoutMs)
  const text = formatStackFrames(response.stackFrames)
  return makeDebugOutput('stack_trace', text, acc(response.snapshot), maxResultChars)
}

/** Render the debuggee's threads. */
async function handleThreads(ctx: DebugDispatchContext, _input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  const response = await dap.threads(signal, requestTimeoutMs)
  const text = formatThreads(response.threads)
  return makeDebugOutput('threads', text, acc(response.snapshot), maxResultChars)
}

/** Render the variables of one stack frame's scopes. */
async function handleScopes(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  const response = await dap.scopes(input.frame_id, signal, requestTimeoutMs)
  const text = formatScopes(response.scopes)
  return makeDebugOutput('scopes', text, acc(response.snapshot), maxResultChars)
}

/** Render the members of one scope or variable reference. */
async function handleVariables(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  const variableReference = input.variable_ref ?? input.scope_id
  if (variableReference === undefined) {
    throw new Error('variables requires variable_ref or scope_id')
  }
  const response = await dap.variables(variableReference, signal, requestTimeoutMs)
  const text = formatVariables(response.variables)
  return makeDebugOutput('variables', text, acc(response.snapshot), maxResultChars)
}

/** Render disassembled instructions around the stop location or a reference. */
async function handleDisassemble(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  requireCapability(dap, 'supportsDisassembleRequest', 'disassembly')
  if (input.instruction_count === undefined) throw new Error('instruction_count is required for disassemble')
  const response = await dap.disassemble(
    resolveDisassemblyReference(dap, input.memory_reference),
    input.instruction_count,
    input.offset,
    input.instruction_offset,
    input.resolve_symbols,
    signal,
    requestTimeoutMs,
  )
  const text = formatDisassembly(response.instructions)
  return makeDebugOutput('disassemble', text, acc(response.snapshot), maxResultChars)
}

/** Read debuggee memory and render the bytes. */
async function handleReadMemory(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  requireCapability(dap, 'supportsReadMemoryRequest', 'memory reads')
  if (!input.memory_reference) throw new Error('memory_reference is required for read_memory')
  if (input.count === undefined) throw new Error('count is required for read_memory')
  const response = await dap.readMemory(input.memory_reference, input.count, input.offset, signal, requestTimeoutMs)
  const text = formatMemoryRead(response.address, response.data, response.unreadableBytes)
  return makeDebugOutput('read_memory', text, acc(response.snapshot), maxResultChars)
}

/** Write bytes into debuggee memory and render the write result. */
async function handleWriteMemory(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  requireCapability(dap, 'supportsWriteMemoryRequest', 'memory writes')
  if (!input.memory_reference) throw new Error('memory_reference is required for write_memory')
  if (!input.data) throw new Error('data is required for write_memory')
  const response = await dap.writeMemory(
    input.memory_reference,
    input.data,
    input.offset,
    input.allow_partial,
    signal,
    requestTimeoutMs,
  )
  const text = [
    'Memory write completed.',
    ...(response.bytesWritten !== undefined ? [`Bytes written: ${response.bytesWritten}`] : []),
    ...(response.offset !== undefined ? [`Offset: ${response.offset}`] : []),
  ].join('\n')
  return makeDebugOutput('write_memory', text, acc(response.snapshot), maxResultChars)
}

/** Render the loaded modules of the debuggee. */
async function handleModules(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  requireCapability(dap, 'supportsModulesRequest', 'module introspection')
  const response = await dap.modules(input.start_module, input.module_count, signal, requestTimeoutMs)
  const text = formatModules(response.modules)
  return makeDebugOutput('modules', text, acc(response.snapshot), maxResultChars)
}

/** Render the sources loaded by the debuggee. */
async function handleLoadedSources(ctx: DebugDispatchContext, _input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  requireCapability(dap, 'supportsLoadedSourcesRequest', 'loaded sources')
  const response = await dap.loadedSources(signal, requestTimeoutMs)
  const text = formatLoadedSources(response.sources)
  return makeDebugOutput('loaded_sources', text, acc(response.snapshot), maxResultChars)
}

/** Issue a raw DAP request and render its response body. */
async function handleCustomRequest(ctx: DebugDispatchContext, input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  if (!input.command) throw new Error('command is required for custom_request')
  const response = await dap.customRequest(input.command, input.arguments, signal, requestTimeoutMs)
  const text = formatCustomResponse(input.command, response.body)
  return makeDebugOutput('custom_request', text, acc(response.snapshot), maxResultChars)
}

/** Render the output captured from the debuggee so far. */
// oxlint-disable-next-line typescript/require-await -- async keeps the uniform handler signature; the underlying dap read is synchronous.
async function handleOutput(ctx: DebugDispatchContext): Promise<DebugToolOutput> {
  const { dap, maxResultChars } = ctx
  const response = dap.getOutput()
  const text = response.output.length > 0 ? response.output : '(no output captured)'
  return makeDebugOutput('output', text, { ...acc(response.snapshot), output: response.output }, maxResultChars)
}

/** Terminate the active debug session, if any. */
async function handleTerminate(ctx: DebugDispatchContext, _input: DebugToolArgs): Promise<DebugToolOutput> {
  const { dap, signal, requestTimeoutMs, maxResultChars } = ctx
  const snapshot = await dap.terminate(signal, requestTimeoutMs)
  if (!snapshot) {
    return makeDebugOutput('terminate', 'No debug session to terminate.', {}, maxResultChars)
  }
  const text = [...formatSessionSnapshot(snapshot), 'Debug session terminated.'].join('\n')
  return makeDebugOutput('terminate', text, acc(snapshot), maxResultChars)
}

/** Render every known debug session of this harness process. */
// oxlint-disable-next-line typescript/require-await -- async keeps the uniform handler signature; the underlying dap read is synchronous.
async function handleSessions(ctx: DebugDispatchContext): Promise<DebugToolOutput> {
  const { dap, maxResultChars } = ctx
  const sessions = dap.listSessions()
  const text = formatSessions(sessions)
  return makeDebugOutput('sessions', text, { sessions: sessions.map(projectSession) }, maxResultChars)
}
