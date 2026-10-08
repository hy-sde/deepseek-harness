import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolEdit from '@deepseek-ai/dsh-tool-edit'
import { toolCwdFromExec } from '../src/session.ts'

const contexts: Context[] = []
const roots: string[] = []
let callNumber = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function agentWithCwd(ctx: Context, cwd: string): Agent {
  const id = SessionId(`tool-edit-cwd-${++callNumber}`)
  const scope = ctx.plugin(() => { })
  const session = Session.create(id, [], { version: 4, id, createdAt: 0, cwd, isSeeded: false })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: createInboxStub(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => { },
    followup: () => { },
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => { },
    cancel() { },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

describe('edit tool working directory', () => {
  it('prefers the owning session header cwd over the harness process cwd', () => {
    const id = SessionId('tool-edit-cwd-unit')
    const session = Session.create(id, [], { version: 4, id, createdAt: 0, cwd: '/tmp/lease-lane', isSeeded: false })
    const exec = { agent: { session } } as never
    expect(toolCwdFromExec(exec)).toBe('/tmp/lease-lane')
  })

  it('falls back to process.cwd() when no agent session is attached', () => {
    expect(toolCwdFromExec({} as never)).toBe(process.cwd())
  })

  it('resolves a relative edit path against the session cwd, not the fs root', async () => {
    const fsRoot = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-fs-'))
    const sessionRoot = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-cwd-'))
    roots.push(fsRoot, sessionRoot)
    const target = `lease-file-${++callNumber}.txt`
    await writeFile(join(sessionRoot, target), 'anchor line\n', 'utf8')

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: fsRoot })
    await ctx.plugin(ToolEdit, { mode: 'replace' })
    const owner = agentWithCwd(ctx, sessionRoot)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`tool-edit-cwd-${++callNumber}`),
      name: 'edit',
      arguments: { path: target, old_string: 'anchor line', new_string: 'patched line' },
      agent: owner,
    })
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    expect(text).not.toContain('Cannot find')
    expect(await readFile(join(sessionRoot, target), 'utf8')).toBe('patched line\n')
    expect(existsSync(join(fsRoot, target))).toBe(false)
  })
})
