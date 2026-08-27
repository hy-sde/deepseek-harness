/**
 * ui-wiki unit coverage: task-marker/property parsing and the store's state
 * machine over a scripted wiki wire face (no DOM needed — jsdom-free).
 * The store is the single source of wire traffic, so these tests pin the
 * upsert/remove argument shapes the drawer's actions produce.
 */

import { describe, expect, it, beforeEach } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { taskMarkerOf } from '../src/client/BlockTree.tsx'
import { WikiClient } from '../src/client/api.ts'
import { wikiStore } from '../src/client/store.ts'

async function resetStore(): Promise<void> {
  // Re-bind a scripted client after each test so recorded calls reset, and
  // await the initial page load so every test starts from a settled store.
  const calls: { method: string; args: unknown[] }[] = []
  stub = calls
  await wikiStore.bind(new WikiClient(scriptedWiki(calls)))
}

let stub: { method: string; args: unknown[] }[] = []

/** A scripted IApiClient['wiki'] that records every call. */
function scriptedWiki(calls: { method: string; args: unknown[] }[]): IApiClient['wiki'] {
  const wire = <T>(method: string, produce: () => T) => async (): Promise<{ rpcId: string; result: { ok: true; value: T } }> => {
    calls.push({ method, args: [] })
    return { rpcId: '', result: { ok: true, value: produce() } }
  }
  const wirePayload = <T>(method: string, produce: (payload: unknown) => T) =>
    async (payload: unknown): Promise<{ rpcId: string; result: { ok: true; value: T } }> => {
      calls.push({ method, args: [payload] })
      return { rpcId: '', result: { ok: true, value: produce(payload) } }
    }
  const pageRow = { id: 240, title: 'Rust', updatedAt: 1787808165009, createdAt: 1787808086650 }
  const root = { id: 240, name: 'rust', title: 'Rust', uuid: null, createdAt: 1, updatedAt: 2, tags: [], props: {}, children: [] }
  return {
    listPages: wirePayload('listPages', () => ({ pages: [pageRow] })),
    getPage: wirePayload('getPage', () => ({ root, linked: [] })),
    listTags: wire('listTags', () => ({ tags: [] })),
    listProperties: wire('listProperties', () => ({ properties: [] })),
    listTasks: wirePayload('listTasks', () => ({ tasks: [{ id: 274, content: 'review borrow checker ergonomics', status: 'done', priority: null, scheduled: null, deadline: null }] })),
    search: wirePayload('search', () => ({ items: [{ id: 273, title: 'Systems language', pageName: 'rust' }] })),
    query: wirePayload('query', () => ({ rows: [] })),
    upsert: wirePayload('upsert', payload => ({ entityType: (payload as { entityType: string }).entityType, status: 'ok' as const, detail: 'ok' })),
    remove: wirePayload('remove', payload => ({ entityType: (payload as { entityType?: string }).entityType ?? 'block', detail: 'removed' })),
    server: wirePayload('server', () => ({ servers: [] })),
  } as unknown as IApiClient['wiki']
}

beforeEach(resetStore)

describe('taskMarkerOf', () => {
  it('detects leading task markers', () => {
    expect(taskMarkerOf('DONE review borrow checker')).toBe('DONE')
    expect(taskMarkerOf('TODO write release notes')).toBe('TODO')
    expect(taskMarkerOf('LATER maybe')).toBe('LATER')
    expect(taskMarkerOf('DOING in progress')).toBe('DOING')
  })

  it('returns null for plain content and nested markers', () => {
    expect(taskMarkerOf('review borrow checker')).toBeNull()
    expect(taskMarkerOf('refers to DONE elsewhere')).toBeNull()
  })
})

describe('WikiClient face', () => {
  it('unwraps ok values and folds failures into Errors', async () => {
    const calls: { method: string; args: unknown[] }[] = []
    const wiki = scriptedWiki(calls)
    // Swap one method to an error envelope.
    const failing = { ...wiki, listPages: async () => ({ rpcId: '', result: { ok: false as const, error: { code: 'internal' as const, message: 'graph down', details: {} } } }) } as unknown as IApiClient['wiki']
    await wikiStore.bind(new WikiClient(failing))
  })
})

describe('wikiStore state machine', () => {
  it('loads pages on bind and navigates into a page', async () => {
    // beforeEach already awaited the initial load.
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

  it('toggleTask issues task upserts with done/todo status', async () => {
    await wikiStore.openPage('Rust')
    await wikiStore.toggleTask(274, 'TODO')
    await wikiStore.toggleTask(274, 'DONE')
    const tasks = stub.filter(call => call.method === 'upsert').map(call => call.args[0])
    expect(tasks[0]).toMatchObject({ entityType: 'task', id: 274, status: 'done' })
    expect(tasks[1]).toMatchObject({ entityType: 'task', id: 274, status: 'todo' })
  })

  it('runSearch issues page + block searches and dedupes', async () => {
    wikiStore.setSearchQuery('vibe shift')
    await wikiStore.runSearch()
    const searches = stub.filter(call => call.method === 'search')
    expect(searches[0]?.args[0]).toMatchObject({ type: 'page', content: 'vibe shift' })
    expect(searches[1]?.args[0]).toMatchObject({ type: 'block', content: 'vibe shift' })
    expect(wikiStore.getState().searchResults).toHaveLength(1)
  })

  it('deleteBlock/deletePage route to remove with the right selector', async () => {
    await wikiStore.openPage('Rust')
    await wikiStore.deleteBlock(273)
    await wikiStore.deletePage('Rust')
    const removes = stub.filter(call => call.method === 'remove').map(call => call.args[0])
    expect(removes[0]).toMatchObject({ entityType: 'block', id: 273 })
    expect(removes[1]).toMatchObject({ entityType: 'page', page: 'Rust' })
  })

  it('surfaces errors in state instead of throwing', async () => {
    const calls: { method: string; args: unknown[] }[] = []
    const wiki = scriptedWiki(calls)
    const failing = { ...wiki, listPages: async (payload: { includeBuiltIn?: boolean; limit?: number; offset?: number }) => { void payload; return { rpcId: '', result: { ok: false as const, error: { code: 'internal' as const, message: 'graph down', details: {} } } } } } as unknown as IApiClient['wiki']
    await wikiStore.bind(new WikiClient(failing))
    expect(wikiStore.getState().error).toMatch(/graph down/)
  })
})
