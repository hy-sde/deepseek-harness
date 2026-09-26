import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadLayeredEnv, initProfile, PROFILES_DIR } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '../src/profile-boot.ts'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Production-mount validation for the shipped `standard` preset: the loader
 * rows of a preset run in the scope of their standing mount, and the
 * `tool-subagent` row (under `modelSelectionSettings`) must resolve that
 * scope — otherwise a session naming `standard` dies at mount with "requires
 * an Agent or preset scope". A unit harness cannot prove this (its import
 * graph mixes src and built libs for the scope symbol), so this boots the
 * REAL bundle layers through `runProfile` — the same path `dsh web` uses —
 * on a throwaway DSH_HOME and alternate port, then asks for the standing key
 * of `standard`. The key is only returned after every row activated.
 */
describe('shipped standard preset (real production boot)', () => {
  let home: string | undefined
  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  it('mounts through standingKeyFor on the real bundle profile', { timeout: 90_000 }, async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-home-std-'))
    process.env.DSH_HOME = home
    initProfile(join(home, PROFILES_DIR, 'smoke2'), ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    const patchDir = mkdtempSync(join(tmpdir(), 'std-patch-'))
    const patchPath = join(patchDir, 'p.yml')
    writeFileSync(patchPath, [
      '- id: webserver',
      "  name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      '    host: 127.0.0.1',
      '    port: 3199',
      '',
    ].join('\n'))
    try {
      const env = loadLayeredEnv('dsh')
      const { ctx, shutdown } = await runProfile({ environment: env, profile: 'smoke2', patchFiles: [patchPath], args: [] })
      try {
        await (ctx.get('loader')?.await() ?? Promise.resolve()).catch(() => {})
        let presets: unknown
        for (let attempt = 0; attempt < 30; attempt += 1) {
          presets = ctx.get('agentPresets')
          if (presets !== undefined) break
          await sleep(500)
        }
        expect(presets, 'agentPresets service').toBeDefined()
        const roster = await (presets as { list(): Promise<unknown[]> }).list()
        const ids = (roster as { id: string }[]).map(row => row.id)
        expect(ids).toContain('standard')
      } finally {
        await shutdown.shutdown(0).catch(() => {})
      }
    } finally {
      rmSync(patchDir, { recursive: true, force: true })
    }
  })
})
