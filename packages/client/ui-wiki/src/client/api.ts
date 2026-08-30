/**
 * Typed wiki API face over the mounted `ctx.remote.wiki` namespace. Keeps every
 * wire call in one place (page list, page read, search, upsert, remove,
 * server) and converts the Remote result envelope into plain values or Errors
 * the store can surface. All shapes come from the controller's `./types`
 * export, so no host package leaks into this browser bundle.
 */

import type {} from '@deepseek-ai/dsh-api-wiki-controller/remote'
import type {
  WikiGetPageRequest,
  WikiGetPageValue,
  WikiListPagesRequest,
  WikiPageRow,
  WikiPropertyRow,
  WikiQueryRequest,
  WikiRemoveRequest,
  WikiRemoveValue,
  WikiSearchItem,
  WikiSearchRequest,
  WikiServerRequest,
  WikiServerRequestValue,
  WikiTagRow,
  WikiUpsertRequest,
  WikiUpsertValue,
} from '@deepseek-ai/dsh-api-wiki-controller/types'
import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'

export type { WikiPageRow } from '@deepseek-ai/dsh-api-wiki-controller/types'
export type { WikiSearchItem } from '@deepseek-ai/dsh-api-wiki-controller/types'
export type { WikiGetPageValue } from '@deepseek-ai/dsh-api-wiki-controller/types'
export type { WikiBlockNode } from '@deepseek-ai/dsh-api-wiki-controller/types'

/** The mounted `wiki` Remote namespace as the generated map declares it. */
export type WikiRemoteNamespace = TypertRemoteNamespaceMap['wiki']

/** Result of one wiki Remote call after unwrapping the result envelope. */
function unwrap<T>(response: Promise<RemoteResult<T>>): Promise<T> {
  return response.then((result) => {
    if (result.ok) return result.value
    throw new Error(`${result.error.code}: ${result.error.message}`)
  })
}

/** One bound wiki client (safe to construct once per connection). */
export class WikiClient {
  constructor(private readonly wiki: WikiRemoteNamespace) {}

  /**
   * List pages.
   * @param options - paging/filter options.
   * @returns page rows.
   */
  listPages(options?: WikiListPagesRequest): Promise<{ pages: WikiPageRow[] }> {
    return unwrap(this.wiki.listPages(options ?? {}))
  }

  /**
   * Get one page tree + linked references.
   * @param options - page/id/uuid selector.
   * @returns the page value.
   */
  getPage(options: WikiGetPageRequest): Promise<WikiGetPageValue> {
    return unwrap(this.wiki.getPage(options))
  }

  /**
   * List user tags.
   * @returns tag rows.
   */
  listTags(): Promise<{ tags: WikiTagRow[] }> {
    return unwrap(this.wiki.listTags())
  }

  /**
   * List properties.
   * @returns property rows.
   */
  listProperties(): Promise<{ properties: WikiPropertyRow[] }> {
    return unwrap(this.wiki.listProperties())
  }

  /**
   * Search pages/blocks by text.
   * @param options - type/content/limit.
   * @returns hits.
   */
  search(options: WikiSearchRequest): Promise<{ items: WikiSearchItem[] }> {
    return unwrap(this.wiki.search(options))
  }

  /**
   * Run a Datascript query.
   * @param request - query text + optional inputs/limit.
   * @returns the raw result rows.
   */
  query(request: WikiQueryRequest): Promise<{ rows: unknown }> {
    return unwrap(this.wiki.query(request))
  }

  /**
   * Create/update one entity.
   * @param request - entity args.
   * @returns the acknowledgement.
   */
  upsert(request: WikiUpsertRequest): Promise<WikiUpsertValue> {
    return unwrap(this.wiki.upsert(request))
  }

  /**
   * Remove one entity.
   * @param request - entity selector.
   * @returns the acknowledgement.
   */
  remove(request: WikiRemoveRequest): Promise<WikiRemoveValue> {
    return unwrap(this.wiki.remove(request))
  }

  /**
   * Server lifecycle.
   * @param request - action + optional graph name.
   * @returns table or ack.
   */
  server(request?: WikiServerRequest): Promise<WikiServerRequestValue> {
    return unwrap(this.wiki.server({ action: 'list', ...request }))
  }
}
