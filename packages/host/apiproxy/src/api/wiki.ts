/**
 * wiki domain contract: thin RPC seam over the host `ctx.wikiGraph` service
 * (headless Logseq CLI). The wire view types are intentionally structural
 * mirrors of `@deepseek-ai/dsh-logseq-graph`'s service shapes — plain JSON,
 * zero Node deps, importable from the browser via the api/ contract bundle.
 *
 * Method signatures are the source of truth: unary methods take the narrow
 * RpcRequest<P> form and the impl echoes rpcId.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** A tag reference attached to a page/block. */
export interface WikiTagRef {
  id: number
  name: string | null
  title: string | null
}

/** One block node in a page tree (recursive children). */
export interface WikiBlockNode {
  id: number
  uuid: string | null
  content: string
  order: string | null
  createdAt: number | null
  updatedAt: number | null
  tags: WikiTagRef[]
  children: WikiBlockNode[]
}

/** Page root of wiki.getPage. */
export interface WikiPageRoot {
  id: number
  name: string | null
  title: string
  uuid: string | null
  createdAt: number | null
  updatedAt: number | null
  tags: WikiTagRef[]
  /** Property refs (user.property/&lt;name&gt;-&lt;hash&gt;) → value-block db ids. */
  props: Record<string, number>
  children: WikiBlockNode[]
}

/** A page + its linked references. */
export interface WikiGetPageValue {
  root: WikiPageRoot
  linked: WikiLinkedBlock[]
}

/** One linked-reference block (a foreign block referencing the page). */
export interface WikiLinkedBlock {
  id: number
  content: string
  pageName: string | null
  pageTitle: string | null
  pageId: number | null
  updatedAt: number | null
}

/** Flat page row. */
export interface WikiPageRow {
  id: number
  title: string | null
  updatedAt: number | null
  createdAt: number | null
}

/** Flat tag row. */
export interface WikiTagRow {
  id: number
  name: string | null
  title: string | null
}

/** Flat property row. */
export interface WikiPropertyRow {
  id: number
  name: string | null
  title: string | null
}

/** Generic search hit. */
export interface WikiSearchItem {
  id: number
  title: string
  pageName: string | null
}

/** One db-worker-node server row. */
export interface WikiServerRow {
  id: number | null
  name: string | null
  url: string | null
  status: string
  graph: string | null
  port: number | null
}

/** upsert acknowledgement mirroring the CLI envelope. */
export interface WikiUpsertValue {
  entityType: string
  status: 'ok' | 'dry-run'
  detail: string
  id?: number
}

/** Upsert request payload (passthrough of service args). */
export interface WikiUpsertRequest {
  entityType: 'block' | 'page' | 'tag' | 'property'
  page?: string
  name?: string
  content?: string
  id?: number
  uuid?: string
  targetPage?: string
  targetId?: number
  pos?: string
  propertyType?: string
  cardinality?: string
  status?: string
  priority?: string
  scheduled?: string
  deadline?: string
  updateTags?: string[]
  removeTags?: string[]
  updateProperties?: Record<string, string | number | boolean>
  removeProperties?: string[]
  restore?: boolean
  dryRun?: boolean
}

/** remove request payload. */
export interface WikiRemoveRequest {
  entityType?: 'block' | 'page' | 'tag' | 'property'
  id?: number
  uuid?: string
  page?: string
  name?: string
}

/** remove acknowledgement. */
export interface WikiRemoveValue {
  entityType: string
  detail: string
}

/** server request: action + optional graph name. */
export interface WikiServerRequest {
  action?: 'list' | 'start' | 'stop' | 'restart' | 'cleanup'
  name?: string
}

/** server response: the table or an action acknowledgement. */
export type WikiServerRequestValue = WikiServerListValue | WikiServerActionValue
export interface WikiServerListValue { servers: WikiServerRow[] }
export interface WikiServerActionValue { action: string; message: string }

/** wiki domain unary methods. Wire values are the host service's own JSON shapes. */
export interface WikiApi {
  /** List pages (built-ins excluded unless requested). */
  listPages(request: RpcRequest<{ includeBuiltIn?: boolean; limit?: number; offset?: number }>):
  Promise<RpcResponse<{ pages: WikiPageRow[] }>>

  /** Get one page root with its nested block tree + linked references. */
  getPage(request: RpcRequest<{ page?: string; id?: number; uuid?: string }>):
  Promise<RpcResponse<WikiGetPageValue>>

  /** List user tags. */
  listTags(request: RpcRequest<{}>): Promise<RpcResponse<{ tags: WikiTagRow[] }>>

  /** List properties. */
  listProperties(request: RpcRequest<{}>): Promise<RpcResponse<{ properties: WikiPropertyRow[] }>>

  /** Search pages/blocks/properties/tags by text content. */
  search(request: RpcRequest<{ type?: 'block' | 'page' | 'property' | 'tag'; content: string; limit?: number }>):
  Promise<RpcResponse<{ items: WikiSearchItem[] }>>

  /** Run a Datascript query. */
  query(request: RpcRequest<{ query: string; inputs?: string; limit?: number }>):
  Promise<RpcResponse<{ rows: unknown }>>

  /** Create/update a page/block/tag/property. */
  upsert(request: RpcRequest<WikiUpsertRequest>): Promise<RpcResponse<WikiUpsertValue>>

  /** Remove a page/block/tag/property. Destruction is permanent. */
  remove(request: RpcRequest<WikiRemoveRequest>): Promise<RpcResponse<WikiRemoveValue>>

  /** Server lifecycle: list/start/stop/restart/cleanup. */
  server(request: RpcRequest<WikiServerRequest>): Promise<RpcResponse<WikiServerRequestValue>>
}
