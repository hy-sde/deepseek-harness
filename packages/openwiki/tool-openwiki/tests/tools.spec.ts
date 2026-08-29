/**
 * `@deepseek-ai/dsh-tool-openwiki` tests: the five lifecycle tool schemas
 * register under exactly their OpenWiki 0.4 names, the shared single-run
 * adapter is created on mount, and the prompt section builds the protocol
 * contract card. No filesystem is touched.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { applyOpenWikiTools } from '../src/tools.ts'
import { buildOpenWikiPromptSection } from '../src/prompt.ts'

const FIVE_NAMES = [
  'openwiki_begin',
  'openwiki_submit_plan',
  'openwiki_next_page',
  'openwiki_submit_page',
  'openwiki_finish',
] as const

describe('openwiki tool surface', () => {
  it('registers exactly the five OpenWiki lifecycle tools on mount', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    applyOpenWikiTools(ctx, { host: 'test', producerActor: 'test' })

    const visible = ctx.tools.schemas()
    const names = visible.map(t => t.name)
    for (const expected of FIVE_NAMES) {
      expect(names).toContain(expected)
    }
    expect(names).toHaveLength(5)
    await ctx.fiber.dispose()
  })

  it('gives each lifecycle tool a grounded description + parameter schema', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    applyOpenWikiTools(ctx, {})

    const visible = ctx.tools.schemas()
    const byName = Object.fromEntries(visible.map(t => [t.name, t]))
    for (const name of FIVE_NAMES) {
      const tool = byName[name]
      expect(tool).toBeDefined()
      expect(tool!.description.length).toBeGreaterThan(40)
      expect(typeof tool!.parameters).toBe('object')
    }

    const begin = byName['openwiki_begin']!
    expect(begin.parameters.properties).toMatchObject({ root: { type: 'string' }, mode: { type: 'string' } })
    const plan = byName['openwiki_submit_plan']!
    expect(plan.parameters.properties).toMatchObject({ runId: {}, pages: {} })
    const page = byName['openwiki_submit_page']!
    expect(page.parameters.properties).toMatchObject({ runId: {}, jobId: {}, claims: {} })
    const next = byName['openwiki_next_page']!
    expect(next.parameters.properties).toMatchObject({ runId: {} })
    const finish = byName['openwiki_finish']!
    expect(finish.parameters.properties).toMatchObject({ runId: {} })

    await ctx.fiber.dispose()
  })
})

describe('openwiki prompt section', () => {
  it('builds a non-empty protocol card named openwiki:tools', () => {
    const section = buildOpenWikiPromptSection()
    expect(section.name).toBe('openwiki:tools')
    expect(typeof section.order).toBe('number')
    expect(section.text.length).toBeGreaterThan(100)
    expect(section.text).toContain('openwiki_begin')
    expect(section.text).toContain('openwiki_submit_plan')
    expect(section.text).toContain('codebase-memory')
  })

  it('can be disabled', () => {
    const section = buildOpenWikiPromptSection({ enabled: false })
    expect(section.text).toBe('')
  })
})
