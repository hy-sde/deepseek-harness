/**
 * `wiki` Remote namespace backed by the headless logseq graph seam. The
 * controller is the one Remote face over `ctx.wikiGraph`: it narrows the
 * service's CLI arguments to the wire request shapes, projects the service's
 * results untouched, and classifies every refusal as a `wiki-*`
 * `TypertRemoteFailure`. No model-facing tool surface lives here — the tool
 * package keeps owning that contract (@module @deepseek-ai/dsh-tool-logseq).
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  LogseqCliError,
  type LogseqGraphService,
} from '@deepseek-ai/dsh-logseq-graph'
import { Remote, TypertRemoteFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  WikiGetPageRequest,
  WikiGetPageValue,
  WikiListPagesRequest,
  WikiListPagesValue,
  WikiListPropertiesValue,
  WikiListTagsValue,
  WikiQueryRequest,
  WikiQueryValue,
  WikiRemoveRequest,
  WikiRemoveValue,
  WikiSearchRequest,
  WikiSearchValue,
  WikiServerRequest,
  WikiServerRequestValue,
  WikiUpsertRequest,
  WikiUpsertValue,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `wiki` Remote namespace. */
    wikiController: typeof WikiController
  }
}

/** The graph seam's own refusal, one `status:'error'` envelope from the CLI. */
function cliFailure(error: LogseqCliError): TypertRemoteFailure {
  const detail = typeof error.payload === 'string' ? error.payload : error.payload.message
  return new TypertRemoteFailure({
    code: 'wiki-cli-error',
    message: error.message,
    details: { detail: detail ?? error.message },
  })
}

/** Any non-classified failure of the graph seam. */
function internal(message: string): TypertRemoteFailure {
  return new TypertRemoteFailure({ code: 'internal', message, details: {} })
}

/**
 * Host service backing the generated `ctx.remote.wiki` namespace. Every
 * `@Remote` method takes one narrow request object, mirrors the graph seam's
 * JSON shapes, and not the internals of the CLI.
 */
export class WikiController extends TypertRemoteService {
  /**
   * Register the `wiki` namespace beside the graph seam it reads.
   * @param ctx - Host context where `ctx.wikiGraph` may be mounted.
   */
  constructor(ctx: Context) {
    super(ctx, 'wikiController', { namespace: 'wiki' })
  }

  /** The resolution seam; its absence is a deployment refusal, not an internal error. */
  private get graph(): LogseqGraphService {
    const graph = this.ctx.get('wikiGraph') as LogseqGraphService | undefined
    if (graph === undefined) {
      throw new TypertRemoteFailure({
        code: 'wiki-unavailable',
        message: 'no wiki graph service is mounted',
        details: {},
      })
    }
    return graph
  }

  /**
   * List pages (built-ins excluded unless requested).
   * @param request - paging/filter options.
   * @returns flat page rows.
   */
  @Remote
  async listPages(request: WikiListPagesRequest): Promise<WikiListPagesValue> {
    return this.graph.listPages({
      ...(request.includeBuiltIn === undefined ? {} : { includeBuiltIn: request.includeBuiltIn }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      ...(request.offset === undefined ? {} : { offset: request.offset }),
    }).then(success => success, this.reject('listPages'))
  }

  /**
   * Get one page root with its nested block tree and linked references.
   * @param request - page/id/uuid selector (mutually exclusive).
   * @returns the page value.
   */
  @Remote
  async getPage(request: WikiGetPageRequest): Promise<WikiGetPageValue> {
    return this.graph.getPage(request).then(success => success, this.reject('getPage'))
  }

  /**
   * List user tags.
   * @returns flat tag rows.
   */
  @Remote
  async listTags(): Promise<WikiListTagsValue> {
    return this.graph.listTags().then(success => success, this.reject('listTags'))
  }

  /**
   * List properties.
   * @returns flat property rows.
   */
  @Remote
  async listProperties(): Promise<WikiListPropertiesValue> {
    return this.graph.listProperties().then(success => success, this.reject('listProperties'))
  }

  /**
   * Search pages/blocks/properties/tags by text content.
   * @param request - type/content/limit.
   * @returns hits.
   */
  @Remote
  async search(request: WikiSearchRequest): Promise<WikiSearchValue> {
    return this.graph.search(request).then(success => success, this.reject('search'))
  }

  /**
   * Run a Datascript query.
   * @param request - query text + optional inputs/limit.
   * @returns the unflattened result rows.
   */
  @Remote
  async query(request: WikiQueryRequest): Promise<WikiQueryValue> {
    return this.graph.query(request).then(success => success as unknown as WikiQueryValue, this.reject('query'))
  }

  /**
   * Create/update a page/block/tag/property.
   * @param request - the requested entity change (one logical change per call).
   * @returns an acknowledgement; `dryRun` returns what would be run.
   */
  @Remote
  async upsert(request: WikiUpsertRequest): Promise<WikiUpsertValue> {
    return this.graph.upsert({ ...request } as Record<string, unknown>).then(success => success, this.reject('upsert'))
  }

  /**
   * Remove a page/block/tag/property. Destruction is permanent.
   * @param request - entityType + one selector.
   * @returns an acknowledgement.
   */
  @Remote
  async remove(request: WikiRemoveRequest): Promise<WikiRemoveValue> {
    return this.graph.remove(request).then(success => success, this.reject('remove'))
  }

  /**
   * Server lifecycle: list the db-worker-node servers, or run start/stop/restart/cleanup.
   * @param request - action + optional graph name.
   * @returns the server table for `list`, otherwise an action acknowledgement.
   */
  @Remote
  async server(request: WikiServerRequest): Promise<WikiServerRequestValue> {
    return this.graph.server(request.action ?? 'list', request).then(
      success => success as WikiServerRequestValue,
      this.reject('server'),
    )
  }

  /** Classify one seam refusal into the Remote failure vocabulary. */
  private reject(method: string): (error: unknown) => never {
    return (error: unknown): never => {
      throw this.classify(method, error)
    }
  }

  /** Map whatever the seam threw onto the Remote failure vocabulary. */
  private classify(method: string, error: unknown): TypertRemoteFailure {
    if (error instanceof TypertRemoteFailure) return error
    if (error instanceof LogseqCliError) return cliFailure(error)
    return internal(`wiki.${method}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export default WikiController
