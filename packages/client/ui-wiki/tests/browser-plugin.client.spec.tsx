// @vitest-environment jsdom
/**
 * ui-wiki browser half over a real cordis Context with a SlotRegistry and a
 * scripted Remote: apply() registers the sidebar-panel-strip Wiki entry and
 * the docked main panel, and the rendered panel lists pages and navigates
 * into a page through the wiki wire face.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { en } from '../src/client/locales.ts'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WikiRemoteNamespace } from '../src/client/api.ts'
import { wikiStore } from '../src/client/store.ts'
import { apply, inject } from '../src/client/index.ts'
import { WikiPanel } from '../src/client/WikiPanel.tsx'
import { WikiPanelIcon } from '../src/client/WikiPanelIcon.tsx'

afterEach(() => {
  cleanup()
  wikiStore.backToPages()
  wikiStore.setSearchQuery('')
})

function scriptedWiki(calls: { method: string; args: unknown[] }[]): WikiRemoteNamespace {
  const ok = <T,>(value: T): RemoteResult<T> => ({ ok: true as const, value })
  return {
    listPages: async (payload) => { calls.push({ method: 'listPages', args: [payload] }); return ok({ pages: [{ id: 240, title: 'Rust', updatedAt: 1787808165009, createdAt: 1787808086650 }] }) },
    getPage: async (payload) => { calls.push({ method: 'getPage', args: [payload] }); return ok({
      root: {
        id: 240, name: 'rust', title: 'Rust', uuid: null, createdAt: 1, updatedAt: 1, tags: [], props: {}, children: [
          { id: 273, uuid: null, content: 'Systems language in the LLM-era vibe shift', order: 'a0', createdAt: 1, updatedAt: 1, tags: [], children: [] },
        ],
      },
      linked: [],
    }) },
    listTags: async () => { calls.push({ method: 'listTags', args: [] }); return ok({ tags: [] }) },
    listProperties: async () => { calls.push({ method: 'listProperties', args: [] }); return ok({ properties: [] }) },
    search: async (payload) => { calls.push({ method: 'search', args: [payload] }); return ok({ items: [] }) },
    query: async (payload) => { calls.push({ method: 'query', args: [payload] }); return ok({ rows: [] }) },
    upsert: async (payload) => { calls.push({ method: 'upsert', args: [payload] }); return ok({ entityType: payload.entityType, status: 'ok', detail: 'ok' }) },
    delete: async (payload) => { calls.push({ method: 'delete', args: [payload] }); return ok({ entityType: payload.entityType ?? 'block', detail: 'removed' }) },
    server: async (payload) => { calls.push({ method: 'server', args: [payload] }); return ok({ servers: [] }) },
  }
}

async function bench(): Promise<{ ctx: Context }> {
  const ctx = new Context()
  const calls: { method: string; args: unknown[] }[] = []
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root', children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', { register: vi.fn(() => (() => {})), bind: vi.fn(() => (key: string) => (en as Record<string, string>)[key] ?? key) } as never)
  ctx.provide('remote', { wiki: scriptedWiki(calls) } as unknown as ClientRemote)
  ctx.provide('remote.wiki', scriptedWiki(calls))
  await ctx.plugin({ inject, apply }).await()
  return { ctx }
}

describe('ui-wiki browser plugin', () => {
  it('registers the sidebar strip entry and the main panel', async () => {
    const { ctx } = await bench()
    expect(ctx.slots.entries('sidebar.panellist')[0]?.options).toMatchObject({ id: 'wiki', order: 30, label: expect.any(Function) })
    expect(ctx.slots.entries('main')[0]?.options).toMatchObject({ key: 'wiki' })
  })

  it('strip icon renders the wiki glyph and the panel lists and opens pages', async () => {
    await bench()
    const t = (key: string): string => (en as Record<string, string>)[key] ?? key
    // The aggregate typecheck folds the host's GlobalStandardProps augmentation
    // into PropsRuntime; neither occupant consumes those hooks, so the fixtures
    // cast the minimal render props instead of stubbing eleven unused hooks.
    render(<WikiPanelIcon {...({ size: 18, active: false } as PropsRuntime<'sidebar.panellist'>)} />)
    expect(screen.getByText('❖')).toBeDefined()
    render(<WikiPanel {...({ t } as PropsRuntime<'main'> & { t: typeof t })} />)
    await waitFor(() => { expect(screen.getByText('LLM Wiki')).toBeDefined() })
    await waitFor(() => { expect(screen.getByText('Rust')).toBeDefined() })
    fireEvent.click(screen.getByText('Rust'))
    await waitFor(() => { expect(screen.getByText('Systems language in the LLM-era vibe shift')).toBeDefined() })
  })
})
