/**
 * Model-facing `debug` tool over `ctx.dap`. One tool, 28 operations: launch/
 * attach, source/function/instruction/data breakpoints, continue/pause/step,
 * threads/stackTrace/scopes/variables/evaluate, disassembly, memory access,
 * modules, captured output, termination, and session listing. It resolves
 * paths against the session workspace, requires an active session for stateful
 * operations, converts request timeouts into abort signals, and renders every
 * result through `render.ts`. It runtime-injects `tools`, `dap`, and
 * `systemPrompt`, and imports no provider.
 *
 * Namespace plugin (named exports, no default export).
 * @module @deepseek-ai/dsh-tool-debug
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  presentDebugCall,
  DEBUG_OUTPUT_SCHEMA,
  DEBUG_ACTIONS,
} from './render.ts'
import { sessionCwd } from './session.ts'
import { dispatchDebugAction } from './dispatch.ts'
import { isDebugAction } from './types.ts'
import type { DebugToolArgs } from './types.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-debug'

/** Services required by this plugin. */
export const inject = ['tools', 'dap', 'systemPrompt']

/** Default per-request timeout (seconds) when the model omits `timeout`. */
export const DEFAULT_DEBUG_REQUEST_TIMEOUT_SEC = 30

/** Default whole-tool-call timeout budget (ms) for `dsh-tool-call-timeout-policy`. */
export const DEFAULT_DEBUG_TOOL_TIMEOUT_MS = 120_000

/** The stable system-prompt guidance positioning the debug tool. */
export const DEBUG_PROMPT_TEXT =
  'Use debug to attach a real debugger (gdb/lldb-dap/debugpy/dlv/...) to a process: launch or attach, set breakpoints, then continue/step, inspect threads/stack/scopes/variables, evaluate expressions, read memory, and terminate. Debug sessions are exclusive — terminate a session before launching another. Breakpoints must be set before continuing after a stop.'

/** Plugin configuration: result caps and timeout budgets. */
export interface Config {
  /** Largest complete rendered result in characters (default 16000). */
  maxResultChars?: number
  /** Default per-request timeout in seconds (default 30). */
  requestTimeoutSec?: number
  /** Whole-tool-call timeout budget in ms (default 120000). */
  timeoutMs?: number
}

const DEFAULT_MAX_RESULT_CHARS = 16_000

export const Config: z<Config> = z.object({
  maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
  requestTimeoutSec: z.number().default(DEFAULT_DEBUG_REQUEST_TIMEOUT_SEC),
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_DEBUG_TOOL_TIMEOUT_MS),
})

type ResolvedConfig = Required<Config>

/**
 * Register the `debug` tool and its system-prompt guidance.
 * @param ctx - the plugin context (must inject `tools`, `dap`, `systemPrompt`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxResultChars', resolved.maxResultChars)
  assertPositiveInteger('requestTimeoutSec', resolved.requestTimeoutSec)
  assertTimer('timeoutMs', resolved.timeoutMs)

  ctx.systemPrompt.section({ name: 'tool:debug', order: 128, text: DEBUG_PROMPT_TEXT })

  ctx.tools.register(defineTool({
    name: 'debug',
    device: true,
    description:
      'Attach a real debugger to a running or launched process through the Debug Adapter Protocol (DAP). 28 operations: launch, attach, set/remove_breakpoint (source or function), set/remove_instruction_breakpoint, data_breakpoint_info, set/remove_data_breakpoint, continue, step_over, step_in, step_out, pause, evaluate, stack_trace, threads, scopes, variables, disassemble, read_memory, write_memory, modules, loaded_sources, custom_request, output, terminate, sessions. One active session at a time — terminate before launching another.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [...DEBUG_ACTIONS],
        description: 'The debug operation to perform.',
      },
      program: { type: 'string', description: 'Debug target path; Delve accepts Go package directories.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Program arguments for launch.' },
      adapter: { type: 'string', description: 'Configured adapter id (gdb, lldb-dap, debugpy, dlv, ... or a dap.json entry).' },
      cwd: { type: 'string', description: 'Call working directory; defaults to the session workspace.' },
      file: { type: 'string', description: 'Source file (breakpoint operations).' },
      line: { type: 'number', description: 'Source line (breakpoint operations).' },
      function: { type: 'string', description: 'Function name (breakpoint operations).' },
      name: { type: 'string', description: 'Variable or data name (data_breakpoint_info).' },
      condition: { type: 'string', description: 'Breakpoint condition expression.' },
      hit_condition: { type: 'string', description: 'Breakpoint hit count condition.' },
      expression: { type: 'string', description: 'Expression to evaluate.' },
      context: { type: 'string', enum: ['watch', 'repl', 'hover', 'variables', 'clipboard'], description: 'Evaluate context (default repl).' },
      frame_id: { type: 'number', description: 'Stack frame id (scopes/evaluate).' },
      scope_id: { type: 'number', description: 'Scope variables reference (variables).' },
      variable_ref: { type: 'number', description: 'Variable reference (variables).' },
      pid: { type: 'number', description: 'Process id for attach.' },
      port: { type: 'number', description: 'Remote attach port.' },
      host: { type: 'string', description: 'Remote attach host (default localhost).' },
      levels: { type: 'number', description: 'Max stack frames for stack_trace.' },
      memory_reference: { type: 'string', description: 'Memory reference or address.' },
      instruction_reference: { type: 'string', description: 'Instruction reference for set_instruction_breakpoint.' },
      instruction_count: { type: 'number', description: 'Instructions to disassemble.' },
      instruction_offset: { type: 'number' },
      count: { type: 'number', description: 'Bytes to read for read_memory.' },
      data: { type: 'string', description: 'Base64 memory payload for write_memory.' },
      data_id: { type: 'string', description: 'Data breakpoint id.' },
      access_type: { type: 'string', enum: ['read', 'write', 'readWrite'], description: 'Data breakpoint access type.' },
      command: { type: 'string', description: 'Custom DAP request command.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Custom request arguments.' },
      offset: { type: 'number', description: 'Byte offset for memory operations.' },
      resolve_symbols: { type: 'boolean' },
      allow_partial: { type: 'boolean' },
      start_module: { type: 'number' },
      module_count: { type: 'number' },
      timeout: { type: 'number', description: 'Per-request timeout in seconds (default 30).' },
    },
    output: {
      schema: DEBUG_OUTPUT_SCHEMA,
      render: (_args, value) => {
        const output = value as DebugToolOutputLike
        return [{ type: 'text', text: output.message ?? '(no output)' }]
      },
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const input = parseDebugArgs(args)
      const workspace = sessionCwd(exec)
      if (workspace === undefined) {
        throw new Error('the debug tool requires a session workspace cwd')
      }
      const requestTimeoutMs = (input.timeout ?? resolved.requestTimeoutSec) * 1000
      const timeoutSignal = AbortSignal.timeout(requestTimeoutMs)
      const combinedSignal = AbortSignal.any([exec.signal, timeoutSignal])

      return dispatchDebugAction(
        { dap: ctx.dap, workspace, signal: combinedSignal, requestTimeoutMs, maxResultChars: resolved.maxResultChars },
        input,
      )
    },
    presentCall: presentDebugCall,
  }))
}

/** Narrow name for the render closure (the schema rejects extra fields at runtime anyway). */
type DebugToolOutputLike = { readonly message?: string }

/**
 * Validate and normalize raw model arguments into `DebugToolArgs`.
 * @param args - the raw model arguments.
 * @returns the normalized debug tool arguments.
 */
export function parseDebugArgs(args: unknown): DebugToolArgs {
  if (args === null || typeof args !== 'object') {
    throw new Error('debug arguments must be an object')
  }
  const raw = args as Record<string, unknown>
  if (!isDebugAction(raw.action)) {
    throw new Error(`action must be one of ${DEBUG_ACTIONS.join(', ')}`)
  }
  return { ...raw, action: raw.action }
}


/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-debug: ${name} must be a positive integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-debug: ${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

// Internal helper kept exported for tests and derived packages.
export type { DebugToolArgs } from './types.ts'
export {
  DEBUG_ACTIONS,
  DEBUG_OUTPUT_SCHEMA,
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
  presentDebugCall,
  summarizeDebugCall,
} from './render.ts'
export type { GenericCallView } from '@deepseek-ai/dsh-tools'
