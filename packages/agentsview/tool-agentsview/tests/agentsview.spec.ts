/**
 * `@deepseek-ai/dsh-tool-agentsview` tests: hermetic coverage of the pure
 * argv/flag mapping, env building, JSON parsing, payload truncation and the
 * mounted tool surface over a fake `agentsview` shim, plus the CLI-availability
 * probe.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  applyAgentsviewTools,
  AgentsviewCliError,
  renderPayload,
  buildAgentsviewArgv,
  parseAgentsviewJson,
  buildAgentsviewEnv,
} from '../src/agentsview.ts'
import { buildAgentsviewPromptSection } from '../src/prompt.ts'
import { checkAgentsviewCli } from '../src/cli-check.ts'

const dirs: string[] = []
let ctx: Context
let counter = 0

// The Vitest invariant host mounts this package's `src/invariant.ts` companion
// on the first plugin in each test root, which probes `<cli> version --json`
// against PATH. A deployment has the binary; hermetic tests emulate that by
// exposing a PATH-level probe shim (the per-test `cliPath` shims are separate).
let probeDir: string
let originalPath: string | undefined

beforeAll(async () => {
  originalPath = process.env.PATH
  probeDir = await mkdtemp(join(tmpdir(), 'dsh-tool-agentsview-path-'))
  const probe = join(probeDir, 'agentsview')
  await writeFile(probe, SHIM, 'utf8')
  await chmod(probe, 0o755)
  process.env.PATH = `${probeDir}${delimiter}${originalPath ?? ''}`
})

afterAll(async () => {
  if (originalPath === undefined) {
    delete process.env.PATH
  } else {
    process.env.PATH = originalPath
  }
  await rm(probeDir, { recursive: true, force: true })
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true })))
})

async function makeDir(tag: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `dsh-tool-agentsview-${tag}-`))
  dirs.push(path)
  return path
}

async function writeShim(dir: string, script: string): Promise<string> {
  const path = join(dir, 'agentsview')
  await writeFile(path, script, 'utf8')
  await chmod(path, 0o755)
  return path
}

// Shim: mirrors the real CLI surface for the actions we wrap. Structured
// commands answer with `--format json` documents; recall actions answer with
// human text; `version --json` powers the availability probe.
const SHIM = `#!/bin/bash
if [ "$1" = "version" ] && [ "$2" = "--json" ]; then
  echo '{"version":"0.42.0-test"}'
  exit 0
fi
if [ "$1" = "session" ] && [ "$2" = "list" ] && [[ "$*" == *bad-project* ]]; then
  echo "unknown project: bad-project" >&2
  exit 1
fi
case "$1:$2" in
  session:list)
    echo '{"sessions":[{"id":"s1","health_grade":"B","outcome":"completed","title":"demo","agent":"deepseek-harness"}]}'
    exit 0 ;;
  session:get)
    echo '{"id":"s1","health_grade":"B","outcome":"completed","tool_failure_signals":1,"compaction_count":2}'
    exit 0 ;;
  session:usage)
    echo '{"id":"s1","total_cost_usd":1.23,"total_input_tokens":100,"total_output_tokens":50}'
    exit 0 ;;
  session:search)
    echo '{"hits":[{"session_id":"s1","ordinal":5,"snippet":"found it"}]}'
    exit 0 ;;
  health:*)
    echo '{"sessions":[{"id":"s1","grade":"B","outcome":"completed"}]}'
    exit 0 ;;
  stats:*)
    echo '{"schema_version":1,"sessions":10,"output_tokens":999}'
    exit 0 ;;
  usage:daily)
    echo '{"days":[{"date":"2026-09-01","cost_usd":0.42}]}'
    exit 0 ;;
  export:sessions)
    echo '{"schema_version":6,"archive_id":"a1","sessions":[{"id":"s1"}]}'
    exit 0 ;;
  recall:query)
    echo "recall answer for: $3"
    exit 0 ;;
  recall:brief)
    echo "packed brief for: $3"
    exit 0 ;;
  *)
    echo "unexpected invocation: $*" >&2
    exit 9 ;;
esac
`

const agent = { session: { header: { id: 'av1', cwd: '' } } } as never

async function call<T>(name: string, args: unknown): Promise<T> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`av-${++counter}`),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) {
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
    throw new Error(text || 'tool failed')
  }
  return (result as unknown as { value: T }).value
}

async function setup(shimPath: string, toolConfig: Parameters<typeof applyAgentsviewTools>[1] = {}) {
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  applyAgentsviewTools(ctx, { ...toolConfig, cliPath: shimPath })
  ctx.systemPrompt.section(buildAgentsviewPromptSection())
}

describe('pure helpers', () => {
  it('buildAgentsviewArgv maps every action and flag', () => {
    expect(buildAgentsviewArgv('list', { action: 'list' })).toEqual(['session', 'list', '--format', 'json'])
    expect(buildAgentsviewArgv('list', {
      action: 'list', limit: 5, project: '/repo/x', agent: 'deepseek-harness',
      includeAutomated: true, includeOneShot: true, includeChildren: true,
    })).toEqual([
      'session', 'list', '--format', 'json',
      '--limit', '5', '--project', '/repo/x', '--agent', 'deepseek-harness',
      '--include-automated', '--include-one-shot', '--include-children',
    ])
    expect(buildAgentsviewArgv('get', { action: 'get', sessionId: 's1' })).toEqual(['session', 'get', 's1', '--format', 'json'])
    expect(buildAgentsviewArgv('sessionUsage', { action: 'sessionUsage', sessionId: 's1', ownOnly: true }))
      .toEqual(['session', 'usage', 's1', '--format', 'json', '--own-only'])
    expect(buildAgentsviewArgv('health', { action: 'health' })).toEqual(['health', '--format', 'json'])
    expect(buildAgentsviewArgv('health', { action: 'health', sessionId: 's1', limit: 50 }))
      .toEqual(['health', 's1', '--format', 'json', '--limit', '50'])
    expect(buildAgentsviewArgv('stats', {
      action: 'stats', since: '28d', until: '2026-09-06', agent: 'a', includeProjects: ['p1', 'p2'],
    })).toEqual([
      'stats', '--format', 'json',
      '--since', '28d', '--until', '2026-09-06', '--agent', 'a',
      '--include-project', 'p1', '--include-project', 'p2',
    ])
    expect(buildAgentsviewArgv('usage', { action: 'usage', since: '14d', all: true, breakdown: true }))
      .toEqual(['usage', 'daily', '--format', 'json', '--since', '14d', '--all', '--breakdown'])
    expect(buildAgentsviewArgv('search', { action: 'search', query: 'useful tool', mode: 'substring' }))
      .toEqual(['session', 'search', 'useful tool', '--format', 'json'])
    expect(buildAgentsviewArgv('search', { action: 'search', query: 'q', mode: 'regex' }))
      .toEqual(['session', 'search', 'q', '--format', 'json', '--regex'])
    expect(buildAgentsviewArgv('search', { action: 'search', query: 'q', mode: 'fts', limit: 10 }))
      .toEqual(['session', 'search', 'q', '--format', 'json', '--fts', '--limit', '10'])
    expect(buildAgentsviewArgv('search', {
      action: 'search', query: 'q', mode: 'hybrid', excludeSession: 's9',
    })).toEqual(['session', 'search', 'q', '--format', 'json', '--hybrid', '--exclude-session', 's9'])
    expect(buildAgentsviewArgv('recallQuery', { action: 'recallQuery', query: 'what did I do' }))
      .toEqual(['recall', 'query', 'what did I do'])
    expect(buildAgentsviewArgv('recallBrief', { action: 'recallBrief', query: 'ship release' }))
      .toEqual(['recall', 'brief', 'ship release'])
    expect(buildAgentsviewArgv('exportSessions', {
      action: 'exportSessions', limit: 100, cursor: 'abc',
      project: '/repo/x', outcome: 'completed,abandoned', healthGrade: 'A,B',
      minToolFailures: 2, since: '2026-08-01', until: '2026-09-06',
    })).toEqual([
      'export', 'sessions', '--format', 'json',
      '--limit', '100', '--cursor', 'abc', '--project', '/repo/x',
      '--outcome', 'completed,abandoned', '--health-grade', 'A,B',
      '--min-tool-failures', '2', '--date-from', '2026-08-01', '--date-to', '2026-09-06',
    ])
  })

  it('buildAgentsviewArgv rejects actions missing required ids/queries', () => {
    expect(() => buildAgentsviewArgv('get', { action: 'get' })).toThrow(/sessionId is required/)
    expect(() => buildAgentsviewArgv('search', { action: 'search' })).toThrow(/query is required/)
    expect(() => buildAgentsviewArgv('recallBrief', { action: 'recallBrief' })).toThrow(/query is required/)
  })

  it('buildAgentsviewEnv maps sessionDirs to DEEPSEEK_HARNESS_SESSIONS_DIR', () => {
    const env = buildAgentsviewEnv({ sessionDirs: ['/a', '/b'] }, { HOME: '/home' })
    expect(env.DEEPSEEK_HARNESS_SESSIONS_DIR).toBe(['/a', '/b'].join(delimiter))
    expect(env.HOME).toBe('/home')
    expect(buildAgentsviewEnv({}, { HOME: '/home' })).toEqual({ HOME: '/home' })
  })

  it('renderPayload stringifies JSON and truncates over the cap', () => {
    expect(renderPayload({ a: 1 }, 200000)).toBe('{"a":1}')
    expect(renderPayload('plain', 200000)).toBe('"plain"')
    const text = renderPayload({ big: 'x'.repeat(100) }, 50)
    expect(text).toContain('...(truncated by tool-agentsview')
  })

  it('AgentsviewCliError carries invocation diagnostics', () => {
    const err = new AgentsviewCliError('boom', ['session', 'list'], 'out', 'err', 1)
    expect(err.name).toBe('AgentsviewCliError')
    expect(err.args).toEqual(['session', 'list'])
    expect(err.exitCode).toBe(1)
  })

  it('parseAgentsviewJson parses JSON and rejects non-JSON output', () => {
    expect(parseAgentsviewJson({ stdout: '{"ok":1}\n', stderr: '', exitCode: 0 })).toEqual({ ok: 1 })
    expect(() => parseAgentsviewJson({ stdout: 'boom', stderr: '', exitCode: 0 }))
      .toThrow(/non-JSON output/)
  })

  it('buildAgentsviewPromptSection toggles on enabled', () => {
    expect(buildAgentsviewPromptSection().text.length).toBeGreaterThan(0)
    expect(buildAgentsviewPromptSection({ enabled: false }).text).toBe('')
  })
})

describe('agentsview tool over a shim CLI', () => {
  it('registers the agentsview tool over the shim', async () => {
    const dir = await makeDir('surface')
    await setup(await writeShim(dir, SHIM))
    expect(ctx.tools.get('agentsview')).toBeDefined()
  })

  it('list parses the JSON document', async () => {
    const dir = await makeDir('list')
    await setup(await writeShim(dir, SHIM))
    const value = await call<{ text: string }>('agentsview', { action: 'list', limit: 5 })
    expect(value.text).toContain('"health_grade":"B"')
  })

  it('get / sessionUsage / health / stats / usage / search / exportSessions parse JSON documents', async () => {
    const dir = await makeDir('structured')
    await setup(await writeShim(dir, SHIM))
    const get = await call<{ text: string }>('agentsview', { action: 'get', sessionId: 's1' })
    expect(get.text).toContain('"outcome":"completed"')
    const usage = await call<{ text: string }>('agentsview', { action: 'sessionUsage', sessionId: 's1', ownOnly: true })
    expect(usage.text).toContain('"total_cost_usd":1.23')
    const health = await call<{ text: string }>('agentsview', { action: 'health', limit: 20 })
    expect(health.text).toContain('"grade":"B"')
    const stats = await call<{ text: string }>('agentsview', { action: 'stats', since: '7d' })
    expect(stats.text).toContain('"sessions":10')
    const daily = await call<{ text: string }>('agentsview', { action: 'usage', breakdown: true })
    expect(daily.text).toContain('"cost_usd":0.42')
    const search = await call<{ text: string }>('agentsview', { action: 'search', query: 'tool', mode: 'fts' })
    expect(search.text).toContain('"snippet":"found it"')
    const exportS = await call<{ text: string }>('agentsview', { action: 'exportSessions', limit: 10 })
    expect(exportS.text).toContain('"schema_version":6')
  })

  it('recallQuery / recallBrief return human text', async () => {
    const dir = await makeDir('recall')
    await setup(await writeShim(dir, SHIM))
    const q = await call<{ text: string }>('agentsview', { action: 'recallQuery', query: 'what did I do' })
    expect(q.text).toBe('recall answer for: what did I do')
    const b = await call<{ text: string }>('agentsview', { action: 'recallBrief', query: 'ship release' })
    expect(b.text).toBe('packed brief for: ship release')
  })

  it('surfaces a nonzero CLI exit as an AgentsviewCliError', async () => {
    const dir = await makeDir('cli-error')
    await setup(await writeShim(dir, SHIM))
    await expect(call('agentsview', { action: 'list', project: 'bad-project' }))
      .rejects.toThrow(/exited with code 1/)
  })

  it('a missing CLI resolves to a not-found error', async () => {
    const dir = await makeDir('missing')
    await setup(join(dir, 'does-not-exist'))
    await expect(call('agentsview', { action: 'list' })).rejects.toThrow(/not found/)
  })
})

describe('availability probe', () => {
  it('resolves when the shim reports a version', async () => {
    const dir = await makeDir('probe-ok')
    await expect(checkAgentsviewCli(await writeShim(dir, SHIM))).resolves.toBeUndefined()
  })

  it('rejects with an install hint when the binary is missing', async () => {
    const dir = await makeDir('probe-missing')
    await expect(checkAgentsviewCli(join(dir, 'nope'))).rejects.toThrow(/Install the agentsview CLI/)
  })

  it('probe availability via execFile fallback matches the repo convention', async () => {
    const dir = await makeDir('probe-real')
    const shim = await writeShim(dir, SHIM)
    const ok = await new Promise<boolean>((resolve) => {
      execFile(shim, ['version', '--json'], { timeout: 8000 }, (err) => { resolve(!err) })
    })
    expect(ok).toBe(true)
  })
})
