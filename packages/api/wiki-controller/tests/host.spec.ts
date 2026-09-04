import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  LogseqCliError,
  type LogseqGraphService,
} from '@deepseek-ai/dsh-logseq-graph'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { WikiController } from '../src/index.ts'

/** A stub graph seam recording calls; every method returns the canned value. */
function stubGraph(overrides: Partial<Record<
  'listPages' | 'getPage' | 'listTags' | 'listProperties' | 'search' | 'query' | 'upsert' | 'remove' | 'server',
  (request: unknown) => unknown
>> = {}): { graph: LogseqGraphService; calls: string[] } {
  const calls: string[] = []
  const canned: Record<string, (request: unknown) => unknown> = {
    listPages: () => ({ pages: [{ id: 1, title: 'Rust', updatedAt: 1, createdAt: 1 }] }),
    getPage: () => ({
      root: { id: 1, name: 'rust', title: 'Rust', uuid: null, createdAt: 1, updatedAt: 1, tags: [], props: {}, children: [] },
      linked: [],
    }),
    listTags: () => ({ tags: [{ id: 2, name: 'topic', title: 'topic' }] }),
    listProperties: () => ({ properties: [{ id: 3, name: 'user.property/status', title: 'status' }] }),
    search: () => ({ items: [{ id: 4, title: 'hit', pageName: null }] }),
    query: () => ({ rows: [] }),
    upsert: () => ({ entityType: 'page', status: 'ok' as const, detail: 'upserted' }),
    remove: () => ({ entityType: 'block', detail: 'removed' }),
    server: () => ({ servers: [] }),
  }
  const wire = (method: 'listPages' | 'getPage' | 'listTags' | 'listProperties' | 'search' | 'query' | 'upsert' | 'server') =>
    async (request: never) => {
      calls.push(method)
      const selected = overrides[method] ?? canned[method]
      return (selected as (request: unknown) => unknown)(request)
    }
  const graph = {
    listPages: wire('listPages'),
    getPage: wire('getPage'),
    listTags: wire('listTags'),
    listProperties: wire('listProperties'),
    search: wire('search'),
    query: wire('query'),
    upsert: wire('upsert'),
    // The seam method is `remove`; the Remote wire vocabulary names it `delete`.
    remove: async (request: never) => {
      calls.push('delete')
      const selected = overrides.remove ?? canned.remove
      return (selected as (request: unknown) => unknown)(request)
    },
    server: wire('server'),
  } as unknown as LogseqGraphService
  return { graph, calls }
}

function host(overrides?: Parameters<typeof stubGraph>[0]): { ctx: Context; controller: WikiController; calls: string[] } {
  const { graph, calls } = stubGraph(overrides)
  const ctx = new Context()
  ctx.provide('wikiGraph', graph)
  const controller = new WikiController(ctx)
  return { ctx, controller, calls }
}

describe('WikiController Remote face', () => {
  it('registers the wiki namespace under the wikiController service name', () => {
    const { ctx } = host()
    expect(ctx.get('wikiController')).toBeInstanceOf(WikiController)
  })

  it('listPages passes through paging options and projects the seam result', async () => {
    const { controller, calls } = host()
    await expect(controller.listPages({ includeBuiltIn: true, limit: 10, offset: 2 })).resolves.toEqual({
      pages: [{ id: 1, title: 'Rust', updatedAt: 1, createdAt: 1 }],
    })
    expect(calls).toEqual(['listPages'])
  })

  it('getPage passes the selector through and returns root + linked refs', async () => {
    const { controller, calls } = host()
    await expect(controller.getPage({ id: 1 })).resolves.toMatchObject({
      root: { id: 1, name: 'rust' },
      linked: [],
    })
    expect(calls).toEqual(['getPage'])
  })

  it('search, query, upsert, delete and server all reach the seam', async () => {
    const { controller, calls } = host()
    await controller.search({ content: 'x' })
    await controller.query({ query: '[:find ?e]' })
    await controller.upsert({ entityType: 'page', name: 'Zig' })
    await controller.delete({ entityType: 'block', id: 9 })
    await controller.server({ action: 'list' })
    expect(calls).toEqual(['search', 'query', 'upsert', 'delete', 'server'])
  })

  it('classifies a CLI envelope error as wiki-cli-error', async () => {
    const cli = new LogseqCliError('boom', ['list', 'page'], '', '', 1, { message: 'boom' })
    const { controller } = host({ search: () => { throw cli } })
    await expect(controller.search({ content: 'x' })).rejects.toMatchObject({
      code: 'wiki-cli-error', message: 'boom',
    })
  })

  it('classifies a missing graph seam as wiki-unavailable', async () => {
    const ctx = new Context()
    const controller = new WikiController(ctx)
    await expect(controller.listPages({})).rejects.toMatchObject({ code: 'wiki-unavailable' })
  })

  it('classifies a generic seam throw as internal carrying the method name', async () => {
    const { controller } = host({ query: () => { throw new Error('nope') } })
    const message: unknown = expect.stringContaining('wiki.query')
    await expect(controller.query({ query: '[:find ?e]' })).rejects.toMatchObject({
      code: 'internal', message,
    })
  })

  it('passes RemoteFailures through unchanged', async () => {
    void vi
    const failure = new RemoteError('wiki-cli-error', 'keep me', { detail: 'keep me' })
    const { controller } = host({ listTags: () => { throw failure } })
    await expect(controller.listTags()).rejects.toBe(failure)
  })
})
