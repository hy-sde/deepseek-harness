/**
 * Typed wiki API face over the connection's IApiClient. Keeps every wire call
 * in one place (page list, page read, search, upsert, remove,
 * server) and converts the RpcResponse envelope into plain values or Errors
 * the store can surface. All shapes are derived from IApiClient so no host
 * package leaks into this browser bundle.
 */

import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'

/** Payload type of one wiki client method (the IApiClient unary form takes the business payload directly). */
type Payload<K extends keyof IApiClient['wiki']> = Parameters<IApiClient['wiki'][K]>[0]

/** Success value type of one wiki client method. */
type Value<K extends keyof IApiClient['wiki']> =
  Extract<Awaited<ReturnType<IApiClient['wiki'][K]>>['result'], { ok: true }> extends { value: infer V } ? V : never

/** Flat page row over the wire. */
export type WikiPageRow = Value<'listPages'>['pages'][number]
/** One search hit over the wire. */
export type WikiSearchItem = Value<'search'>['items'][number]
/** getPage result: root tree + linked references. */
export type WikiGetPageValue = Value<'getPage'>
/** upsert acknowledgement over the wire. */
export type WikiUpsertValue = Value<'upsert'>
/** server response: table or action acknowledgement. */
export type WikiServerValue = Value<'server'>
/** Recursive outliner node: one block of the getPage tree. */
export type WikiBlockNode = NonNullable<WikiGetPageValue['root']['children']>[number]

/** Result of a unary wiki call after unwrapping the RpcResponse envelope. */
function unwrap<T>(response: { result: { ok: boolean; value?: T; error?: { code: string; message: string } } }): T {
  if (response.result.ok) return response.result.value as T
  throw new Error(`${String(response.result.error?.code)}: ${response.result.error?.message ?? 'unknown error'}`)
}

/** One bound wiki client (safe to construct once per connection). */
export class WikiClient {
  constructor(private readonly api: IApiClient['wiki']) {}

  /**
   * List pages.
   * @param options - paging/filter options.
   * @returns page rows.
   */
  listPages(options?: Payload<'listPages'>): Promise<Value<'listPages'>> {
    return this.api.listPages(options ?? {}).then(unwrap)
  }

  /**
   * Get one page tree + linked references.
   * @param options - page/id/uuid selector.
   * @returns the page value.
   */
  getPage(options: Payload<'getPage'>): Promise<Value<'getPage'>> {
    return this.api.getPage(options).then(unwrap)
  }

  /**
   * List user tags.
   * @returns tag rows.
   */
  listTags(): Promise<Value<'listTags'>> {
    return this.api.listTags({}).then(unwrap)
  }

  /**
   * Search pages/blocks by text.
   * @param options - type/content/limit.
   * @returns hits.
   */
  search(options: Payload<'search'>): Promise<Value<'search'>> {
    return this.api.search(options).then(unwrap)
  }

  /**
   * Create/update one entity.
   * @param request - entity args.
   * @returns the acknowledgement.
   */
  upsert(request: Payload<'upsert'>): Promise<Value<'upsert'>> {
    return this.api.upsert(request).then(unwrap)
  }

  /**
   * Remove one entity.
   * @param request - entity selector.
   * @returns the acknowledgement.
   */
  remove(request: Payload<'remove'>): Promise<Value<'remove'>> {
    return this.api.remove(request).then(unwrap)
  }

  /**
   * Server lifecycle.
   * @param request - action + optional graph name.
   * @returns table or ack.
   */
  server(request?: Payload<'server'>): Promise<Value<'server'>> {
    return this.api.server(request ?? {}).then(unwrap)
  }
}
