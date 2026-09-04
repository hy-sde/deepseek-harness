import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

/**
 * The agent-presets package's own bundled roster — the shipped presets an
 * installed shell mounts. The CLI test context resolves `@deepseek-ai/*` rows
 * through apps/cli's node_modules (the same base the code-edit smoke uses).
 */
const PACKAGE_PRESETS_ROOT = fileURLToPath(new URL('../../../packages/preset/agent-presets/presets', import.meta.url))

/** The CLI's own shipped root: the base URL plugins resolve through. */
const SHIPPED_ROOT = fileURLToPath(new URL('../config/agent-presets', import.meta.url))

/**
 * The shipped `standard` preset mounts the orchestration policy (P1-P3) ON by
 * default: provider and every consumer (`tool-subagent` isolation guard,
 * `tool-git` review gate) share the delegation isolate realm, and the gate
 * tools stay present.
 */
describe('shipped standard preset', () => {
  it('delegation realm owns the policy provider and its consumers', async () => {
    const entries: unknown = yaml.load(
      readFileSync(join(PACKAGE_PRESETS_ROOT, 'standard', 'agent.cordis.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(entries)) throw new TypeError('standard preset must parse to an entry array')
    const delegation = entries.find((entry): entry is Record<string, unknown> => (
      typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).id === 'delegation'
    ))
    expect(delegation, 'delegation group').toBeDefined()
    expect((delegation as Record<string, unknown>).isolate).toMatchObject({ orchestrationPolicy: true })
    const rows = ((delegation as Record<string, unknown>).config ?? []) as Record<string, unknown>[]
    const rowIds = rows.map(row => row.id)
    expect(rowIds).toContain('orchestration-policy')
    expect(rowIds).toContain('tool-git')
    expect(rowIds).toContain('tool-subagent')
    const policyRow = rows.find(row => row.id === 'orchestration-policy')
    expect(policyRow?.config).toMatchObject({ enabled: true })
    // The git row is NOT loose at the top level anymore — its gate consumer
    // must live in the realm with the provider.
    const looseIds = entries.map(entry => (entry as Record<string, unknown>).id)
    expect(looseIds).not.toContain('tool-git')
  })
})

/**
 * A minimal real-package composition that mirrors the standard preset's policy
 * shape: policy provider + `tool-git` + `tool-subagent` in ONE isolate realm.
 * This is what validates the realm rule (provider + every consumer together)
 * without dragging in standard's unrelated host-scoped rows.
 */
describe('policy composition shape', () => {
  async function policyHarness(): Promise<{ ctx: Context; handle: Awaited<ReturnType<Context['agents']['create']>> }> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-policy-preset-'))
    await mkdir(join(root, 'user')); await writeFile(join(root, 'user', 'agent.cordis.yml'), `- id: policy-group
  name: cordis:group
  group: true
  isolate:
    orchestrationPolicy: true
  config:
    - id: orchestration-policy
      name: '@deepseek-ai/dsh-orchestration-policy'
      config:
        enabled: true
    - id: tool-git
      name: '@deepseek-ai/dsh-tool-git'
      config:
        reviewProvider: spawn
        maxReviewers: 4
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable
`)
    await writeFile(join(root, 'user', 'preset.yml'), 'name: policy-smoke\ndescription: policy composition smoke fixture\n')
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(SHIPPED_ROOT).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(SandboxPolicy)
    ctx.provide('shell', {})
    ctx.provide('shellEnv', {})
    ctx.provide('userQuestions', {})
    ctx.provide('git', {})
    ctx.provide('subagents', { getProvider: () => undefined })
    await ctx.plugin(AgentPresets, {
      default: 'user',
      roots: [{ path: root, trust: 'user' }],
      includeUserRoot: false,
      includeShippedRoot: false,
    })
    const handle = await ctx.agents.create({
      sessionId: SessionId('policy-preset-smoke'),
      setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'user'),
    })
    return { ctx, handle }
  }

  it('mounts without a process-global collision and exposes the full surface', async () => {
    const { ctx, handle } = await policyHarness()
    const names = ctx.tools.schemas(handle.agent).map(schema => schema.name).sort()
    expect(names).toContain('commit_apply')
    expect(names).toContain('review')
    expect(names).toContain('worktree')
    // The subagent tool registers when its provider appears; the stub provider
    // here is absent, so its absence is expected in this fixture (standard
    // registers it through the deployment's provider mount).

    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
    const policySection = prompt.sections.find(section => section.name === 'orchestration:policy')
    expect(policySection?.text).toContain('Quality gate')
    expect(policySection?.text).toContain('Report OUTCOMES, not mechanics')
    expect(policySection?.text).toContain('Knowledge-only intents')

    // registered only inside the mounted agent's scope.
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('commit_apply')
  })

  it('consumers in the realm read the per-session policy service', async () => {
    const { ctx, handle } = await policyHarness()
    // The policy service exists in the same session scope the git tools run in:
    // commit_apply is DATA (git calls at execution), but the gate decision
    // function must be reachable — assert via the agent's prompt section config
    // (the section only renders when the service resolved) and the guard shape.
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(handle.agent))
    expect(prompt.sections.some(section => section.name === 'orchestration:policy')).toBe(true)
  })
})
