import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { describe, expect, it } from 'vitest'

/** The shipped roster this deployment mounts, exactly as profile-boot reads it. */
const SHIPPED_ROOT = fileURLToPath(new URL('../config/agent-presets', import.meta.url))

/**
 * The `code-edit` preset must mount exactly as a session start would: its
 * `edit` row (rich tool-edit) takes the `edit` name away from tool-fs, the
 * LSP seam rows live behind an isolate realm, and no process-global service
 * escapes the preset.
 */
describe('shipped code-edit preset', () => {
  it('stand-key validates and mounts an agent with the expected tool surface', async () => {
    expect(join(SHIPPED_ROOT, 'code-edit', 'agent.cordis.yml')).toMatch(/code-edit/)

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
    await ctx.plugin(AgentLoop, { agents: [] })
    // The host services production mounts behind these rows: fs-local and
    // subprocess-local provide the real services `tool-fs`, `tool-fs-search`
    // and `lsp-stdio` inject. `shell`/`shellEnv`/`userQuestions` are only
    // touched at activation (tool-bash registers, tool-ask-user registers),
    // so lightweight stubs suffice for the mount check.
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(LocalSubprocessRuntime)
    ctx.provide('shell', {})
    ctx.provide('shellEnv', {})
    ctx.provide('userQuestions', {})
    await ctx.plugin(AgentPresets, {
      default: 'code-edit',
      roots: [{ path: SHIPPED_ROOT, trust: 'system' }],
      includeUserRoot: false,
    })

    // The standing mount the host reader uses — same validation a session start performs.
    const key = await ctx.agentPresets.standingKeyFor('code-edit')
    expect(key).toEqual({ agentPreset: 'code-edit' })

    // A real agent composed from the preset.
    const handle = await ctx.agents.create({
      sessionId: SessionId('code-edit-preset-smoke'),
      setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'code-edit'),
    })
    const names = ctx.tools.schemas(handle.agent).map(schema => schema.name).sort()

    // The rich editor owns the `edit` name; tool-fs contributes read/write only.
    expect(names).toContain('edit')
    expect(names).toContain('read')
    expect(names).toContain('write')
    expect(names).toContain('bash')
    expect(names).toContain('glob')
    expect(names).toContain('grep')
    expect(names).toContain('ask_user_question')
    expect(names).toContain('todo_write')

    // Structural search/rewrite (tool-ast) and LSP navigation (tool-lsp) mount
    // beside the rich editor; the LSP seam rows live behind the isolate realm.
    expect(names).toContain('ast_grep')
    expect(names).toContain('ast_edit')
    expect(names).toContain('lsp')

    // tools are registered only inside the mounted agent's scope.
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('edit')
  })

  it('minimal mounts as a two-tool composition with the rich editor', async () => {
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
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(LocalSubprocessRuntime)
    // terminal-bash (persistent shell) injects the host sandbox policy.
    await ctx.plugin(SandboxPolicy)
    ctx.provide('shell', {})
    ctx.provide('shellEnv', {})
    ctx.provide('userQuestions', {})
    await ctx.plugin(AgentPresets, {
      default: 'minimal',
      roots: [{ path: SHIPPED_ROOT, trust: 'system' }],
      includeUserRoot: false,
    })

    const key = await ctx.agentPresets.standingKeyFor('minimal')
    expect(key).toEqual({ agentPreset: 'minimal' })

    const handle = await ctx.agents.create({
      sessionId: SessionId('minimal-preset-smoke'),
      setup: async agentCtx => void await ctx.agentPresets.mount(agentCtx, 'minimal'),
    })
    const names = ctx.tools.schemas(handle.agent).map(schema => schema.name).sort()

    // Two-tool carrier (bash + rich editor): the rich `edit` owns the name,
    // tool-fs contributes read/write only, and there is no search/ask/todo rows.
    expect(names).toContain('bash')
    expect(names).toContain('edit')
    expect(names).toContain('read')
    expect(names).toContain('write')
    expect(names).not.toContain('glob')
    expect(names).not.toContain('grep')
    expect(names).not.toContain('ask_user_question')
    expect(names).not.toContain('todo_write')
  })
})
