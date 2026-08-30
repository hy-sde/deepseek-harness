/**
 * Wire-shape entities of the `wiki` Remote namespace. Plain JSON values so the
 * same shapes cross the /api wire untouched; structural mirrors of
 * `@deepseek-ai/dsh-logseq-graph`'s service contract without importing that
 * host package into a browser bundle.
 *
 * The request types are thin: one `@Remote` method takes one request object so
 * the client calls `remote.wiki.getPage({ id })` exactly as the service reads
 * it.
 * @module @deepseek-ai/dsh-api-wiki-controller/types
 */

/** A tag reference (class entity) attached to a page/block. */
export interface WikiTagRef {
  id: number
  name: string | null
  title: string | null
}

/** One block node in a page tree (recursive children). */
export interface WikiBlockNode {
  id: number
  uuid: string | null
  /** Raw block text (may embed `key:: value` property lines and [[refs]]). */
  content: string
  order: string | null
  createdAt: number | null
  updatedAt: number | null
  tags: WikiTagRef[]
  children: WikiBlockNode[]
}

/** Page root of `wiki.getPage` (db/page + nested block tree). */
export interface WikiPageRoot {
  id: number
  name: string | null
  title: string
  uuid: string | null
  createdAt: number | null
  updatedAt: number | null
  tags: WikiTagRef[]
  /** Property refs (user.property/&lt;name&gt;-&lt;hash&gt;) mapped to their value-block ids. */
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

/** Flat page row (`wiki.listPages`; excludes built-ins unless requested). */
export interface WikiPageRow {
  id: number
  title: string | null
  updatedAt: number | null
  createdAt: number | null
}

/** Flat tag row (`wiki.listTags`). */
export interface WikiTagRow {
  id: number
  name: string | null
  title: string | null
}

/** Flat property row (`wiki.listProperties`). */
export interface WikiPropertyRow {
  id: number
  name: string | null
  title: string | null
}

/** Generic search hit (`wiki.search`). */
export interface WikiSearchItem {
  id: number
  title: string
  /** Page the hit lives on, when the row carries one (else null). */
  pageName: string | null
}

/** One db-worker-node server row (`wiki.server`). */
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

/** `wiki.upsert` request payload (passthrough of the graph seam's args). */
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

/** `wiki.delete` request payload. */
export interface WikiDeleteRequest {
  entityType?: 'block' | 'page' | 'tag' | 'property'
  id?: number
  uuid?: string
  page?: string
  name?: string
}

/** `wiki.delete` acknowledgement. */
export interface WikiDeleteValue {
  entityType: string
  detail: string
}

/** `wiki.server` request: action + optional graph name. */
export interface WikiServerRequest {
  action?: 'list' | 'start' | 'stop' | 'restart' | 'cleanup'
  name?: string
}

/** `wiki.server` response: the table or an action acknowledgement. */
export type WikiServerRequestValue = WikiServerListValue | WikiServerActionValue
/** `wiki.server` list response: the current server table. */
export interface WikiServerListValue {
  servers: WikiServerRow[]
}
/** `wiki.server` action response. */
export interface WikiServerActionValue {
  action: string
  message: string
}

/** `wiki.listPages` request payload. */
export interface WikiListPagesRequest {
  includeBuiltIn?: boolean
  limit?: number
  offset?: number
}

/** `wiki.getPage` request selector (mutually exclusive). */
export interface WikiGetPageRequest {
  page?: string
  id?: number
  uuid?: string
}

/** `wiki.search` request payload. */
export interface WikiSearchRequest {
  type?: 'block' | 'page' | 'property' | 'tag'
  content: string
  limit?: number
}

/** `wiki.query` request payload. */
export interface WikiQueryRequest {
  query: string
  inputs?: string
  limit?: number
}

/** `wiki.listPages` value. */
export interface WikiListPagesValue {
  pages: WikiPageRow[]
}
/** `wiki.listTags` value. */
export interface WikiListTagsValue {
  tags: WikiTagRow[]
}
/** `wiki.listProperties` value. */
export interface WikiListPropertiesValue {
  properties: WikiPropertyRow[]
}
/** `wiki.search` value. */
export interface WikiSearchValue {
  items: WikiSearchItem[]
}
/** Any JSON-serializable value a Datascript query can return. */
export type WikiJson = null | boolean | number | string | WikiJson[] | { [key: string]: WikiJson }

/** `wiki.query` value: the unflattened Datascript result rows. */
export interface WikiQueryValue {
  rows: WikiJson
}

/** Stable wiki failure details returned by unary methods. */
export interface WikiErrorDetailsMap {
  /** The graph seam is not mounted in this deployment. */
  'wiki-unavailable': Record<never, never>
  /** The headless CLI reported a `status:'error'` envelope. */
  'wiki-cli-error': { readonly detail: string }
  /** A seam failure outside the classified vocabulary. */
  internal: Record<never, never>
}

/** Wiki business failure returned without throwing a carrier error. */
export type WikiError = {
  [Code in keyof WikiErrorDetailsMap]: {
    readonly code: Code
    readonly message: string
    readonly details: WikiErrorDetailsMap[Code]
  }
}[keyof WikiErrorDetailsMap]
