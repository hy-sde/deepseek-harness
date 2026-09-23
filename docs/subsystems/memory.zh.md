# Memory

[English](memory.md) | 中文

**面向代理的长期记忆** —— 由代理自行策展、按项目隔离的持久化记忆，移植自[oh-my-pi](https://github.com/oh-my-pi) 编程代理的记忆体系（见`port_omp.md` 第 4 项）。由两个包组成：[dsh-memory](../../packages/memory/memory) 提供 `ctx.memory`——宿主平面的服务，带后端注册表和内置的 `local` 后端，将文件持久化到`<harness home>/memories/<project>/`；[dsh-tool-memory](../../packages/memory/tool-memory)提供面向模型的 `retain`/`recall`/`reflect`/`memory_edit`/`learn` 工具，外加一个`memory:project` 系统提示区段，在每次会话开始时重新载入调用会话的项目记忆。

记忆与会话查询、压缩互补而非重叠：后者回放会话账本，而此记忆库回答跨会话的“我们之前决定/偏好/学到了什么？”。它位于宿主平面，因为存储是轻易跨越单个会话的持久化项目数据；按会话挂载的工具包解析它。

`ctx.memory` 委托给选中的后端（默认：首个注册；`backend` 未设置或为 `local`时挂载内置的 `local` 提供方）。本移植仅内置 `local`——注册表为后续Hindsight/Mnemopi 式提供方保留接缝，任何新提供方只需注册一个`MemoryBackend`，同样的工具即可无缝使用。

## 布局与数据模型

每个项目（编码后的绝对 cwd）对应一个记忆根，含三个工件：

- - `bank.jsonl.zstd` — 由 `retain` 写入的可编辑工作条目（id、内容、上下文、来源、重要性、时间戳、活跃标志）。支撑 `memory_edit`。默认磁盘格式与会话日志相同的zstd 帧容器：每次保存批次是一帧带校验的帧，追加友好且可自愈。更名前的纯文本`bank.jsonl` 仍会被读取，并在首次写入时迁移；在 `LocalMemoryConfig` 中设置`compression: 'none'` 可恢复原逐行追加格式。
- - `learned.md` — 由 `learn` 写入的、新在前、去重、限容（100 条）的教训列表；与 omp 保持相同的格式和归一化。
- - `memory_summary.md` — 可选的整合摘要（手工或工具维护），由 `recall`、`reflect` 与提示注入呈现。

存储文本在写入与读取时都会做注入中和（控制字符、`<`/反引号、`~~~` 围栏）与密钥脱敏。搜索是对三个工件做词法 IDF 评分并辅以轻量词干匹配；`memory_edit`可对银行条目执行 `update`/`forget`/`invalidate`，而教训与摘要条目是只读事实。

`local` 后端纯 `node:fs` 实现，带进程内按文件写链，因此来自并将会话的并发写入绝不会互相覆盖。变更会发出 `memory/change`（`{ cwd }`），供进程内消费者失效缓存。

提供方源码：[`packages/memory/memory/src/local.ts`](../../packages/memory/memory/src/local.ts)。契约源码：[`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts)。

## 服务与插件

`MemoryService`（`ctx.memory`）拥有注册表（`register`/`unregister`/`resolve`/`backendIds`）并将 `status`/`save`/`learn`/`search`/`edit`/`summaries`/`clear` 薄委托给选中的后端，每次变更后发出 `memory/change`。`dsh-memory` 的插件挂载该服务，并在被选中时挂载 `local` 后端；`dsh-tool-memory` 只贡献面向模型的表面：五个基于 `ctx.memory` 的工具和`memory:project` 系统提示区段（order 150，项目尚无记忆时为空）。下方生成的[`ctx.memory` 区段](#ctxmemory--memoryservice) 展示了确切的签名。

```ts type-equiv
/** One memory operation is rooted at the calling session's project. */
interface MemoryContext {
  /** Absolute working directory of the calling session (the project key). */
  cwd: string
  /** Best-effort cancellation signal; observed before/after underlying IO. */
  signal?: AbortSignal
}
```

```ts type-equiv
/** Input to store one memory (`retain` stores items; `learn` stores lessons). */
interface MemorySaveInput {
  /** The durable, self-contained content to remember. */
  content: string
  /** Optional source context for the fact. */
  context?: string
  /** Origin label; defaults to `retain`/`learn` at the call sites. */
  source?: string
  /** Importance in `[0, 1]`; defaults to the backend's baseline. */
  importance?: number
  /** Optional originating session id, captured for cross-session origin. */
  sessionId?: string
}
```

```ts type-equiv
/** Outcome of one storage call. */
interface MemorySaveResult {
  /** The assigned stable id, when the backend reports one. */
  id?: string
  /** Number of entries actually stored (0 = sanitized empty). */
  stored: number
  /** Human summary for the calling tool. */
  message: string
}
```

```ts type-equiv
/** Operations `memory_edit` supports, mirroring omp's mnemopi edits. */
type MemoryEditOp = 'update' | 'forget' | 'invalidate'
```

```ts type-equiv
/** Input for {@link MemoryBackend.edit}. */
interface MemoryEditInput {
  /** Target memory id (bank ids are editable; lesson/summary ids are not). */
  id: string
  /** Replacement content for `update` (required unless `importance` set). */
  content?: string
  /** Replacement importance for `update` (optional, clamped to `[0,1]`). */
  importance?: number
  /** Superseding id for `invalidate` (optional). */
  replacementId?: string
}
```

```ts type-equiv
/** Outcome of one `memory_edit`. */
interface MemoryEditResult {
  /** Canonical status word the tool surfaces. */
  status: 'updated' | 'forgotten' | 'invalidated' | 'not_found' | 'not_editable'
  /** Optional qualifier (which store/files were touched). */
  message?: string
}
```

```ts type-equiv
/** Snapshot describing one backend's active memory store. */
interface MemoryStatus {
  /** Backend id (`local`, …). */
  backend: string
  /** Whether the backend is active and answering. */
  active: boolean
  /** Whether it accepts writes. */
  writable: boolean
  /** Whether it supports structured search. */
  searchable: boolean
  /** Display scope (memory root / bank id). */
  scope?: string
  /** Count of editable working entries. */
  workingCount?: number
  /** Count of captured lessons. */
  lessonCount?: number
  /** Timestamp (ms epoch) of the most recent write. */
  lastMemoryAt?: number
  /** Optional human note. */
  message?: string
}
```

```ts type-equiv
/** The storage strategy behind `ctx.memory`. */
interface MemoryBackend {
  /** Stable backend id, e.g. `local`. */
  readonly id: string
  /** Snapshot the store's state. */
  status(context: MemoryContext): Promise<MemoryStatus>
  /** Store one durable memory (retain). */
  save(context: MemoryContext, input: MemorySaveInput): Promise<MemorySaveResult>
  /** Capture one durable lesson (learn). */
  learn(context: MemoryContext, input: MemorySaveInput): Promise<MemorySaveResult>
  /** Semantic/lexical search across the store. */
  search(context: MemoryContext, query: string, options?: MemorySearchOptions): Promise<MemorySearchResult>
  /** Update / forget / invalidate one working entry by id. */
  edit(context: MemoryContext, op: MemoryEditOp, input: MemoryEditInput): Promise<MemoryEditResult>
  /** The material for prompt injection (summary + lessons as one block). */
  summaries(context: MemoryContext): Promise<MemorySummaries>
  /** Wipe all state for one project scope. */
  clear(context: MemoryContext): Promise<void>
  /**
   * Read one stored entry by id (the `memory://<id>` internal-URL read).
   * Optional: only addressable stores implement it (the shipped `local`
   * backend derives bank ids from `edit`; a server-side engine without
   * id-addressable entries leaves it undefined and the `memory://` handler
   * returns the corrective "not addressable" error). Returns `undefined` when
   * the id does not exist in this project's scope.
   */
  readEntry?(context: MemoryContext, id: string): Promise<MemoryEntryView | undefined>
  /**
   * Every addressable entry in this project's scope, newest first — the
   * candidate set for `memory://` completions. Optional for the same reason as
   * {@link MemoryBackend.readEntry}; absent means `memory://<id>` cannot be
   * completed from this store.
   * @param context - session identity (cwd) whose project is listed.
   * @param limit - maximum number of views to return.
   */
  listEntries?(context: MemoryContext, limit: number): Promise<MemoryEntryView[]>
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memoryservice"></a>

### `ctx.memory` — `MemoryService`

The public `ctx.memory` service. Backends register into the registry; the service resolves the configured (or first) backend and delegates every operation. Mutations emit `memory/change` so in-process consumers (tool prompt caches) can invalidate without re-reading on every assembly.

```ts cordis-catalog
/**
 * Register (or replace) a backend by id; the first registration also becomes
 * the selection when none is configured.
 * @param backend - backend to register under {@link MemoryBackend.id backend.id}.
 * @returns disposer that removes this backend and clears the selection if it was the selection.
 */
register(backend: MemoryBackend): () => void

/**
 * Remove the backend for `id`.
 * @param id - backend id to remove.
 * @returns true when a backend was removed, false when none matched.
 */
unregister(id: string): boolean

/**
 * The selected backend (configured id when registered, else the first
 * registered).
 * @returns the active backend, or undefined when none is registered.
 */
resolve(): MemoryBackend | undefined

/**
 * Every registered backend id.
 * @returns registered backend ids.
 */
backendIds(): string[]

/**
 * Backend availability and scope for the calling session's project.
 * @param context - session identity (cwd) the status describes.
 * @returns the resolved backend's status.
 */
async status(context: MemoryContext): Promise<MemoryStatus>

/**
 * Store one memory entry (the `retain` tool's service path). Emits
 * `memory/change` for the project after the write lands.
 * @param context - session identity (cwd) whose project receives the entry.
 * @param input - content, optional context, source, and importance.
 * @returns whether something was stored plus a human result line.
 */
async save(context: MemoryContext, input: MemorySaveInput): Promise<MemorySaveResult>

/**
 * Append a durable lesson (the `learn` tool's service path). Emits
 * `memory/change` for the project after the write lands.
 * @param context - session identity (cwd) whose project receives the lesson.
 * @param input - lesson content, optional context, source, importance.
 * @returns whether something was stored plus a human result line.
 */
async learn(context: MemoryContext, input: MemorySaveInput): Promise<MemorySaveResult>

/**
 * Relevance-ranked search over the project's bank, lessons, and summary.
 * @param context - session identity (cwd) whose project is searched.
 * @param query - natural-language query.
 * @param options - result cap override (`limit`) when provided.
 * @returns ranked matching entries.
 */
async search(context: MemoryContext, query: string, options?: MemorySearchOptions): Promise<MemorySearchResult>

/**
 * Apply a memory edit (`update`/`forget`/`invalidate` by recall id). Emits
 * `memory/change` for the project after the write lands.
 * @param context - session identity (cwd) whose project is edited.
 * @param op - edit operation.
 * @param input - target id plus operation fields.
 * @returns the edit outcome status.
 */
async edit(context: MemoryContext, op: MemoryEditOp, input: MemoryEditInput): Promise<MemoryEditResult>

/**
 * The project's injectable memory block plus its raw parts.
 * @param context - session identity (cwd) whose project summaries are read.
 * @returns summary/learned/bank text and the combined injection block.
 */
async summaries(context: MemoryContext): Promise<MemorySummaries>

/**
 * Wipe one project's memory root. Emits `memory/change` for the project.
 * @param context - session identity (cwd) whose project is cleared.
 * @returns a promise that settles once the root is removed.
 */
async clear(context: MemoryContext): Promise<void>
```

Source: [`packages/memory/memory/src/service.ts`](../../packages/memory/memory/src/service.ts)

<a id="memory-events"></a>

### `memory/*` events

<a id="memorychange--emit"></a>

#### `memory/change` — emit

A durable memory mutation (`save`/`learn`/`edit`/`clear`) committed for one project; `cwd` identifies the project whose files changed. In-process consumers (caches, watchers) refresh on this notification. Emitted after the write lands, so listeners never observe half-applied state.

```ts cordis-catalog
/**
 * A durable memory mutation (`save`/`learn`/`edit`/`clear`) committed for
 * one project; `cwd` identifies the project whose files changed. In-process
 * consumers (caches, watchers) refresh on this notification. Emitted after
 * the write lands, so listeners never observe half-applied state.
 * @mode emit
 * @param payload Project-root cwd whose memory changed.
 */
'memory/change'(payload: { cwd: string }): void
```

Source: [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
