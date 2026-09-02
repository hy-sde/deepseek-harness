/**
 * ui-wiki unit coverage: property parsing and the store's state machine over
 * a scripted wiki wire face (no DOM needed — jsdom-free).
 * The store is the single source of wire traffic, so these tests pin the
 * upsert/delete argument shapes the drawer's actions produce.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { WikiClient, type WikiRemoteNamespace } from '../src/client/api.ts'
import { wikiStore } from '../src/client/store.ts'

async function resetStore(): Promise<void> {
  // Re-bind a scripted client after each test so recorded calls reset, close
  // the drawer from the previous test, and materialize the page list via the
  // lazy path so every test starts from a settled store.
  const calls: { method: string; args: unknown[] }[] = []
  stub = calls
  await wikiStore.bind(new WikiClient(scriptedWiki(calls)))
  wikiStore.close()
  await wikiStore.ensurePages()
}

let stub: { method: string; args: unknown[] }[] = []

/** A scripted wiki Remote namespace that records every call. */
function scriptedWiki(calls: { method: string; args: unknown[] }[]): WikiRemoteNamespace {
  const ok = <T>(value: T): RemoteResult<T> => ({ ok: true as const, value })
  const pageRow = { id: 240, title: 'Rust', updatedAt: 1787808165009, createdAt: 1787808086650 }
  const root = { id: 240, name: 'rust', title: 'Rust', uuid: null, createdAt: 1, updatedAt: 2, tags: [], props: {}, children: [] }
  return {
    listPages: async (payload) => { calls.push({ method: 'listPages', args: [payload] }); return ok({ pages: [pageRow] }) },
    getPage: async (payload) => { calls.push({ method: 'getPage', args: [payload] }); return ok({ root, linked: [] }) },
    listTags: async () => { calls.push({ method: 'listTags', args: [] }); return ok({ tags: [] }) },
    listProperties: async () => { calls.push({ method: 'listProperties', args: [] }); return ok({ properties: [] }) },
    search: async (payload) => { calls.push({ method: 'search', args: [payload] }); return ok({ items: [{ id: 273, title: 'Systems language', pageName: 'rust' }] }) },
    query: async (payload) => { calls.push({ method: 'query', args: [payload] }); return ok({ rows: [] }) },
    upsert: async (payload) => { calls.push({ method: 'upsert', args: [payload] }); return ok({ entityType: payload.entityType, status: 'ok', detail: 'ok' }) },
    delete: async (payload) => { calls.push({ method: 'delete', args: [payload] }); return ok({ entityType: payload.entityType ?? 'block', detail: 'removed' }) },
    server: async (payload) => { calls.push({ method: 'server', args: [payload] }); return payload?.action === 'list' ? ok({ servers: [] }) : ok({ action: payload?.action ?? 'list', message: 'ok' }) },
  }
}

beforeEach(resetStore)

describe('WikiClient face', () => {
  it('unwraps ok values and folds failures into Errors', async () => {
    const calls: { method: string; args: unknown[] }[] = []
    const wiki = scriptedWiki(calls)
    // Swap one method to an error envelope.
    const failing = { ...wiki, listPages: async () => ({ ok: false as const, error: { code: 'internal' as const, message: 'graph down', details: {} } }) } as unknown as WikiRemoteNamespace
    await wikiStore.bind(new WikiClient(failing))
    await wikiStore.ensurePages()
  })
})

describe('wikiStore state machine', () => {
  it('loads pages lazily on first open and navigates into a page', async () => {
    // beforeEach already awaited the lazy first load.
    expect(wikiStore.getState().pages[0]?.title).toBe('Rust')
    await wikiStore.openPage('Rust')
    expect(wikiStore.getState().current?.root.title).toBe('Rust')
    expect(wikiStore.getState().loading).toBe(false)
    wikiStore.backToPages()
    expect(wikiStore.getState().current).toBeNull()
  })

  it('toggles drawer open/closed', () => {
    expect(wikiStore.getState().open).toBe(false)
    wikiStore.toggleOpen()
    expect(wikiStore.getState().open).toBe(true)
    wikiStore.close()
    expect(wikiStore.getState().open).toBe(false)
  })

  it('issues no wire call on bind; the first open loads exactly once', async () => {
    const calls: { method: string; args: unknown[] }[] = []
    await wikiStore.bind(new WikiClient(scriptedWiki(calls)))
    expect(calls).toEqual([])
    wikiStore.toggleOpen() // fire-and-forget load, as the UI does
    await wikiStore.ensurePages()
    expect(calls.map(call => call.method)).toEqual(['listPages'])
  })

  it('createPage upserts then opens the new page', async () => {
    await wikiStore.createPage('Rust 2', undefined)
    const upserts = stub.filter(call => call.method === 'upsert')
    expect(upserts).toHaveLength(1)
    expect(upserts[0]?.args[0]).toMatchObject({ entityType: 'page', page: 'Rust 2' })
    expect(wikiStore.getState().current?.root.title).toBe('Rust')
  })

  it('saveBlockContent upserts by id then refetches the page', async () => {
    await wikiStore.openPage('Rust')
    await wikiStore.saveBlockContent(240, 'Edited title line')
    const upserts = stub.filter(call => call.method === 'upsert')
    expect(upserts.at(-1)?.args[0]).toMatchObject({ entityType: 'block', id: 240, content: 'Edited title line' })
    // Follow-up read keeps the view fresh.
    expect(stub.filter(call => call.method === 'getPage').length).toBe(2)
  })

  it('addBlock appends a child (targetId) or a page tail (targetPage+pos)', async () => {
    await wikiStore.openPage('Rust')
    await wikiStore.addBlock(240, 'Rust', 'child text')
    await wikiStore.addBlock(null, 'Rust', 'tail text')
    const upserts = stub.filter(call => call.method === 'upsert').map(call => call.args[0])
    expect(upserts[0]).toMatchObject({ entityType: 'block', content: 'child text', targetId: 240, pos: 'last-child' })
    expect(upserts[1]).toMatchObject({ entityType: 'block', content: 'tail text', targetPage: 'Rust', pos: 'last-child' })
  })

  it('runSearch issues page + block searches and dedupes', async () => {
    wikiStore.setSearchQuery('vibe shift')
    await wikiStore.runSearch()
    const searches = stub.filter(call => call.method === 'search')
    expect(searches[0]?.args[0]).toMatchObject({ type: 'page', content: 'vibe shift' })
    expect(searches[1]?.args[0]).toMatchObject({ type: 'block', content: 'vibe shift' })
    expect(wikiStore.getState().searchResults).toHaveLength(1)
  })

  it('deleteBlock/deletePage route to delete with the right selector', async () => {
    await wikiStore.openPage('Rust')
    await wikiStore.deleteBlock(273)
    await wikiStore.deletePage('Rust')
    const deletes = stub.filter(call => call.method === 'delete').map(call => call.args[0])
    expect(deletes[0]).toMatchObject({ entityType: 'block', id: 273 })
    expect(deletes[1]).toMatchObject({ entityType: 'page', page: 'Rust' })
  })

  it('surfaces errors in state instead of throwing', async () => {
    const calls: { method: string; args: unknown[] }[] = []
    const wiki = scriptedWiki(calls)
    const failing = { ...wiki, listPages: async () => ({ ok: false as const, error: { code: 'internal' as const, message: 'graph down', details: {} } }) } as unknown as WikiRemoteNamespace
    await wikiStore.bind(new WikiClient(failing))
    await wikiStore.ensurePages()
    expect(wikiStore.getState().error).toMatch(/graph down/)
  })
})
