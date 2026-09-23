# Memory

English | [中文](memory.zh.md)

**Agent-curated long-horizon memory** — durable, project-scoped memory the agent curates itself, ported from the [oh-my-pi](https://github.com/oh-my-pi) coding-agent memory surface (see `port_omp.md` item 4). Two packages compose it: [dsh-memory](../../packages/memory/memory) owns `ctx.memory` — a host-plane service with a backend registry and a shipped `local` backend that persists files under `<harness home>/memories/<project>/` — and [dsh-tool-memory](../../packages/memory/tool-memory) provides the model-facing `retain`/`recall`/`reflect`/`memory_edit`/`learn` tools plus a `memory:project` system-prompt section that reloads the calling session's project memory at the start of every session.

Memory is complementary to session-query and compaction rather than overlapping them: those replay the conversation ledger, while this bank answers "what did we decide / prefer / learn here?" across sessions. It lives host-plane because the store is durable project data that easily outlives one session; per-session tool packages resolve it.

`ctx.memory` delegates to the selected backend (default: the first registered; the shipped `local` provider mounts when `backend` is unset or `local`). Only `local` ships in this port — the registry keeps the seam open for Hindsight/Mnemopi-style providers later, and any new provider registers one `MemoryBackend` and the same tools work unchanged.

## Layout and data model

Each project (encoded absolute cwd) gets one memory root with three artifacts:

- - `bank.jsonl.zstd` — editable working entries written by `retain` (id, content, context, source, importance, timestamps, active flag). Backs `memory_edit`. By default the on-disk format is the same zstd frame container as session logs: each save batch is one checksummed frame, append-only and self-healing. The pre-rename plaintext `bank.jsonl` is still read and is migrated on the first write; set `compression: 'none'` in `LocalMemoryConfig` for the original line-append format.
- - `learned.md` — newest-first, deduped, capped (100) lesson bullets written by `learn`; the same format and normalization omp keeps.
- - `memory_summary.md` — optional consolidated summary (hand- or tool-maintained) surfaced by `recall`, `reflect`, and prompt injection.

Stored text is injection-neutralized (control chars, `<`/backticks, `~~~` fences) and secret-redacted on both write and read. Search is lexical IDF scoring with light stemming over all three artifacts; `memory_edit` can `update`/`forget`/`invalidate` bank entries, while lesson and summary entries are read-only facts.

The `local` backend is pure `node:fs` with an in-process per-file write chain, so concurrent saves from sibling sessions can never drop each other's writes. Mutations emit `memory/change` (`{ cwd }`) so in-process consumers can invalidate caches.

Provider source: [`packages/memory/memory/src/local.ts`](../../packages/memory/memory/src/local.ts). Contract source: [`packages/memory/memory/src/types.ts`](../../packages/memory/memory/src/types.ts).

## The service and the plugin

`MemoryService` (`ctx.memory`) owns the registry (`register`/`unregister`/ `resolve`/`backendIds`) and thin delegation of `status`/`save`/`learn`/ `search`/`edit`/`summaries`/`clear` to the selected backend, emitting `memory/change` after each mutation. `dsh-memory`'s plugin mounts the service and, when selected, the `local` backend. `dsh-tool-memory` contributes only the model-facing surface: five tools over `ctx.memory` and the `memory:project` system-prompt section (order 150, empty when the project has no memory yet). The generated [`ctx.memory` section](#ctxmemory--memoryservice) below shows the exact signatures.

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
