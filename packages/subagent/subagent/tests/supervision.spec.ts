/**
 * The keyed open-decisions hardening: durable ledger persistence + restart
 * rehydration, wake coalescing, and wedge supervision.
 *
 * @module dsh-subagent/supervision-spec
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentConfig } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  diagnoseWedge,
  isWedgeDecisionKey,
  wedgeDecisionKey,
  wedgeDecisionSummary,
} from '../src/supervision.ts'

/** Adapter whose entries can hold a model call open until the test releases it. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private script: { chunks: StreamChunk[]; gate?: Promise<undefined> }[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('GatedAdapter: script exhausted')
    if (entry.gate) await entry.gate
    for (const chunk of entry.chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const testSignal = new AbortController().signal

/** Tracked persistence roots cleaned up after each test. */
const roots: { root: string; dispose?: () => Promise<void> }[] = []
afterEach(async () => {
  for (const tracked of roots.splice(0)) {
    try {
      await tracked.dispose?.()
    } finally {
      rmSync(tracked.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
})

interface Booted {
  ctx: Context
  parent: Agent
  adapter: MockAdapter | GatedAdapter
  root: string
  disposePersistence: () => Promise<void>
}

/** Boot one full host onto a persistence root with the given config. */
async function boot(
  root: string,
  adapter: MockAdapter | GatedAdapter,
  config: SubagentConfig = {},
  options: { parkParent?: boolean; resumeParent?: boolean } = {},
): Promise<Booted> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root })
  let disposed = false
  const disposePersistence = async () => {
    if (disposed) return
    disposed = true
    await persistenceFiber.dispose()
  }
  roots.push({ root, dispose: disposePersistence })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime, config)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = options.resumeParent === true
    ? (await ctx.agents.resume({
      resumeSessionId: SessionId('parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    : ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  if (options.parkParent !== false) parkParent(ctx, parent)
  return { ctx, parent, adapter, root, disposePersistence }
}

function setupWith(adapter: MockAdapter | GatedAdapter, config: SubagentConfig = {}, options: { parkParent?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-supervision-'))
  return boot(root, adapter, config, options)
}

/** Reject every step of the stand-in parent so wakes never run a turn. */
function parkParent(ctx: Context, parent: Agent): void {
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent.id !== parent.id) return next()
    return { kind: 'reject' }
  })
}

function startSpec(parent: Agent, label = 'worker') {
  return {
    provider: 'spawn',
    label,
    request: { prompt: [{ type: 'text' as const, text: 'worker task' }], parent },
    signal: testSignal,
  }
}

async function liveAgent(ctx: Context, childId: SessionId): Promise<NonNullable<ReturnType<typeof ctx.agents.get>>> {
  return vi.waitFor(() => {
    const live = ctx.agents.get(childId)
    expect(live).toBeDefined()
    return live as NonNullable<typeof live>
  })
}

async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  })
}

/** Every parent-session log entry carrying a given message source kind. */
function wakesOf(ctx: Context, parentId: SessionId, kind: string): { text: string; childIds?: string[] }[] {
  const session = ctx.sessions.get(parentId)
  if (session === undefined) return []
  const found: { text: string; childIds?: string[] }[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    const entry = event.data as { content: { type: string; text: string }[]; source: { kind: string; childIds?: string[] } }
    if (entry.source.kind !== kind) continue
    const text = entry.content.filter(block => block.type === 'text').map(block => block.text).join('')
    found.push({ text, ...entry.source.childIds !== undefined ? { childIds: entry.source.childIds } : {} })
  }
  return found
}

/** The durable `subagent/decision` events on a session log. */
function decisionEvents(
  ctx: Context,
  sessionId: SessionId,
): { phase: string; childId: string; key: string; status?: string; summary?: string }[] {
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) return []
  return session.snapshotEvents()
    .filter(event => event.type === 'subagent/decision')
    .map(event => event.data as { phase: string; childId: string; key: string; status?: string; summary?: string })
}

describe('subagent decision ledger durability', () => {
  it('appends open and resolve mutations to the parent session', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: [], gate: release.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await liveAgent(ctx, started.childId)

    await ctx.subagents.reportFrom(child, [{ type: 'text', text: 'I need a decision' }], {
      delivery: 'quiet',
      signal: testSignal,
      report: { status: 'needs-decision', summary: 'Pick a port', decisionKey: 'port' },
    })
    const opens = decisionEvents(ctx, parent.id).filter(ev => ev.phase === 'open')
    expect(opens).toHaveLength(1)
    expect(opens[0]).toMatchObject({
      phase: 'open',
      childId: started.childId.toString(),
      key: 'port',
      status: 'needs-decision',
      summary: 'Pick a port',
    })

    expect(ctx.subagents.resolveOpenDecision(parent, started.childId, 'port')).toBe(true)
    const resolves = decisionEvents(ctx, parent.id).filter(ev => ev.phase === 'resolve')
    expect(resolves).toHaveLength(1)
    expect(resolves[0]).toMatchObject({ phase: 'resolve', childId: started.childId.toString(), key: 'port' })
    release.resolve(undefined)
    release.resolve(undefined)
  })

  it('rehydrates the ledger across a host restart', async () => {
    const release = Promise.withResolvers<undefined>()
    const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-supervision-'))
    const first = await boot(root, new GatedAdapter([{ chunks: [], gate: release.promise }]), {
      supervisorTickMs: 0,
    })
    const started = await first.ctx.subagents.startContinuable(startSpec(first.parent))
    const child = await liveAgent(first.ctx, started.childId)
    await first.ctx.subagents.reportFrom(child, [{ type: 'text', text: 'needs input' }], {
      delivery: 'quiet',
      signal: testSignal,
      report: { status: 'blocked', summary: 'Need the target path', decisionKey: 'target-path' },
    })
    // Durable flush, then close the store before "restarting".
    const parentSession = first.ctx.sessions.get(first.parent.id)
    if (parentSession !== undefined) await first.ctx.sessions.flush(parentSession)
    await first.disposePersistence()

    // A fresh host reads the SAME persistence root: the ledger must rebuild
    // from the parent's durable events without any new child report. `resume`
    // is the real restart path — a rebooted host adopts the persisted session.
    const second = await boot(root, new MockAdapter([]), {}, { resumeParent: true })
    const reopened = second.ctx.subagents.listOpenDecisions(second.parent)
    expect(reopened).toEqual([expect.objectContaining({
      childId: started.childId,
      key: 'target-path',
      status: 'blocked',
      summary: 'Need the target path',
    })])
    expect(reopened[0]?.wedge).toBeUndefined()

    // Resolving on the restarted host records the durable close.
    expect(second.ctx.subagents.resolveOpenDecision(second.parent, started.childId, 'target-path')).toBe(true)
    expect(second.ctx.subagents.listOpenDecisions(second.parent)).toEqual([])
    release.resolve(undefined)
    release.resolve(undefined)
  })
})

describe('subagent decision wake coalescing', () => {
  it('delivers ONE waking notice for a burst of decision reports', async () => {
    const releaseA = Promise.withResolvers<undefined>()
    const releaseB = Promise.withResolvers<undefined>()
    // The parent is left LIVE (not parked) so its steered wake steps run and
    // the notice lands in its log; the last entry answers each wake.
    const adapter = new GatedAdapter([
      { chunks: [], gate: releaseA.promise },
      { chunks: [], gate: releaseB.promise },
      { chunks: textResponse('ok') },
    ])
    const { ctx, parent } = await setupWith(adapter, { wakeCoalesceMs: 250, supervisorTickMs: 0 }, { parkParent: false })
    const a = await ctx.subagents.startContinuable(startSpec(parent, 'alpha'))
    const b = await ctx.subagents.startContinuable(startSpec(parent, 'beta'))
    const childA = await liveAgent(ctx, a.childId)
    const childB = await liveAgent(ctx, b.childId)

    await ctx.subagents.reportFrom(childA, [{ type: 'text', text: 'A text' }], {
      delivery: 'next-step',
      signal: testSignal,
      report: { status: 'needs-decision', summary: 'Choose option A', decisionKey: 'choose-a' },
    })
    await ctx.subagents.reportFrom(childB, [{ type: 'text', text: 'B text' }], {
      delivery: 'next-step',
      signal: testSignal,
      report: { status: 'needs-decision', summary: 'Choose option B', decisionKey: 'choose-b' },
    })

    // Both decisions are durable and owed exactly once…
    const opens = decisionEvents(ctx, parent.id).filter(ev => ev.phase === 'open')
    expect(opens.map(ev => ev.key).sort()).toEqual(['choose-a', 'choose-b'])
    // …and the WAKE is still pending inside the debounce window.
    expect(wakesOf(ctx, parent.id, 'subagent-decisions')).toHaveLength(0)

    ctx.subagents.flushDecisionWakes(parent.id)
    const wakes = await vi.waitFor(() => {
      const found = wakesOf(ctx, parent.id, 'subagent-decisions')
      expect(found).toHaveLength(1)
      return found
    })
    expect(wakes[0]?.text).toContain('choose-a')
    expect(wakes[0]?.text).toContain('choose-b')
    expect(wakes[0]?.childIds).toEqual([a.childId.toString(), b.childId.toString()])

    const owed = ctx.subagents.listOpenDecisions(parent)
    expect(owed.map(entry => entry.key).sort()).toEqual(['choose-a', 'choose-b'])
    releaseA.resolve(undefined)
    releaseB.resolve(undefined)
  })

  it('keeps one wake per report when the coalescing window is zero', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: [], gate: release.promise },
      { chunks: textResponse('a') },
      { chunks: textResponse('b') },
    ])
    const { ctx, parent } = await setupWith(adapter, { wakeCoalesceMs: 0, supervisorTickMs: 0 }, { parkParent: false })
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await liveAgent(ctx, started.childId)

    await ctx.subagents.reportFrom(child, [{ type: 'text', text: 'one' }], {
      delivery: 'next-step',
      signal: testSignal,
      report: { status: 'needs-decision', summary: 'Decision one', decisionKey: 'd1' },
    })
    await ctx.subagents.reportFrom(child, [{ type: 'text', text: 'two' }], {
      delivery: 'next-step',
      signal: testSignal,
      report: { status: 'needs-decision', summary: 'Decision two', decisionKey: 'd2' },
    })

    const wakes = await vi.waitFor(() => {
      const found = wakesOf(ctx, parent.id, 'subagent-decisions')
      expect(found.length).toBeGreaterThanOrEqual(2)
      return found
    })
    expect(wakes).toHaveLength(2)
    expect(wakes.every(wake => wake.childIds?.length === 1)).toBe(true)
    release.resolve(undefined)
    release.resolve(undefined)
  })
})

describe('subagent wedge supervision', () => {
  it('diagnoses a stalled running child but never a live or active-stream child', () => {
    const config = { wedgeStaleMs: 60_000, wedgeCoolDownMs: 0, staleDecisionNotifyMs: 0, staleDecisionReNotifyMs: 0 }
    const base = {
      childId: 'c1', parentSession: 'p', label: 'worker', lastProgress: 0, activeStream: false,
      running: true, wedgeOutstanding: false,
    }
    const now = 100_000
    // Ownerless sentinel progress (0) means "never progressed": the full span
    // counts as idle.
    expect(diagnoseWedge({ ...base, lastProgress: 0 }, now, config)).toEqual({ kind: 'stale', idleForMs: 100_000 })
    // 10s idle is below the 60s threshold: clean.
    expect(diagnoseWedge({ ...base, lastProgress: 90_000 }, now, config)).toEqual({ kind: 'clean' })
    // Fresh progress, a live model call, or an idle agent are never wedged.
    expect(diagnoseWedge({ ...base, lastProgress: 99_999 }, now, config)).toEqual({ kind: 'clean' })
    expect(diagnoseWedge({ ...base, lastProgress: 0, activeStream: true }, now, config)).toEqual({ kind: 'clean' })
    expect(diagnoseWedge({ ...base, lastProgress: 0, running: false }, now, config)).toEqual({ kind: 'clean' })
  })

  it('builds wedge keys and summaries with admission context', () => {
    expect(wedgeDecisionKey('c1')).toBe('wedge:c1')
    expect(isWedgeDecisionKey('wedge:c1')).toBe(true)
    expect(isWedgeDecisionKey('wedge:c1', 'c1')).toBe(true)
    expect(isWedgeDecisionKey('wedge:c1', 'other')).toBe(false)
    expect(isWedgeDecisionKey('choose-a')).toBe(false)
    const summary = wedgeDecisionSummary(
      { childId: 'c1', parentSession: 'p', label: 'worker', lastProgress: 5_000, activeStream: false, running: true, wedgeOutstanding: false },
      30_000,
      { running: 2, waiting: 1, capacity: 3 },
    )
    expect(summary).toContain('made no progress for 30s')
    expect(summary).toContain('Host model slots: 2/3 running, 1 waiting')
  })

  it('raises one wedge decision for a child stuck in a hung tool and respects the cool-down', async () => {
    const adapter = new MockAdapter([toolCallResponse('call-hang', 'hang', {})])
    const { ctx, parent } = await setupWith(adapter, {
      wedgeStaleMs: 5,
      supervisorTickMs: 0,
      wedgeCoolDownMs: 1_000,
      staleDecisionNotifyMs: 0,
    })
    // Install a never-resolving tool into every continuable child.
    ctx.subagents.registerContinuableSetup((childCtx) => {
      childCtx.tools.register(defineTool({
        name: 'hang',
        description: 'never resolves',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: false, properties: {} },
          render: () => [],
        },
        async execute(): Promise<never> {
          await new Promise(() => { /* hang forever */ })
          throw new Error('unreachable')
        },
      }))
      return () => {}
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const childId = started.childId
    // The model issued the tool call; let the loop enter tool execution.
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))
    await new Promise(resolve => setTimeout(resolve, 50))

    const first = ctx.subagents.runSupervision(Date.now() + 10_000)
    expect(first.wedges.map(probe => probe.childId)).toEqual([childId.toString()])

    const raised = ctx.subagents.listOpenDecisions(parent)
    expect(raised).toEqual([expect.objectContaining({
      childId,
      key: `wedge:${childId.toString()}`,
      status: 'blocked',
      wedge: true,
    })])
    expect(raised[0]?.summary).toContain('made no progress')

    // Resolving starts the cool-down: no re-raise while it runs (1000ms).
    expect(ctx.subagents.resolveOpenDecision(parent, childId, `wedge:${childId.toString()}`)).toBe(true)
    const during = ctx.subagents.runSupervision(Date.now() + 500)
    expect(during.wedges).toHaveLength(0)
    expect(ctx.subagents.listOpenDecisions(parent)).toEqual([])
  })

  it('never flags a child inside a live model call as wedged', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: textResponse('done'), gate: release.promise }])
    const { ctx, parent } = await setupWith(adapter, { wedgeStaleMs: 5, supervisorTickMs: 0 })
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(1))

    // A far-future pass with the stream still held must not raise a wedge.
    const pass = ctx.subagents.runSupervision(Date.now() + 60_000)
    expect(pass.wedges).toHaveLength(0)
    expect(ctx.subagents.listOpenDecisions(parent)).toEqual([])

    release.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('re-notifies a decision left open past the stale threshold, throttled', async () => {
    const release = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([{ chunks: [], gate: release.promise }])
    const { ctx, parent } = await setupWith(adapter, {
      supervisorTickMs: 0,
      wedgeStaleMs: 0,
      staleDecisionNotifyMs: 50,
    })
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await liveAgent(ctx, started.childId)
    await ctx.subagents.reportFrom(child, [{ type: 'text', text: 'stale decision' }], {
      delivery: 'quiet',
      signal: testSignal,
      report: { status: 'needs-decision', summary: 'Left unanswered', decisionKey: 'stale-key' },
    })
    // Drive the pass with a far-future `now` so the decision reads as stale.
    const pass = ctx.subagents.runSupervision(Date.now() + 60_000)
    expect(pass.staleNotified).toBe(1)
    // Within the re-notify cool-down no second notice for the same key.
    const again = ctx.subagents.runSupervision(Date.now() + 60_000)
    expect(again.staleNotified).toBe(0)
    release.resolve(undefined)
    release.resolve(undefined)
  })
})
