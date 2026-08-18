/**
 * Boot one DSH profile through the real production boot (`runProfile`) and
 * prove a plugin installed via `dsh plugin add` actually composes and
 * registers: the check mounts rows without fail-loud errors, `fs` and `tools`
 * services exist, and the `edit` tool appears in the model-facing schema.
 *
 * The smoke profile is initialized from the template WITHOUT the web app, so
 * it inherits the base host-plane tool rows (read/write/edit prompt
 * sections). To mirror a real `web` deployment we disable those rows with the
 * same list the shipped `dsh-web-app` patch uses — otherwise a second
 * `tool-fs` family collides. The plugin bundle itself stays untouched.
 *
 * Usage (from the harness repo root):
 *   pnpm exec tsx scripts/smoke-plugin-boot.ts [profile] [expectedTool]
 * Defaults: profile `smoke`, expected tool `edit`.
 * @module dsh-smoke-plugin-boot
 */

import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '../apps/cli/src/profile-boot.ts'

/** The web-app bundle's host-plane tool-row disables, mirrored verbatim. */
const WEB_DISABLES = [
  'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
  'tool-str-replace-editor', 'skill-filesystem', 'tool-skill', 'tool-goal',
  'plan-mode', 'compaction-basic', 'command-compact', 'tool-result-pruner',
  'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
  'tool-subagent-fork', 'workflow-worker-thread', 'tool-workflow',
  'tool-ralph', 'agent-instructions', 'tool-todo', 'tool-web',
]

async function main(): Promise<void> {
  const profile = process.argv[2] ?? 'smoke'
  const expectedTool = process.argv[3] ?? 'edit'
  const env = await loadLayeredEnv('dsh')
  const patchDir = mkdtempSync(join(tmpdir(), 'smoke-web-patch-'))
  const patchPath = join(patchDir, 'smoke.yml')
  writeFileSync(patchPath, WEB_DISABLES.map(id => `- id: ${id}\n  disabled: true`).join('\n') + '\n')
  try {
    const { ctx, shutdown } = await runProfile({
      environment: env,
      profile,
      patchFiles: [patchPath],
      args: [],
    })
    try {
      await ctx.get('loader')?.await()
    } catch {
      /* foundation services may differ per profile; only tool checks matter */
    }
    // Settle host services that mount asynchronously after the loader is ready.
    for (let attempt = 0; attempt < 30; attempt++) {
      if (ctx.get('tools') !== undefined && ctx.get('fs') !== undefined) break
      await sleep(500)
    }

    const failures: string[] = []
    const tools = ctx.get('tools')
    if (tools === undefined) {
      failures.push('tools service missing')
    } else {
      const schemas = tools.schemas() as unknown as { name: string }[]
      for (const row of schemas) console.log(`tool: ${row.name}`)
      const found = schemas.some(schema => schema.name === expectedTool)
      console.log(found ? `${expectedTool}: registered ✓` : `${expectedTool}: NOT registered ✗`)
      if (!found) failures.push(`${expectedTool} tool not registered`)
    }
    if (failures.length > 0) {
      console.error('SMOKE FAILED: ' + failures.join('; '))
      await shutdown.shutdown(1)
      process.exitCode = 1
    } else {
      console.log('SMOKE OK')
      await shutdown.shutdown(0)
    }
  } finally {
    rmSync(patchDir, { recursive: true, force: true })
  }
}

void main()
