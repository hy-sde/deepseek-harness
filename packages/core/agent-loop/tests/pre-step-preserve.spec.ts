/**
 * Claimed-inbox preservation across a failed or aborted `agent/pre-step`.
 *
 * The inbox claim durably removes the user's input before any pre-step hook
 * runs (system-prompt assembly, automatic compaction, message transforms). If
 * that pre-step is aborted or throws, `step/start` never fires, so the normal
 * step-start append never records the prompt — today the message simply
 * vanished from the session. These tests pin the recovery append: the
 * claimed input is persisted as a surface `user/message` before the failure
 * rethrows, so no prompt is ever silently lost.
 * @module dsh-agent-loop/tests/pre-step-preserve
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function userTexts(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((event): event is Extract<SessionEvent, { type: 'user/message' }> => event.type === 'user/message')
    .flatMap(event => event.data.content)
    .flatMap(block => block.type === 'text' ? [block.text] : [])
}

describe('claimed prompt preservation across a failed/aborted pre-step', () => {
  it('persists the claimed prompt durably when a long-running pre-step is aborted by the user', async () => {
    const adapter = new MockAdapter([textResponse('reply')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('pre-step-abort'), { provider: 'mock', model: 'mock' })

    // Hang the pre-step waterfall (compaction is the real-world occupant of
    // this seat) until the turn's cancellation signal fires.
    ctx.on('agent/pre-step', ({ signal }, next) => {
      const abortError = (): Error => new Error('pre-step aborted', { cause: signal.reason })
      return new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(abortError())
          return
        }
        signal.addEventListener('abort', () => { reject(abortError()) }, { once: true })
      }).then(() => next())
    })

    send(agent, 'my prompt')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(userTexts(agent)).toEqual([])
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle()

    // The prompt is NOT lost: it is on the surface even though the turn it
    // opened was aborted before its first step.
    expect(userTexts(agent)).toEqual(['my prompt'])
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'user' } })
    expect(adapter.requests).toHaveLength(0)
  })

  it('persists the claimed prompt durably when a pre-step hook throws', async () => {
    const adapter = new MockAdapter([textResponse('reply')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('pre-step-throw'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/pre-step', async () => {
      throw new Error('pre-step failure')
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'still mine')
    await idle

    expect(userTexts(agent)).toEqual(['still mine'])
    const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind === 'error').toBe(true)
    expect(adapter.requests).toHaveLength(0)
  })

  it('leaves the successful path untouched: one durable record, transformed content wins', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('pre-step-ok'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/pre-step', async ({ messages }) => ({
      kind: 'enter' as const,
      messages: [{ ...messages[0]!, content: [{ type: 'text', text: 'REWRITTEN' }] }],
    }))

    const idle = waitForIdle(ctx, agent)
    send(agent, 'original')
    await idle

    // Exactly one durable record of the prompt, carrying the transformed text.
    expect(userTexts(agent)).toEqual(['REWRITTEN'])
    expect(adapter.requests).toHaveLength(1)
  })
})
