// @vitest-environment jsdom
/**
 * ui-wiki browser half over a real cordis Context with a SlotRegistry and a
 * scripted Remote: apply() registers the sidebar toggle and the overlay
 * drawer, and the rendered toggle opens the panel which lists pages and
 * navigates into a page through the wiki wire face.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WikiRemoteNamespace } from '../src/client/api.ts'
import { wikiStore } from '../src/client/store.ts'
import { apply, inject } from '../src/client/index.ts'
import { WikiToggle } from '../src/client/WikiToggle.tsx'
import { WikiDrawer } from '../src/client/WikiDrawer.tsx'

afterEach(() => {
  cleanup()
  wikiStore.close()
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
    remove: async (payload) => { calls.push({ method: 'remove', args: [payload] }); return ok({ entityType: payload.entityType ?? 'block', detail: 'removed' }) },
    server: async (payload) => { calls.push({ method: 'server', args: [payload] }); return ok({ servers: [] }) },
  } as WikiRemoteNamespace
}

async function bench(): Promise<{ ctx: Context }> {
  const ctx = new Context()
  const calls: { method: string; args: unknown[] }[] = []
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root', children: {
      'shell.overlay': { kind: 'list', scope: 'root' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  ctx.provide('remote', { wiki: scriptedWiki(calls) } as unknown as ClientRemote)
  await ctx.plugin({ inject, apply }).await()
  return { ctx }
}

describe('ui-wiki browser plugin', () => {
  it('registers the sidebar toggle and the overlay drawer', async () => {
    const { ctx } = await bench()
    expect(ctx.slots.entries('sidebar.footer.action')[0]?.options).toMatchObject({ id: 'wiki', order: 90 })
    expect(ctx.slots.entries('shell.overlay')[0]?.options).toMatchObject({ id: 'wiki-drawer', order: 10 })
  })

  it('toggle opens the drawer, lists pages, and opens a page', async () => {
    await bench()
    render(<WikiDrawer />) // closed → renders nothing
    render(<WikiToggle wide />)
    fireEvent.click(screen.getByTitle('Open wiki'))
    await waitFor(() => { expect(screen.getByText('LLM Wiki')).toBeDefined() })
    await waitFor(() => { expect(screen.getByText('Rust')).toBeDefined() })
    fireEvent.click(screen.getByText('Rust'))
    await waitFor(() => { expect(screen.getByText('Systems language in the LLM-era vibe shift')).toBeDefined() })
  })
})
