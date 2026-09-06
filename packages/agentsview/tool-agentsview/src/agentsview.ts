/**
 * Model-facing agentsview CLI access over the local `agentsview` binary:
 * session list/get, health (grades + outcome signals), windowed stats,
 * daily token-cost usage, per-session usage, transcript search (incl. fts,
 * semantic, hybrid), the recall query/brief surfaces, and content-free
 * session export — one spawn per call, against the same local SQLite archive
 * the agentsview daemon maintains from the DeepSeek Harness session store.
 *
 * The CLI already parses DSH `session.jsonl.zstd` files (multi-frame, torn
 * tails, compaction duplicates), so this seam is read-only over the same
 * source files the harness writes: no DSH code changes, no index to maintain.
 * @module @deepseek-ai/dsh-tool-agentsview/agentsview
 */

import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Tool-level configuration (all optional; defaults apply). */
export interface AgentsviewToolConfig {
  /** CLI executable (default `agentsview` on PATH). */
  cliPath?: string
  /**
   * DeepSeek Harness session roots passed to the CLI through
   * `DEEPSEEK_HARNESS_SESSIONS_DIR`. When omitted, the CLI's own defaults
   * apply (it honors `DSH_HOME` -> `<home>/sessions`).
   */
  sessionDirs?: string[]
  /** Per-call process timeout in ms (default 120000; first calls sync the archive). */
  timeoutMs?: number
  /** Cap on rendered JSON payload chars before truncation (default 200000). */
  maxChars?: number
}

/** Raised when the CLI exits non-zero, refuses an action, or returns unreadable output. */
export class AgentsviewCliError extends Error {
  /** CLI invocation that failed. */
  readonly args: string[]
  /** Captured stdout (may hold a partial report). */
  readonly stdout: string
  /** Captured stderr (progress noise plus human errors). */
  readonly stderr: string
  /** Process exit code, or null when no process ran (e.g. ENOENT). */
  readonly exitCode: number | null

  constructor(message: string, args: string[], stdout: string, stderr: string, exitCode: number | null) {
    super(message)
    this.name = 'AgentsviewCliError'
    this.args = args
    this.stdout = stdout
    this.stderr = stderr
    this.exitCode = exitCode
  }
}

/** Tool actions; each maps to one agentsview CLI invocation. */
export type AgentsviewAction =
  | 'list'
  | 'get'
  | 'sessionUsage'
  | 'health'
  | 'stats'
  | 'usage'
  | 'search'
  | 'recallQuery'
  | 'recallBrief'
  | 'exportSessions'

export const AGENTSVIEW_ACTIONS: readonly AgentsviewAction[] = [
  'list', 'get', 'sessionUsage', 'health', 'stats', 'usage', 'search', 'recallQuery', 'recallBrief', 'exportSessions',
]

/** Tool arguments. Only the fields relevant to the chosen action are used. */
export interface AgentsviewArgs {
  action: AgentsviewAction
  /** get/sessionUsage/health-detail: session id from `agentsview session list` / export. */
  sessionId?: string
  /** search/recallQuery/recallBrief: the query text or task brief. */
  query?: string
  /** search: retrieval mode; `substring` is the CLI default (no mode flag). */
  mode?: 'substring' | 'regex' | 'fts' | 'semantic' | 'hybrid'
  /** list/health/search/exportSessions: result cap. */
  limit?: number
  /** list/exportSessions: project filter. */
  project?: string
  /** list/stats/usage: agent filter. */
  agent?: string
  /** stats/usage: window start (`28d` or `YYYY-MM-DD`); exportSessions: `--date-from`. */
  since?: string
  /** stats/usage: window end (`YYYY-MM-DD`); exportSessions: `--date-to`. */
  until?: string
  /** list: include automated sessions (excluded by default). */
  includeAutomated?: boolean
  /** list: include one-shot sessions (excluded by default). */
  includeOneShot?: boolean
  /** list: include subagent/child sessions (excluded by default). */
  includeChildren?: boolean
  /** sessionUsage: exclude subagent transcripts from the attribution. */
  ownOnly?: boolean
  /** usage: scan full history instead of the default 30-day window. */
  all?: boolean
  /** usage: show per-model rows and populate JSON breakdown arrays. */
  breakdown?: boolean
  /** search: drop matches from this session before the cap. */
  excludeSession?: string
  /** exportSessions: comma-separated outcome filter (completed/abandoned/errored/unknown). */
  outcome?: string
  /** exportSessions: comma-separated health grade filter (A..F). */
  healthGrade?: string
  /** exportSessions: minimum tool-failure signal count. */
  minToolFailures?: number
  /** exportSessions: opaque cursor from a previous response. */
  cursor?: string
  /** stats: repeatable project allowlist. */
  includeProjects?: string[]
}

/** Result value shape for the tool (JSON text or human report text). */
export interface AgentsviewToolValue {
  /** The rendered report (JSON text for structured actions, human text for recall). */
  text: string
}

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

/** Build the child-process env: inherit plus session-root override. */
export function buildAgentsviewEnv(config: AgentsviewToolConfig, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!config.sessionDirs || config.sessionDirs.length === 0) return base
  return { ...base, DEEPSEEK_HARNESS_SESSIONS_DIR: config.sessionDirs.join(delimiter) }
}

/** Run the CLI once; stdout/stderr/exit-code are returned as-is. */
export function runAgentsviewCli(
  cmd: string,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    execFile(cmd, args, {
      timeout: options.timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
      env: options.env,
    }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ stdout, stderr, exitCode: 0 })
        return
      }
      const e = err as unknown as { code?: number | string }
      const code = typeof e.code === 'number' ? e.code : null
      if (code === null && e.code === 'ENOENT') {
        reject(new AgentsviewCliError(
          `agentsview CLI not found (\`${cmd}\`). Install it from https://agentsview.io/install.sh (or \`brew install --cask agentsview\`) or set config.cliPath.`,
          args, stdout, stderr, code))
        return
      }
      const tail = stderr.trim().slice(0, 400)
      reject(new AgentsviewCliError(
        `agentsview CLI exited with ${code === null ? 'unknown error' : `code ${code}`}${tail ? `: ${tail}` : ''}`,
        args, stdout, stderr, code))
    })
  })
}

/**
 * Build the CLI argv for an action. Pure so tests assert exact flag mapping.
 * @param action - the tool action.
 * @param args - tool arguments (optional fields only; per-action validation lives in execute).
 */
export function buildAgentsviewArgv(action: AgentsviewAction, args: AgentsviewArgs): string[] {
  const a = args
  switch (action) {
    case 'list': {
      const argv = ['session', 'list', '--format', 'json']
      if (a.limit !== undefined) argv.push('--limit', String(a.limit))
      if (a.project !== undefined) argv.push('--project', a.project)
      if (a.agent !== undefined) argv.push('--agent', a.agent)
      if (a.includeAutomated === true) argv.push('--include-automated')
      if (a.includeOneShot === true) argv.push('--include-one-shot')
      if (a.includeChildren === true) argv.push('--include-children')
      return argv
    }
    case 'get':
      return ['session', 'get', requireSessionId(a), '--format', 'json']
    case 'sessionUsage': {
      const argv = ['session', 'usage', requireSessionId(a), '--format', 'json']
      if (a.ownOnly === true) argv.push('--own-only')
      return argv
    }
    case 'health': {
      const argv = ['health']
      if (a.sessionId !== undefined) argv.push(a.sessionId)
      argv.push('--format', 'json')
      if (a.limit !== undefined) argv.push('--limit', String(a.limit))
      return argv
    }
    case 'stats': {
      const argv = ['stats', '--format', 'json']
      if (a.since !== undefined) argv.push('--since', a.since)
      if (a.until !== undefined) argv.push('--until', a.until)
      if (a.agent !== undefined) argv.push('--agent', a.agent)
      for (const p of a.includeProjects ?? []) argv.push('--include-project', p)
      return argv
    }
    case 'usage': {
      const argv = ['usage', 'daily', '--format', 'json']
      if (a.since !== undefined) argv.push('--since', a.since)
      if (a.until !== undefined) argv.push('--until', a.until)
      if (a.agent !== undefined) argv.push('--agent', a.agent)
      if (a.all === true) argv.push('--all')
      if (a.breakdown === true) argv.push('--breakdown')
      return argv
    }
    case 'search': {
      const argv = ['session', 'search', requireQuery(a), '--format', 'json']
      switch (a.mode ?? 'substring') {
        case 'regex': argv.push('--regex'); break
        case 'fts': argv.push('--fts'); break
        case 'semantic': argv.push('--semantic'); break
        case 'hybrid': argv.push('--hybrid'); break
        case 'substring': break
      }
      if (a.limit !== undefined) argv.push('--limit', String(a.limit))
      if (a.excludeSession !== undefined) argv.push('--exclude-session', a.excludeSession)
      return argv
    }
    case 'recallQuery':
      return ['recall', 'query', requireQuery(a)]
    case 'recallBrief':
      return ['recall', 'brief', requireQuery(a)]
    case 'exportSessions': {
      const argv = ['export', 'sessions', '--format', 'json']
      if (a.limit !== undefined) argv.push('--limit', String(a.limit))
      if (a.cursor !== undefined) argv.push('--cursor', a.cursor)
      if (a.project !== undefined) argv.push('--project', a.project)
      if (a.outcome !== undefined) argv.push('--outcome', a.outcome)
      if (a.healthGrade !== undefined) argv.push('--health-grade', a.healthGrade)
      if (a.minToolFailures !== undefined) argv.push('--min-tool-failures', String(a.minToolFailures))
      if (a.since !== undefined) argv.push('--date-from', a.since)
      if (a.until !== undefined) argv.push('--date-to', a.until)
      return argv
    }
  }
}

function requireSessionId(a: AgentsviewArgs): string {
  if (!a.sessionId) throw new AgentsviewCliError('sessionId is required for this action', [], '', '', null)
  return a.sessionId
}

function requireQuery(a: AgentsviewArgs): string {
  if (!a.query) throw new AgentsviewCliError('query is required for this action', [], '', '', null)
  return a.query
}

/** Parse a `--format json` stdout document. */
export function parseAgentsviewJson(run: RunResult): unknown {
  const text = run.stdout.trim()
  try {
    return JSON.parse(text)
  } catch {
    throw new AgentsviewCliError(
      'agentsview CLI returned non-JSON output (expected JSON for this action)',
      [], run.stdout, run.stderr, run.exitCode)
  }
}

/**
 * Render a JSON payload into the tool result text, truncating when it exceeds
 * the cap so oversized reports cannot blow the session context.
 * @param payload - parsed CLI payload.
 * @param maxChars - truncation cap.
 * @returns the rendered text.
 */
export function renderPayload(payload: unknown, maxChars: number): string {
  const text = payload === undefined ? '' : JSON.stringify(payload)
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...(truncated by tool-agentsview: payload was ${text.length} chars; narrow the query or page with limit/cursor)`
}

/** A structured action resolves to JSON and renders as a JSON document. */
const STRUCTURED = new Set<AgentsviewAction>(['list', 'get', 'sessionUsage', 'health', 'stats', 'usage', 'search', 'exportSessions'])

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
  },
} as const

/**
 * Register the agentsview tool (the prompt section is added by the index
 * plugin; this stays separable for tests).
 * @param ctx - Cordis context carrying `tools`.
 * @param config - tool-level configuration (CLI path/roots/timeouts/caps).
 */
export function applyAgentsviewTools(ctx: Context, config: AgentsviewToolConfig = {}): void {
  const cmd = config.cliPath ?? 'agentsview'
  const timeoutMs = config.timeoutMs ?? 120000
  const maxChars = config.maxChars ?? 200000
  const env = buildAgentsviewEnv(config)

  const runAction = async (args: AgentsviewArgs): Promise<AgentsviewToolValue> => {
    const argv = buildAgentsviewArgv(args.action, args)
    const run = await runAgentsviewCli(cmd, argv, { timeoutMs, env })
    if (STRUCTURED.has(args.action)) {
      if (run.exitCode !== 0) {
        throw new AgentsviewCliError(
          `agentsview CLI exited with code ${run.exitCode}: ${(run.stderr || run.stdout).trim().slice(0, 300)}`,
          argv, run.stdout, run.stderr, run.exitCode)
      }
      return { text: renderPayload(parseAgentsviewJson(run), maxChars) }
    }
    // Human surfaces (recall query/brief) use the CLI text as-is.
    const text = (run.stdout || '').trim()
    if (run.exitCode !== 0 || text === '') {
      throw new AgentsviewCliError(
        `agentsview CLI failed for ${args.action}${run.stderr ? `: ${run.stderr.trim().slice(0, 300)}` : ''}`,
        argv, run.stdout, run.stderr, run.exitCode)
    }
    return { text: text.slice(0, maxChars) }
  }

  void ctx

  ctx.tools.register(defineTool({
    name: 'agentsview',
    device: true,
    description:
      'Query the local agentsview archive of DeepSeek Harness sessions (the agentsview CLI already parses DSH session.jsonl.zstd logs): session list/get with health grades and outcome signals, windowed workspace analytics (`stats`), daily token/cost reports (`usage`), per-session cost (`sessionUsage`), transcript search including semantic/hybrid modes (`search`), the experimental recall query/brief over distilled session knowledge, and content-free analytics export. Reads the same session store the harness writes; the first call may sync the archive.',
    parameters: {
      action: { type: 'string', required: true, enum: [...AGENTSVIEW_ACTIONS], description: 'The agentsview CLI surface to query. `list` = session list (health/outcome columns). `get` = one session metadata + signals. `sessionUsage` = token usage and cost for one session. `health` = recent sessions with grade/outcome, or one session detail when `sessionId` is set. `stats` = window-scoped workspace analytics. `usage` = daily token/cost report. `search` = transcript content search (mode: substring|regex|fts|semantic|hybrid). `recallQuery` = query the distilled recall corpus. `recallBrief` = packed trust-brief for a task. `exportSessions` = content-free session summary export (JSON).' },
      sessionId: { type: 'string', description: 'get/sessionUsage/health-detail: session id (from `list` or export).' },
      query: { type: 'string', description: 'search/recallQuery/recallBrief: query text or task brief (required for those actions).' },
      mode: { type: 'string', enum: ['substring', 'regex', 'fts', 'semantic', 'hybrid'], description: 'search: retrieval mode; default substring. `semantic`/`hybrid` require the vector index to be built (agentsview `embeddings build`).' },
      limit: { type: 'integer', description: 'list/health/search/exportSessions: result cap.' },
      project: { type: 'string', description: 'list/exportSessions: project filter (path or name).' },
      agent: { type: 'string', description: 'list/stats/usage: agent filter.' },
      since: { type: 'string', description: 'stats/usage: window start (`28d` or `YYYY-MM-DD`); exportSessions: active-on-or-after date (`--date-from`).' },
      until: { type: 'string', description: 'stats/usage/exportSessions: window end (`YYYY-MM-DD`); exportSessions uses `--date-to`.' },
      includeAutomated: { type: 'boolean', description: 'list: include automated sessions (excluded by default).' },
      includeOneShot: { type: 'boolean', description: 'list: include one-shot sessions (excluded by default).' },
      includeChildren: { type: 'boolean', description: 'list: include subagent/child sessions (excluded by default).' },
      ownOnly: { type: 'boolean', description: 'sessionUsage: exclude subagent transcripts from cost attribution.' },
      all: { type: 'boolean', description: 'usage: scan full history instead of the default 30-day window.' },
      breakdown: { type: 'boolean', description: 'usage: per-model rows and JSON breakdown arrays.' },
      excludeSession: { type: 'string', description: 'search: drop matches from this session before the cap.' },
      outcome: { type: 'string', description: 'exportSessions: comma-separated outcome filter (completed/abandoned/errored/unknown).' },
      healthGrade: { type: 'string', description: 'exportSessions: comma-separated health grade filter (A..F).' },
      minToolFailures: { type: 'integer', description: 'exportSessions: minimum tool-failure signal count.' },
      cursor: { type: 'string', description: 'exportSessions: opaque cursor from a previous response for paging.' },
      includeProjects: { type: 'array', items: { type: 'string' }, description: 'stats: project allowlist (repeatable).' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      return await runAction(args)
    },
  }))
}
