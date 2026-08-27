/**
 * wiki domain zod schemas. Every wiki value is the host service's own JSON
 * shape (structural mirror of `@deepseek-ai/dsh-logseq-graph`), so the
 * request schemas below are the host's validation gate for CLI-bound inputs:
 * the UI is protected from its own typos before anything spawns `logseq`.
 */

import { z } from 'zod'
import type { Wire } from './rpc.schema.ts'
import type { RequestPayload, ResponseValue } from './index.ts'
import type {
  WikiBlockNode, WikiLinkedBlock, WikiPageRoot, WikiPropertyRow, WikiSearchItem,
  WikiServerRow, WikiTagRef, WikiTaskRow, WikiUpsertRequest, WikiUpsertValue,
} from './wiki.ts'

/** Literal-like integer (db ids). Positive or zero. */
const dbId = z.number().int().min(0)

const tagRefSchema = z.object({
  id: dbId,
  name: z.string().nullable(),
  title: z.string().nullable(),
}) as unknown as z.ZodType<Wire<WikiTagRef>>

const blockNodeSchema: z.ZodType<Wire<WikiBlockNode>> = z.lazy(() => z.object({
  id: dbId,
  uuid: z.string().nullable(),
  content: z.string(),
  order: z.string().nullable(),
  createdAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  tags: z.array(tagRefSchema),
  children: z.array(blockNodeSchema),
}))

const linkedBlockSchema = z.object({
  id: dbId,
  content: z.string(),
  pageName: z.string().nullable(),
  pageTitle: z.string().nullable(),
  pageId: dbId.nullable(),
  updatedAt: z.number().nullable(),
}) as unknown as z.ZodType<Wire<WikiLinkedBlock>>

/** wiki.listPages request payload. */
export const wikiListPagesRequestSchema = z.object({
  includeBuiltIn: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
}) as unknown as z.ZodType<Wire<RequestPayload<'wiki.listPages'>>>

/** wiki.listPages response value. */
export const wikiListPagesValueSchema = z.object({
  pages: z.array(z.object({
    id: dbId,
    title: z.string().nullable(),
    updatedAt: z.number().nullable(),
    createdAt: z.number().nullable(),
  })),
}) as unknown as z.ZodType<Wire<ResponseValue<'wiki.listPages'>>>

/** wiki.getPage request payload. */
export const wikiGetPageRequestSchema = z.object({
  page: z.string().optional(),
  id: dbId.optional(),
  uuid: z.string().optional(),
}).refine(v => v.page !== undefined || v.id !== undefined || v.uuid !== undefined, {
  message: 'wiki.getPage requires one of page / id / uuid',
}) as unknown as z.ZodType<Wire<RequestPayload<'wiki.getPage'>>>

/** wiki.getPage response value. */
export const wikiGetPageValueSchema = z.object({
  root: z.object({
    id: dbId,
    name: z.string().nullable(),
    title: z.string(),
    uuid: z.string().nullable(),
    createdAt: z.number().nullable(),
    updatedAt: z.number().nullable(),
    tags: z.array(tagRefSchema),
    props: z.record(z.string(), dbId),
    children: z.array(blockNodeSchema),
  }) as unknown as z.ZodType<Wire<WikiPageRoot>>,
  linked: z.array(linkedBlockSchema),
}) as unknown as z.ZodType<Wire<ResponseValue<'wiki.getPage'>>>

/** wiki.listTags request payload + response value. */
export const wikiListTagsRequestSchema = z.object({}) as unknown as z.ZodType<Wire<RequestPayload<'wiki.listTags'>>>
export const wikiListTagsValueSchema = z.object({
  tags: z.array(z.object({
    id: dbId,
    name: z.string().nullable(),
    title: z.string().nullable(),
  })),
}) as unknown as z.ZodType<Wire<ResponseValue<'wiki.listTags'>>>

/** wiki.listProperties request payload + response value. */
export const wikiListPropertiesRequestSchema = z.object({}) as unknown as z.ZodType<Wire<RequestPayload<'wiki.listProperties'>>>
export const wikiListPropertiesValueSchema = z.object({
  properties: z.array(z.object({
    id: dbId,
    name: z.string().nullable(),
    title: z.string().nullable(),
  })) as unknown as z.ZodType<Wire<WikiPropertyRow[]>>,
}) as unknown as z.ZodType<Wire<ResponseValue<'wiki.listProperties'>>>

/** wiki.listTasks request payload + response value. */
export const wikiListTasksRequestSchema = z.object({
  status: z.string().optional(),
}) as unknown as z.ZodType<Wire<RequestPayload<'wiki.listTasks'>>>
export const wikiListTasksValueSchema = z.object({
  tasks: z.array(z.object({
    id: dbId,
    content: z.string(),
    status: z.string().nullable(),
    priority: z.string().nullable(),
    scheduled: z.string().nullable(),
    deadline: z.string().nullable(),
  })) as unknown as z.ZodType<Wire<WikiTaskRow[]>>,
}) as unknown as z.ZodType<Wire<ResponseValue<'wiki.listTasks'>>>

/** wiki.search request payload + response value. */
export const wikiSearchRequestSchema = z.object({
  type: z.enum(['block', 'page', 'property', 'tag']).default('block').optional(),
  content: z.string().min(1),
  limit: z.number().int().min(1).max(500).optional(),
}) as unknown as z.ZodType<Wire<RequestPayload<'wiki.search'>>>
export const wikiSearchValueSchema = z.object({
  items: z.array(z.object({
    id: dbId,
    title: z.string(),
    pageName: z.string().nullable(),
  }) as unknown as z.ZodType<Wire<WikiSearchItem>>),
}) as unknown as z.ZodType<Wire<ResponseValue<'wiki.search'>>>

/** wiki.query request payload + response value. */
export const wikiQueryRequestSchema = z.object({
  query: z.string().min(1),
  inputs: z.string().optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
}) as unknown as z.ZodType<Wire<RequestPayload<'wiki.query'>>>
export const wikiQueryValueSchema = z.object({
  rows: z.unknown(),
}) as unknown as z.ZodType<Wire<ResponseValue<'wiki.query'>>>

/** wiki.upsert request payload (passthrough service args → CLI flags). */
export const wikiUpsertRequestSchema = z.object({
  entityType: z.enum(['block', 'page', 'tag', 'property', 'task']),
  page: z.string().optional(),
  name: z.string().optional(),
  content: z.string().optional(),
  id: dbId.optional(),
  uuid: z.string().optional(),
  targetPage: z.string().optional(),
  targetId: dbId.optional(),
  pos: z.string().optional(),
  propertyType: z.string().optional(),
  cardinality: z.string().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  scheduled: z.string().optional(),
  deadline: z.string().optional(),
  updateTags: z.array(z.string()).optional(),
  removeTags: z.array(z.string()).optional(),
  updateProperties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  removeProperties: z.array(z.string()).optional(),
  restore: z.boolean().optional(),
  dryRun: z.boolean().optional(),
}).loose() as unknown as z.ZodType<Wire<WikiUpsertRequest>>

/** wiki.upsert response value. */
export const wikiUpsertValueSchema = z.object({
  entityType: z.string(),
  status: z.enum(['ok', 'dry-run']),
  detail: z.string(),
  id: dbId.optional(),
}) as unknown as z.ZodType<Wire<WikiUpsertValue>>

/** wiki.remove request payload + response value. */
export const wikiRemoveRequestSchema = z.object({
  entityType: z.enum(['block', 'page', 'tag', 'property']).optional(),
  id: dbId.optional(),
  uuid: z.string().optional(),
  page: z.string().optional(),
  name: z.string().optional(),
}).refine(v => v.id !== undefined || v.uuid !== undefined || v.page !== undefined || v.name !== undefined, {
  message: 'wiki.remove requires a selector: id / uuid / page / name',
}) as unknown as z.ZodType<Wire<RequestPayload<'wiki.remove'>>>
export const wikiRemoveValueSchema = z.object({
  entityType: z.string(),
  detail: z.string(),
}) as unknown as z.ZodType<Wire<ResponseValue<'wiki.remove'>>>

/** wiki.server request payload. */
export const wikiServerRequestSchema = z.object({
  action: z.enum(['list', 'start', 'stop', 'restart', 'cleanup']).default('list').optional(),
  name: z.string().optional(),
}) as unknown as z.ZodType<Wire<RequestPayload<'wiki.server'>>>

/** wiki.server response value (table or action acknowledgement). */
export const wikiServerValueSchema = z.union([
  z.object({ servers: z.array(z.object({
    id: dbId.nullable(),
    name: z.string().nullable(),
    url: z.string().nullable(),
    status: z.string(),
    graph: z.string().nullable(),
    port: dbId.nullable(),
  })) as unknown as z.ZodType<Wire<WikiServerRow[]>> }),
  z.object({ action: z.string(), message: z.string() }),
]) as unknown as z.ZodType<Wire<ResponseValue<'wiki.server'>>>
