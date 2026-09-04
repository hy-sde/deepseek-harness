/**
 * P1 wave E2E: one parallel fan-out under the orchestration policy, over a
 * REAL git repository — `worktree acquire --branch` per chunk, `subagent
 * { workspace }` per child capturing the lease path, then `release`. Also
 * asserts the fail-closed guard rejects a policy-on start without a workspace
 * through the real tool path.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentCapabilities, SubagentProvider, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as Git from '@deepseek-ai/dsh-git'
import toolGitPackage from '@deepseek-ai/dsh-tool-git'
import * as toolSubagentPackage from '@deepseek-ai/dsh-tool-subagent'
import policyPackage from '../src/index.ts'

interface Fixture {
  dir: string
  pool: string
  ctx: Context
  provider: WaveProvider
  cleanup: () => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []

function gitRun(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}): ${result.stderr.trim()}`)
  }
  return result.stdout
}

/** One-task recording provider: captures every start's `workspace`. */
class WaveProvider implements SubagentProvider {
  readonly name = 'wave'
  readonly capabilities: SubagentCapabilities = {
    agentOptions: false,
    outputSchema: false,
    depthLimit: false,
    toolFilter: false,
    persona: false,
    workspace: true,
  }
  readonly inheritsParentContext = false
  readonly starts: SubagentStartRequest[] = []

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    this.starts.push(request)
    const output: ContentBlock[] = [{ type: 'text', text: 'wave child done' }]
    return {
      id: SessionId(`wave-child-${this.starts.length}`),
      localAgent: undefined,
      result: Promise.resolve({ output, stopReason: 'completed' }),
      dispose: async () => {},
    }
  }
}

async function makeFixture(): Promise<Fixture> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-policy-wave-')))
  const pool = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-policy-wave-pool-')))
  gitRun(dir, ['init', '-q', '-b', 'master'])
  gitRun(dir, ['config', 'user.email', 'test@example.com'])
  gitRun(dir, ['config', 'user.name', 'Test User'])
  gitRun(dir, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(dir, 'seed.txt'), 'seed\n')
  gitRun(dir, ['add', '.'])
  gitRun(dir, ['commit', '-qm', 'init'])

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(Git)
  await ctx.plugin(toolGitPackage, { worktreeRoot: pool })
  const provider = new WaveProvider()
  await ctx.plugin({
    name: 'wave-provider',
    inject: ['subagents'],
    apply(pluginCtx: Context): void { pluginCtx.subagents.registerProvider(provider) },
  })
  await ctx.plugin(toolSubagentPackage, { provider: 'wave', backgroundMode: 'one-shot', maxDepth: 'provider-managed' })
  await ctx.plugin(policyPackage, { enabled: true, maxFanOut: 2 })

  const fixture: Fixture = {
    dir,
    pool,
    ctx,
    provider,
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true })
      rmSync(pool, { recursive: true, force: true })
      await ctx.fiber.dispose()
    },
  }
  cleanups.push(fixture.cleanup)
  return fixture
}

afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean()
})

const parentAgent = (cwd: string): Agent => {
  const sessionId = SessionId('parent-1')
  return {
    id: sessionId,
    options: {},
    session: Object.assign(Session.create(sessionId), { header: { ...Session.create(sessionId).header, cwd } }),
  } as unknown as Agent
}

async function call(ctx: Context, name: string, args: Record<string, unknown>, agent?: Agent): Promise<{ value: unknown; text: string }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`wave-${name}-${Math.random().toString(16).slice(2, 8)}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent } : {},
  })
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join(' ')
  if (result.isError) throw new Error(text || 'tool failed')
  return { value: result.value, text }
}


describe('P1 wave: worktree acquire -> subagent workspace -> release', () => {
  it('fans two independent chunks into isolated worktrees and releases both', async () => {
    const f = await makeFixture()
    const agent = parentAgent(f.dir)

    const acquire = async (branch: string) => {
      const { value } = await call(f.ctx, 'worktree', { action: 'acquire', branch }, agent)
      return value as { lease: { path: string; leaseId: string } }
    }
    const [a, b] = await Promise.all([acquire('feat/a'), acquire('feat/b')])
    expect(a.lease.path).not.toBe(b.lease.path)

    const [ra, rb] = await Promise.all([
      call(f.ctx, 'subagent', { description: 'chunk a', prompt: 'work on a', workspace: a.lease.path }, agent),
      call(f.ctx, 'subagent', { description: 'chunk b', prompt: 'work on b', workspace: b.lease.path }, agent),
    ])
    expect(ra.value).toMatchObject({ kind: 'foreground' })
    expect(rb.value).toMatchObject({ kind: 'foreground' })
    // The policy guard is armed and both children carried their own lease path.
    expect(f.provider.starts).toHaveLength(2)
    expect(f.provider.starts[0]!.workspace).toBe(a.lease.path)
    expect(f.provider.starts[1]!.workspace).toBe(b.lease.path)
    expect(ra.text).not.toContain('warning:')

    await call(f.ctx, 'worktree', { action: 'release', path: a.lease.path, leaseId: a.lease.leaseId }, agent)
    await call(f.ctx, 'worktree', { action: 'release', path: b.lease.path, leaseId: b.lease.leaseId }, agent)
    const listed = await call(f.ctx, 'worktree', { action: 'list' }, agent)
    expect((listed.value as { worktrees: unknown[] }).worktrees).toHaveLength(2)
    const idle = (listed.value as { worktrees: Array<{ status: string }> }).worktrees.every(w => w.status === 'idle')
    expect(idle).toBe(true)
  })

  it('fail-closes a policy-on start without a workspace through the real tool path', async () => {
    const f = await makeFixture()
    const agent = parentAgent(f.dir)
    await expect(
      call(f.ctx, 'subagent', { description: 'unguarded', prompt: 'go' }, agent),
    ).rejects.toThrow(/worktree acquire.*workspace/)
    expect(f.provider.starts).toHaveLength(0)
  })
})
