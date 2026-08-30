# Wiki 图谱

[English](wiki.md) | 中文

Wiki 缝——通过 [dsh-logseq-graph](../../packages/logseq/logseq-graph) 服务把安装的 `logseq` CLI 包装成内嵌 LLM-wiki（`ctx.wikiGraph`），再由 [dsh-api-wiki-controller](../../packages/api/wiki-controller) 宿主控制器（`ctx.wikiController`）经 Typert `wiki` Remote 命名空间暴露给 GUI 客户端。浏览器端表面（抽屉 + 侧栏开关）位于 [dsh-client-ui-wiki](../../packages/client/ui-wiki)。

控制器把 logseq-graph 的线上数据投影到其声明形状上——页面行、带反向链接引用的嵌套块树、标签/属性列表、文本搜索、原始 Datalog 查询行以及 upsert/remove/server 操作——并对失败分类（图缝缺失时为 `wiki-unavailable`，携带 CLI 细节的 `wiki-cli-error`，其余为 `internal`）。

来源：[`packages/logseq/logseq-graph/src/service.ts`](../../packages/logseq/logseq-graph/src/service.ts)

## 坐标

两个服务都是 web profile 的宿主层行：`logseq-graph` 拥有 `llm-wiki` 图谱配置，`wiki-controller` 每进程只注册一个 `wiki` Remote 命名空间，`ui-wiki` 挂载抽屉与侧栏开关而不声明任意槽位。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
