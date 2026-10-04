// E2E through the BUILT host artifact: package root resolves to lib/index.js.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolEdit from '@deepseek-ai/dsh-tool-edit'

const contexts: Context[] = []
const roots: string[] = []
let callNumber = 0
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function agent(ctx: Context, cwd: string): Agent {
  const id = SessionId(`so-lib-e2e-${callNumber}`)
  const scope = ctx.plugin(() => { })
  const session = Session.create(id, [], { version: 4, id, createdAt: 0, cwd, isSeeded: false })
  const value: Agent = { id, options: {}, session, inbox: createInboxStub(), status: 'idle', ctx: scope.ctx,
    send: () => { }, followup: () => { }, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => { }, cancel() { }, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
  ctx.agents.register(value)
  return value
}
function call(ctx: Context, owner: Agent | undefined, args: unknown) {
  return ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`so-lib-e2e-${++callNumber}`), name: 'edit', arguments: args, ...owner === undefined ? {} : { agent: owner } })
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'so-lib-e2e-'))
  roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root }); await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolEdit, {})
  return { ctx, root, owner: agent(ctx, root) }
}
it('replaces a 1-line marker with a 120-line block through the built lib', async () => {
  // Regression for "Maximum call stack size exceeded": diffRange recursed
  // forever when the old side reached one line absent from the new side.
  const marker = '<!-- INSERTION POINT -->'
  const block = Array.from({ length: 120 }, (_, i) => `- entry ${i} with realistic prose length padding`).join('\n')
  const { ctx, owner } = await setup()
  const target = join(tmpdir(), `so-lib-e2e-${Date.now()}.md`)
  await writeFile(target, `# Report\n\n${marker}\n\ntail\n`)
  const result = await call(ctx, owner, {
    path: target,
    old_string: marker,
    new_string: block,
  }) as { isError?: boolean; error?: { message?: string } }
  expect(result.isError ?? false).toBe(false)
  const after = await import('node:fs/promises').then(m => m.readFile(target, 'utf8'))
  expect(after).toContain('- entry 119')
  expect(after).not.toContain(marker)
}, 30000)
