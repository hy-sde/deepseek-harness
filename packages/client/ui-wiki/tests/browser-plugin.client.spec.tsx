// @vitest-environment jsdom
/**
 * ui-wiki browser half over a real cordis Context with a SlotRegistry and a
 * scripted connection: apply() registers the sidebar toggle and the overlay
 * drawer, and the rendered toggle opens the panel which lists pages and
 * navigates into a page through the wiki face.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { wikiStore } from '../src/client/store.ts'
import { apply, inject } from '../src/client/index.ts'
import { WikiToggle } from '../src/client/WikiToggle.tsx'
import { WikiDrawer } from '../src/client/WikiDrawer.tsx'

afterEach(() => {
  cleanup()
  wikiStore.close()
})

function scriptedWiki(calls: { method: string; args: unknown[] }[]): IApiClient['wiki'] {
  const wire = (method: string, value: unknown) => async () => {
    calls.push({ method, args: [] })
    return { rpcId: '', result: { ok: true as const, value } }
  }
  return {
    listPages: wire('listPages', { pages: [{ id: 240, title: 'Rust', updatedAt: 1787808165009, createdAt: 1787808086650 }] }) as unknown as IApiClient['wiki']['listPages'],
    getPage: wire('getPage', {
      root: {
        id: 240, name: 'rust', title: 'Rust', uuid: null, createdAt: 1, updatedAt: 1, tags: [], props: {}, children: [
          { id: 273, uuid: null, content: 'Systems language in the LLM-era vibe shift', order: 'a0', createdAt: 1, updatedAt: 1, tags: [], children: [] },
        ],
      },
      linked: [],
    }) as unknown as IApiClient['wiki']['getPage'],
    listTags: wire('listTags', { tags: [] }) as unknown as IApiClient['wiki']['listTags'],
    listProperties: wire('listProperties', { properties: [] }) as unknown as IApiClient['wiki']['listProperties'],
    listTasks: wire('listTasks', { tasks: [] }) as unknown as IApiClient['wiki']['listTasks'],
    search: wire('search', { items: [] }) as unknown as IApiClient['wiki']['search'],
    query: wire('query', { rows: [] }) as unknown as IApiClient['wiki']['query'],
    upsert: wire('upsert', { entityType: 'block', status: 'ok' as const, detail: 'ok' }) as unknown as IApiClient['wiki']['upsert'],
    remove: wire('remove', { entityType: 'block', detail: 'removed' }) as unknown as IApiClient['wiki']['remove'],
    server: wire('server', { servers: [] }) as unknown as IApiClient['wiki']['server'],
  }
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
  const connection = { api: { wiki: scriptedWiki(calls) } } as unknown as ConnectionHandle
  ctx.provide('connection', connection)
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
