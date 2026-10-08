/**
 * mine_sessions ranks candidate sessions by lesson density and annotates each
 * stored lesson with the session's turn/end-derived outcome: an errored
 * session outranks a quieter recency rival, equal scores keep the recency
 * order, the per-run caps still bound the digest, and the rendered learned.md
 * line carries the outcome as a context suffix.
 */

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LEARNED_FILE } from '@deepseek-ai/dsh-memory'
import * as Memory from '@deepseek-ai/dsh-memory'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import { mineOutcomeOf, mineScoreOf, mineSignalsOf } from '../src/session-history.ts'

const CWD = '/ws/mine'

interface FixtureEvent { type: string; seq?: number; data?: unknown }
interface FixtureSession { id: string; createdAt: number; events: FixtureEvent[] }

/** Structural `sessionQuery` stand-in backed by in-memory fixture sessions. */
class FakeSessionQuery extends Service {
  constructor(ctx: Context, private readonly sessions: FixtureSession[], private readonly unreadable: string[] = []) {
    super(ctx, 'sessionQuery')
  }

  async filterSessions(): Promise<Array<{ header: { id: string; createdAt: number } }>> {
    return this.sessions.map(({ id, createdAt }) => ({ header: { id, createdAt } }))
  }

  async readSession(id: string): Promise<{ session: { id: string; createdAt: number }; events: readonly FixtureEvent[] }> {
    if (this.unreadable.includes(id)) throw new Error(`fixture session ${id} is unreadable`)
    const session = this.sessions.find(candidate => candidate.id === id)
    if (session === undefined) throw new Error(`no fixture session ${id}`)
    return { session: { id: session.id, createdAt: session.createdAt }, events: session.events }
  }

  async readTitle(id: string): Promise<string> {
    return `Title ${id}`
  }

  async searchSessions(): Promise<{ items: readonly never[] }> {
    return { items: [] }
  }
}

async function mount(
  sessions: FixtureSession[],
  unreadable: string[] = [],
  config: Record<string, unknown> = {},
  { query = true } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mine-sessions-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Memory, { root })
  await ctx.plugin(ToolMemory, { root, ...config })
  if (query) new FakeSessionQuery(ctx, sessions, unreadable)
  return { ctx, root }
}

const agent = { session: { header: { id: 's1', cwd: CWD } } }

let callCounter = 0
async function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: agent as never,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

/** learned.md of the fixture project — where mined lessons are rendered. */
async function learnedText(ctx: Context): Promise<string> {
  const status = await ctx.memory.status({ cwd: CWD })
  return readFile(join(status.scope ?? '', LEARNED_FILE), 'utf8')
}

const id32 = (seed: string): string => seed.padEnd(32, '0')

const turnEnd = (turn: number, kind: string, message?: string): FixtureEvent => ({
  type: 'turn/end',
  data: { turn, reason: kind === 'error' ? { kind, error: { code: 'E_TEST', message: message ?? 'boom' } } : { kind } },
})

const digestEvent = (text: string): FixtureEvent => ({
  type: 'compaction/summary',
  data: { summary: [{ type: 'text', text }] },
})

describe('mine ranking signals', () => {
  it('counts failures, digests, and completed todos in one pass', () => {
    const signals = mineSignalsOf([
      turnEnd(1, 'error'),
      turnEnd(2, 'completed'),
      turnEnd(3, 'aborted'),
      { type: 'tool/result', data: { message: { isError: true } } },
      digestEvent('s'),
      { type: 'todo/write', data: { todos: [{ content: 'x', status: 'completed' }] } },
      { type: 'todo/write', data: { todos: [{ content: 'y', status: 'pending' }] } },
      { type: 'compaction/summary', data: { summary: [] } },
      { type: 'turn/start', data: { turn: 4 } },
    ])
    expect(signals).toEqual({ failedTurns: 1, abortedTurns: 1, completedTurns: 1, toolFailures: 1, digests: 1, completedTodos: 1 })
  })

  it('scores lesson density: an errored session outranks a quiet one', () => {
    const errored = mineScoreOf({ failedTurns: 2, abortedTurns: 0, completedTurns: 1, toolFailures: 1, digests: 1, completedTodos: 0 })
    expect(errored).toBe(4)
    const quiet = mineScoreOf({ failedTurns: 0, abortedTurns: 0, completedTurns: 9, toolFailures: 0, digests: 0, completedTodos: 0 })
    expect(errored).toBeGreaterThan(quiet)
  })

  it('renders the terse outcome with singular and plural forms', () => {
    expect(mineOutcomeOf({ failedTurns: 1, abortedTurns: 0, completedTurns: 0, toolFailures: 0, digests: 0, completedTodos: 0 })).toBe('errored: 1 failed turn')
    expect(mineOutcomeOf({ failedTurns: 3, abortedTurns: 0, completedTurns: 0, toolFailures: 0, digests: 0, completedTodos: 0 })).toBe('errored: 3 failed turns')
    expect(mineOutcomeOf({ failedTurns: 0, abortedTurns: 2, completedTurns: 0, toolFailures: 0, digests: 0, completedTodos: 0 })).toBe('aborted')
    expect(mineOutcomeOf({ failedTurns: 0, abortedTurns: 0, completedTurns: 5, toolFailures: 0, digests: 0, completedTodos: 0 })).toBe('completed')
    const noSignals = mineOutcomeOf({ failedTurns: 0, abortedTurns: 0, completedTurns: 0, toolFailures: 0, digests: 0, completedTodos: 0 })
    expect(noSignals).toBeUndefined()
  })
})

describe('mine_sessions over a fake sessionQuery', () => {
  it('digests an errored session over a quieter newer rival', async () => {
    const { ctx } = await mount([
      { id: id32('quiet'), createdAt: 2_000, events: [digestEvent('quiet summary text')] },
      { id: id32('err'), createdAt: 1_000, events: [turnEnd(1, 'error', 'database is locked'), digestEvent('errored summary text')] },
    ], [], { mineSessionLimit: 1, mineCandidateLimit: 2 })
    const result = await call(ctx, 'mine_sessions', {})
    expect((result.value as { sessions: number }).sessions).toBe(1)
    const learned = await learnedText(ctx)
    expect(learned).toContain('errored summary text')
    expect(learned).toContain('database is locked')
    expect(learned).not.toContain('quiet summary text')
  })

  it('breaks score ties by recency', async () => {
    const { ctx } = await mount([
      { id: id32('olderr'), createdAt: 1_000, events: [turnEnd(1, 'error', 'older failure text')] },
      { id: id32('newerr'), createdAt: 2_000, events: [turnEnd(1, 'error', 'newer failure text')] },
    ], [], { mineSessionLimit: 1, mineCandidateLimit: 2 })
    await call(ctx, 'mine_sessions', {})
    const learned = await learnedText(ctx)
    expect(learned).toContain('newer failure text')
    expect(learned).not.toContain('older failure text')
  })

  it('annotates each stored lesson with the session outcome', async () => {
    const { ctx } = await mount([
      { id: id32('errses'), createdAt: 2_000, events: [turnEnd(1, 'error', 'first failure'), turnEnd(2, 'error', 'second failure'), digestEvent('annotated summary')] },
      { id: id32('doneses'), createdAt: 1_000, events: [turnEnd(1, 'completed'), digestEvent('finished summary')] },
    ], [], { mineSessionLimit: 2, mineCandidateLimit: 2 })
    await call(ctx, 'mine_sessions', {})
    const learned = await learnedText(ctx)
    expect(learned).toMatch(/_\(context: Title \S+ · errored: 2 failed turns\)_/)
    expect(learned).toMatch(/_\(context: Title \S+ · completed\)_/)
    expect(learned).toContain('annotated summary')
    expect(learned).toContain('finished summary')
  })

  it('honors the per-run lesson cap', async () => {
    const { ctx } = await mount([
      { id: id32('cap'), createdAt: 1_000, events: [digestEvent('first cap text'), digestEvent('second cap text'), digestEvent('third cap text')] },
    ], [], { mineLessonLimit: 2 })
    const result = await call(ctx, 'mine_sessions', {})
    expect((result.value as { mined: number }).mined).toBe(2)
    const learned = await learnedText(ctx)
    expect(learned).toContain('first cap text')
    expect(learned).toContain('second cap text')
    expect(learned).not.toContain('third cap text')
  })

  it('digests an explicit session_id without ranking but still annotates', async () => {
    const { ctx } = await mount([
      { id: id32('quiet'), createdAt: 2_000, events: [digestEvent('quiet summary text')] },
      { id: id32('explicit'), createdAt: 1_000, events: [turnEnd(1, 'aborted'), digestEvent('explicit summary text')] },
    ])
    const result = await call(ctx, 'mine_sessions', { session_id: id32('explicit') })
    expect((result.value as { sessions: number }).sessions).toBe(1)
    const learned = await learnedText(ctx)
    expect(learned).toContain('explicit summary text')
    expect(learned).toContain('· aborted)_')
    expect(learned).not.toContain('quiet summary text')
  })

  it('skips sessions that fail to read and keeps mining the rest', async () => {
    const { ctx } = await mount([
      { id: id32('ghost'), createdAt: 2_000, events: [digestEvent('ghost summary text')] },
      { id: id32('real'), createdAt: 1_000, events: [digestEvent('real summary text')] },
    ], [id32('ghost')])
    const result = await call(ctx, 'mine_sessions', {})
    expect((result.value as { sessions: number }).sessions).toBe(1)
    const learned = await learnedText(ctx)
    expect(learned).toContain('real summary text')
    expect(learned).not.toContain('ghost summary text')
  })

  it('degrades to an unavailable notice without the sessionQuery service', async () => {
    const { ctx } = await mount([], [], {}, { query: false })
    const result = await call(ctx, 'mine_sessions', {})
    expect(text(result)).toContain('unavailable')
  })
})
