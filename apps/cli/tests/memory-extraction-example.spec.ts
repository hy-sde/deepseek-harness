/**
 * Example-overlay mount proof for automatic memory extraction: load the
 * `apps/cli/config/examples/memory-extraction/cordis.yml` patch over a minimal
 * base (storage hub + memory + llm), let the real Cordis Loader settle, and
 * prove (a) every row activates — the `inject: ['memory', 'llm']` host row
 * resolves — and (b) a `compaction/summary` event reaches the engine over the
 * real control unit: an empty range is settled as `skipped` with zero model
 * calls. Re-emits are safe: the engine is idempotent per (session, boundary).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite/src/index.ts'
import { Config } from '@deepseek-ai/dsh-storage-sqlite/src/index.ts'
import { MemoryExtractionControlStore } from '@deepseek-ai/dsh-memory-extraction/src/control.ts'

const root = resolve(import.meta.dirname, '../../..')
const examplePatch = join(root, 'apps/cli/config/examples/memory-extraction/cordis.yml')
const baseConfig = join(root, 'apps/cli/tests/fixtures/memory-extraction-base.cordis.yml')

const liveContexts = new Set<Context>()

afterEach(async () => {
  await Promise.all([...liveContexts].map(async ctx => ctx.fiber.dispose()))
  liveContexts.clear()
})

describe('memory-extraction example overlay', () => {
  it('mounts over the base, activates the row, and settles an empty range on a real compaction event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-extraction-'))
    const memoryRoot = join(dir, 'memory-root')
    const sqlitePath = join(dir, 'control.sqlite')
    const prevMemory = process.env.DSH_TEST_MEMORY_ROOT
    const prevSqlite = process.env.DSH_MEMORY_EXTRACTION_DB
    process.env.DSH_TEST_MEMORY_ROOT = memoryRoot
    process.env.DSH_MEMORY_EXTRACTION_DB = sqlitePath
    try {
      const patches: PatchOptions[] = loadOverlayPatches('memory-extraction-example-test', examplePatch)
      expect(patches).toHaveLength(1)
      const ctx = await boot(
        'memory-extraction-example-test',
        baseConfig,
        patches,
        () => {},
      )
      liveContexts.add(ctx)

      const session = {
        id: SessionId('smoke-session'),
        header: { cwd: memoryRoot, origin: 'user' },
        requestHeader: () => ({ config: { provider: 'smoke-provider', model: 'smoke-model' } }),
        snapshotEvents: (_from: number, _to: number) => [] as SessionEvent[],
      } as unknown as Session
      const event = {
        type: 'compaction/summary',
        seq: 3,
        time: 1_000,
        data: { checkpoint: true },
      } as unknown as SessionEvent

      // Read the control unit from a second backend handle (the plugin's own
      // unit stays open inside the booted tree). Re-emit until the listener
      // has attached and the empty range was settled; repeated events are
      // idempotent (deterministic operation id per session + boundary seq).
      const second = new SqliteStorageBackend(new Config({ path: sqlitePath }))
      let unit
      try {
        unit = await second.kv.open(MemoryExtractionControlStore.descriptor)
        const store = MemoryExtractionControlStore.open(unit)
        await waitForCursorWithEmit(ctx, store, session, event, sqlitePath)
        expect(await store.readCursor('smoke-session')).toMatchObject({ processedSeq: 3 })
      } finally {
        await unit?.close()
        await second.close()
      }
      expect(ctx.get('loader')).toBeDefined()
    } finally {
      process.env.DSH_TEST_MEMORY_ROOT = prevMemory
      process.env.DSH_MEMORY_EXTRACTION_DB = prevSqlite
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)
})

async function waitForCursorWithEmit(
  ctx: Context,
  store: MemoryExtractionControlStore,
  session: Session,
  event: SessionEvent,
  sqlitePath: string,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    ctx.emit('session/event', session, event)
    await sleep(50)
    const cursor = await store.readCursor('smoke-session')
    if (cursor?.processedSeq === 3) return
    if (Date.now() - started > 10_000) {
      throw new Error(`cursor for smoke-session never reached 3 (sqlite file: ${sqlitePath})`)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveTick => setTimeout(resolveTick, ms))
}
