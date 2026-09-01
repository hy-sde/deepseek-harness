import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { DYN_NAME, defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonSchemaNode, JsonValue, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'

const testToolSignal = new AbortController().signal

/**
 * Catalog mode (`mode: 'catalog'`) unit tier: the `dyn` device transport
 * contract — eager tools project full schemas, device tools ride `dyn` at zero
 * schema slots, docs are schema-on-demand, invoke runs the guarded pipeline as
 * a nested dispatch, and a model-direct call to a device is denied with a
 * route hint. Mirrors the PTC mode unit tier in ptc.spec.ts.
 */

type Mode = 'native' | 'ptc' | 'both' | 'catalog'

async function setup(options: { mode?: Mode; toolOrder?: string[] } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { ...options.toolOrder ? { toolOrder: options.toolOrder } : {} })
  await ctx.plugin(ToolRuntime, { mode: options.mode ?? 'catalog' })
  return { ctx, tools: ctx.tools, systemPrompt: ctx.systemPrompt }
}

/** Mint an agent scope configured like production that can register scoped tool policy. */
async function mintAgentScope(ctx: Context, name = 'scoped'): Promise<{ scope: Scope; agent: Agent }> {
  const agent = { id: SessionId(name) } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
    { inject: ['tools', 'systemPrompt'] }))
  return { scope, agent }
}

function registerEager(ctx: Context, name = 'echo'): void {
  ctx.tools.register(defineTool({
    name,
    description: `Eager tool ${name}.`,
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) { return Promise.resolve(`${name}:${args.value}`) },
  }))
}

function registerDevice(ctx: Context, name = 'device-tool'): void {
  ctx.tools.register(defineTool({
    name,
    description: `Device tool ${name}: first line is the catalog summary.`,
    parameters: { value: { type: 'string', required: true }, mode: { type: 'string' } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    device: true,
    execute(args) { return Promise.resolve(`device(${args.mode ?? 'default'}):${args.value}`) },
  }))
}

async function runDyn(
  ctx: Context,
  args: Record<string, unknown>,
  extras: { agent?: Agent } = {},
): Promise<JsonValue> {
  const result = await ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId('call-dyn'),
    name: DYN_NAME,
    arguments: args,
    ...extras.agent !== undefined ? { agent: extras.agent } : {},
  })
  if (result.isError) throw new Error(`dyn failed: ${result.error.message}`)
  return result.value
}

/** Narrow an execution result to its failure branch after asserting it failed. */
function asFailure(result: ToolExecutionResult): Extract<ToolExecutionResult, { isError: true }> {
  if (!result.isError) throw new Error('expected a failed execution')
  return result
}

describe('catalog mode wire contribution', () => {
  it("mode 'catalog' projects eager schemas plus `dyn`, withholding device tools", async () => {
    const { ctx, systemPrompt } = await setup()
    registerEager(ctx)
    registerDevice(ctx)
    const assembly = await systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual(['dyn', 'echo'])
    const dyn = assembly.tools.find(tool => tool.name === DYN_NAME)!
    const parameters = dyn.parameters as JsonSchemaNode
    const properties = parameters.properties as Record<string, { type?: string; enum?: string[] }>
    expect(properties.op).toMatchObject({ type: 'string', enum: ['search', 'docs', 'invoke'] })
    // `args` is DSCL `type: 'json'`, which projects as a schema-less property (any lossless JSON).
    expect(properties.args).toBeDefined()
    expect(parameters.required).toContain('op')
  })

  it('catalog section carries the fixed guidance plus one bounded line per device', async () => {
    const { ctx, systemPrompt } = await setup()
    registerDevice(ctx)
    const assembly = await systemPrompt.assemble()
    const section = assembly.sections.find(section => section.name === 'tools:catalog')
    expect(section).toBeDefined()
    expect(section!.text).toContain('`dyn` is the only direct route to device tools')
    expect(section!.text).toContain('- device-tool — Device tool device-tool: first line is the catalog summary.')
  })

  it("mode 'native' keeps device schemas visible (the flag is inert) and renders no catalog section", async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'native' })
    registerDevice(ctx)
    const assembly = await systemPrompt.assemble()
    expect(assembly.tools.map(tool => tool.name)).toEqual(['device-tool'])
    expect(assembly.sections.some(section => section.name === 'tools:catalog')).toBe(false)
  })

  it('device names in toolOrder fail assembly under catalog, like native names under ptc', async () => {
    const { ctx, systemPrompt } = await setup({ toolOrder: ['device-tool', '<unlisted-tools>'] })
    registerDevice(ctx)
    await expect(systemPrompt.assemble()).rejects.toThrow(/toolOrder lists unregistered tool "device-tool"/)
  })
})

describe('reserved `dyn` name', () => {
  it('registration refuses the reserved transport name', async () => {
    const { tools } = await setup()
    expect(() => tools.register(defineTool({
      name: DYN_NAME,
      description: 'collision',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: () => Promise.resolve('x'),
    }))).toThrow(/reserved for the catalog device transport/)
  })

  it('restriction refuses the reserved transport name on a scoped context', async () => {
    const { ctx } = await setup()
    const { scope } = await mintAgentScope(ctx)
    // restrict requires a scoped context; the reserved-name check must fire there,
    // not be reachable at all through the transport.
    expect(() => scope.ctx.tools.restrict({ deny: [DYN_NAME] }))
      .toThrow(/cannot name reserved catalog device transport/)
  })
})

describe('`dyn` transport round-trips', () => {
  it('search lists the bounded catalog with text filtering, offset, and truncation', async () => {
    const { ctx } = await setup()
    registerDevice(ctx, 'alpha-tool')
    registerDevice(ctx, 'beta-tool')
    const all = await runDyn(ctx, { op: 'search' }) as { op: string; total: number; entries: { name: string }[]; truncated: boolean }
    expect(all.op).toBe('search')
    expect(all.total).toBe(2)
    expect(all.entries.map(entry => entry.name)).toEqual(['alpha-tool', 'beta-tool'])
    expect(all.truncated).toBe(false)

    const filtered = await runDyn(ctx, { op: 'search', text: 'beta' }) as typeof all
    expect(filtered.total).toBe(1)
    expect(filtered.entries[0]!.name).toBe('beta-tool')

    const paged = await runDyn(ctx, { op: 'search', limit: 1 }) as typeof all
    expect(paged.entries.map(entry => entry.name)).toEqual(['alpha-tool'])
    expect(paged.truncated).toBe(true)
  })

  it('search summary is capped at DEVICE_SUMMARY_CAP bytes', async () => {
    const { ctx } = await setup()
    ctx.tools.register(defineTool({
      name: 'long-device',
      description: `${'é'.repeat(400)} tail words.`,
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      device: true,
      execute: () => Promise.resolve('x'),
    }))
    const value = await runDyn(ctx, { op: 'search', text: 'long' }) as { entries: { summary: string }[] }
    const summary = value.entries[0]!.summary
    expect(new TextEncoder().encode(summary).byteLength).toBeLessThanOrEqual(200)
    expect(summary.endsWith('tail words.')).toBe(false)
  })

  it('docs returns full description, parameter schema, AND the output schema (never sent natively)', async () => {
    const { ctx } = await setup()
    registerDevice(ctx)
    const value = await runDyn(ctx, { op: 'docs', name: 'device-tool' }) as { op: string; name: string; docs: string }
    expect(value.op).toBe('docs')
    expect(value.name).toBe('device-tool')
    expect(value.docs).toContain('# device-tool')
    expect(value.docs).toContain('## Parameters (JSON schema)')
    expect(value.docs).toContain('"value"')
    expect(value.docs).toContain('## Output schema')
  })

  it('docs on an unmounted or eager name fails with a mounted-devices hint', async () => {
    const { ctx } = await setup()
    registerDevice(ctx)
    registerEager(ctx, 'echo')
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('call-dyn-docs'),
      name: DYN_NAME,
      arguments: { op: 'docs', name: 'echo' },
    })
    expect(result.isError).toBe(true)
    expect(asFailure(result).error.message).toContain('no such device "echo"')
    expect(asFailure(result).error.message).toContain('device-tool')
  })

  it('docs on an unknown name with zero mounted devices reports no devices at all', async () => {
    const { ctx } = await setup()
    const missing = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('call-dyn-docs-2'),
      name: DYN_NAME,
      arguments: { op: 'docs', name: 'nope' },
    })
    expect(missing.isError).toBe(true)
    expect(asFailure(missing).error.message).toContain('No devices are mounted')
  })

  it('invoke runs a device through the guarded pipeline as a nested dispatch, carrying value and content', async () => {
    const { ctx } = await setup()
    registerDevice(ctx)
    const value = await runDyn(ctx, { op: 'invoke', name: 'device-tool', args: { value: 'hi', mode: 'fast' } }) as {
      op: string
      name: string
      isError: boolean
      result: string
      content: string
    }
    expect(value.op).toBe('invoke')
    expect(value.name).toBe('device-tool')
    expect(value.isError).toBe(false)
    expect(value.result).toBe('device(fast):hi')
    expect(value.content).toBe('device(fast):hi')
  })

  it('a device body failure surfaces as dyn invoke error with the failure message', async () => {
    const { ctx } = await setup()
    ctx.tools.register(defineTool({
      name: 'flaky-device',
      description: 'Flaky device.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      device: true,
      execute: () => { throw new Error('kaboom') },
    }))
    const value = await runDyn(ctx, { op: 'invoke', name: 'flaky-device', args: {} }) as { op: string; isError: boolean; error: string }
    expect(value.op).toBe('invoke')
    expect(value.isError).toBe(true)
    expect(value.error).toBe('kaboom')
  })

  it('restricting a device removes it from the catalog and from dispatch', async () => {
    const { ctx } = await setup()
    registerDevice(ctx, 'public-device')
    registerDevice(ctx, 'hidden-device')
    const { scope, agent } = await mintAgentScope(ctx)
    scope.ctx.tools.restrict({ deny: ['hidden-device'] })
    const value = await runDyn(ctx, { op: 'search' }, { agent }) as { entries: { name: string }[] }
    expect(value.entries.map(entry => entry.name)).toEqual(['public-device'])
    const denied = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('call-hidden'),
      name: 'hidden-device',
      arguments: {},
      agent,
    })
    expect(denied.isError).toBe(true)
    expect(asFailure(denied).error.info?.code).toBe('UNKNOWN_TOOL')
  })
})

describe('catalog mode execution collapse', () => {
  it('a model-direct call to a device is denied before policy with a dyn route hint', async () => {
    const { ctx } = await setup()
    registerDevice(ctx)
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('call-direct'),
      name: 'device-tool',
      arguments: { value: 'x' },
    })
    expect(result.isError).toBe(true)
    expect(asFailure(result).error.info?.code).toBe('UNKNOWN_TOOL')
    expect(asFailure(result).error.message).toContain('`dyn`')
    expect(asFailure(result).error.message).toContain('invoke')
  })

  it('a nested (parent-token) call to a device bypasses the collapse', async () => {
    const { ctx } = await setup()
    registerDevice(ctx)
    const outer = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('call-outer'),
      name: DYN_NAME,
      arguments: { op: 'invoke', name: 'device-tool', args: { value: 'nested' } },
    })
    expect(outer.isError).toBe(false)
    expect((outer as { value: { result: string } }).value.result).toBe('device(default):nested')
  })

  it('presentAs("catalog") shadows a native deployment for one agent scope and disposes back', async () => {
    const { ctx, systemPrompt } = await setup({ mode: 'native' })
    registerDevice(ctx)
    const { scope, agent } = await mintAgentScope(ctx)
    const dispose = scope.ctx.tools.presentAs('catalog')
    const scoped = await systemPrompt.assemble({ scope: agent })
    // Device tools are WITHHELD from the wire by design: only the eager set
    // (empty here) plus the `dyn` transport appear; devices live in the section.
    expect(scoped.tools.map(tool => tool.name)).toEqual([DYN_NAME])
    expect(scoped.sections.some(section => section.name === 'tools:catalog')).toBe(true)
    dispose()
    const restored = await systemPrompt.assemble({ scope: agent })
    expect(restored.tools.map(tool => tool.name)).toEqual(['device-tool'])
    expect(restored.sections.some(section => section.name === 'tools:catalog')).toBe(false)
  })

  it('a scoped device registration is withheld for that scope only, harmless elsewhere', async () => {
    const { ctx, systemPrompt } = await setup()
    registerEager(ctx)
    const { scope, agent } = await mintAgentScope(ctx)
    scope.ctx.tools.register(defineTool({
      name: 'scoped-device',
      description: 'Scoped device.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      device: true,
      execute: () => Promise.resolve('scoped'),
    }))
    const scoped = await systemPrompt.assemble({ scope: agent })
    expect(scoped.tools.map(tool => tool.name).sort()).toEqual(['dyn', 'echo'])
    // the global assembly ignores the scope-local device entirely
    const global = await systemPrompt.assemble()
    expect(global.tools.map(tool => tool.name).sort()).toEqual(['dyn', 'echo'])
  })
})
