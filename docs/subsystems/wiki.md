# Wiki graph

English | [中文](wiki.zh.md)

The wiki seam — an embedded LLM-wiki (`ctx.wikiGraph`) backed by the installed `logseq` CLI through the [dsh-logseq-graph](../../packages/logseq/logseq-graph) service, exposed to GUI clients over the Typert `wiki` Remote namespace by the [dsh-api-wiki-controller](../../packages/api/wiki-controller) host controller (`ctx.wikiController`). The browser-half surface (drawer + sidebar toggle) lives in [dsh-client-ui-wiki](../../packages/client/ui-wiki).

The controller projects the logseq-graph wire onto its declared shapes — page rows, nested block trees with linked references, tag/property listings, text search, raw Datalog query rows, and upsert/remove/server actions — and classifies failures (`wiki-unavailable` when the graph seam is missing, `wiki-cli-error` carrying the CLI detail, `internal` otherwise).

Source: [`packages/logseq/logseq-graph/src/service.ts`](../../packages/logseq/logseq-graph/src/service.ts)

## Coordinates

Both services are host-plane rows in the web profile: `logseq-graph` owns the `llm-wiki` graph configuration, `wiki-controller` registers the single `wiki` Remote namespace per process, and `ui-wiki` mounts the drawer and sidebar toggle without declaring slots.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxwikicontroller--wikicontroller"></a>

### `ctx.wikiController` — `WikiController`

Host service backing the generated `ctx.remote.wiki` namespace. Every `@Remote` method takes one narrow request object, mirrors the graph seam's JSON shapes, and not the internals of the CLI.

```ts cordis-catalog
/**
 * List pages (built-ins excluded unless requested).
 * @param request - paging/filter options.
 * @returns flat page rows.
 */
@Remote async listPages(request: WikiListPagesRequest): Promise<WikiListPagesValue>

/**
 * Get one page root with its nested block tree and linked references.
 * @param request - page/id/uuid selector (mutually exclusive).
 * @returns the page value.
 */
@Remote async getPage(request: WikiGetPageRequest): Promise<WikiGetPageValue>

/**
 * List user tags.
 * @returns flat tag rows.
 */
@Remote async listTags(): Promise<WikiListTagsValue>

/**
 * List properties.
 * @returns flat property rows.
 */
@Remote async listProperties(): Promise<WikiListPropertiesValue>

/**
 * Search pages/blocks/properties/tags by text content.
 * @param request - type/content/limit.
 * @returns hits.
 */
@Remote async search(request: WikiSearchRequest): Promise<WikiSearchValue>

/**
 * Run a Datascript query.
 * @param request - query text + optional inputs/limit.
 * @returns the unflattened result rows.
 */
@Remote async query(request: WikiQueryRequest): Promise<WikiQueryValue>

/**
 * Create/update a page/block/tag/property.
 * @param request - the requested entity change (one logical change per call).
 * @returns an acknowledgement; `dryRun` returns what would be run.
 */
@Remote async upsert(request: WikiUpsertRequest): Promise<WikiUpsertValue>

/**
 * Remove a page/block/tag/property. Destruction is permanent.
 * @param request - entityType + one selector.
 * @returns an acknowledgement.
 */
@Remote async remove(request: WikiRemoveRequest): Promise<WikiRemoveValue>

/**
 * Server lifecycle: list the db-worker-node servers, or run start/stop/restart/cleanup.
 * @param request - action + optional graph name.
 * @returns the server table for `list`, otherwise an action acknowledgement.
 */
@Remote async server(request: WikiServerRequest): Promise<WikiServerRequestValue>
```

Source: [`packages/api/wiki-controller/src/index.ts`](../../packages/api/wiki-controller/src/index.ts)

<a id="ctxwikigraph--logseqgraphservice"></a>

### `ctx.wikiGraph` — `LogseqGraphService`

The `ctx.wikiGraph` service implementation: one bound CLI executor + the graph surface of the LLM-wiki workflow.

```ts cordis-catalog
/** List pages (built-ins excluded unless requested).
 * @param options - paging/filter options.
 * @returns projected page rows. */
async listPages(options?: { includeBuiltIn?: boolean; limit?: number; offset?: number }): Promise<{ pages: PageRow[] }>

/** List user tags.
 * @returns projected tag rows. */
async listTags(): Promise<{ tags: TagRow[] }>

/** List properties.
 * @returns projected property rows. */
async listProperties(): Promise<{ properties: PropertyRow[] }>

/** Get one page root with its nested block tree and linked references.
 * @param options - page/id/uuid selector (mutually exclusive).
 * @returns root tree + linked references. */
async getPage(options: { page?: string; id?: number; uuid?: string }): Promise<GetPageResult>

/** Search pages/blocks/properties/tags by text content.
 * @param options - type/content/limit.
 * @returns search hits (page hits carry no pageName; block hits do). */
async search(options: { type?: 'block' | 'page' | 'property' | 'tag'; content: string; limit?: number }): Promise<{ items: SearchItem[] }>

/** Run a Datascript query; returns the raw result rows.
 * @param options - query text + optional inputs/limit.
 * @returns the unflattened `result` value. */
async query(options: { query: string; inputs?: string; limit?: number }): Promise<{ rows: unknown }>

/** Create/update a page/block/tag/property. Mirrors the CLI flag surface.
 * @param args - the requested entity change (one logical change per call).
 * @returns an acknowledgement; `dryRun` returns what would be run. */
async upsert(args: Record<string, unknown>): Promise<UpsertResult>

/** Remove a page/block/tag/property. Destruction is permanent.
 * @param args - entityType + one selector (id/uuid/page/name).
 * @returns an acknowledgement. */
async remove(args: { entityType?: string; id?: number; uuid?: string; page?: string; name?: string }): Promise<RemoveResult>

/** Server lifecycle: list the db-worker-node servers, or run start/stop/restart/cleanup.
 * @param action - the lifecycle verb; `list` (default) returns the server table.
 * @param options - optional graph name for start/stop/restart.
 * @returns the server table for `list`, otherwise an action acknowledgement. */
async server(action?: 'list' | 'start' | 'stop' | 'restart' | 'cleanup', options?: { name?: string }): Promise<ServerListResult | ServerActionResult>
```

Source: [`packages/logseq/logseq-graph/src/service.ts`](../../packages/logseq/logseq-graph/src/service.ts)
<!-- END GENERATED cordis-surface -->
