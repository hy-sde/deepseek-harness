/**
 * Kernel-exit diagnosis and restart visibility (ported from oh-my-pi
 * af92dbc0b2, a19f742ef9, 6dde5ac2d4, d7197bd069). A kernel that dies
 * mid-run must carry its last stderr into the exit message, a late `done`
 * frame from a dying runner must not overwrite that diagnosis, an
 * already-aborted signal must settle cancelled without burning kernel
 * spawns, and a replacement kernel's result must say so. Real subprocesses,
 * dying on cue.
 */

import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import type { PtcBindingNamespace } from '@deepseek-ai/dsh-ptc-runtime'
import { KernelHost, nodejsKernelProfile } from '../src/core/kernel.ts'
import { SessionRegistry } from '../src/core/session.ts'
import { KernelManager } from '../src/index.ts'
import { tempSnapshotDir } from './test-util.ts'

function startConfig(env?: Record<string, string>) {
  return {
    cwd: process.cwd(),
    startupTimeoutMs: 15_000,
    interruptEscalationMs: 5_000,
    shutdownGraceMs: 1_000,
    ...env !== undefined ? { env } : {},
  }
}

/**
 * A stand-in runner that completes the handshake, then behaves per
 * `FAKE_RUNNER_MODE` on the first exec: `die-stderr` writes one line to
 * stderr synchronously (an async stderr write would be lost at exit on
 * macOS pipes) and exits 3; `die-silent` exits 23 with no output;
 * `die-late-done` spawns a grandchild that inherits the host pipes and
 * emits a `done` frame after the runner itself is gone — the classic
 * late-frame race the settled guard must absorb.
 */
const FAKE_RUNNER = `
process.stdout.write(JSON.stringify({ type: 'ready', pid: process.pid }) + '\\n')
const mode = process.env.FAKE_RUNNER_MODE || 'echo'
let buffer = ''
process.stdin.setEncoding('utf8')
function dieStderr() {
  import('node:fs').then((fs) => {
    fs.writeSync(2, 'fatal-runner-MARKER: died mid-cell\\n')
    process.exit(3)
  })
}
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const at = buffer.indexOf('\\n')
    if (at < 0) break
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    if (message.type !== 'exec') continue
    if (mode === 'die-stderr') { dieStderr(); return }
    if (mode === 'die-silent') { process.exit(23) }
    if (mode === 'die-late-done') {
      import('node:child_process').then(({ spawn }) => {
        const writer = 'setTimeout(() => { ' +
          'process.stdout.write(JSON.stringify({ type: "done", id: ' + JSON.stringify(message.id) + ', status: "ok", value: { late: true }, message: "late-done-MARKER" }) + String.fromCharCode(10)); ' +
          'setTimeout(() => {}, 400) }, 150)'
        spawn(process.execPath, ['-e', writer], { stdio: ['ignore', 'inherit', 'inherit'] }).unref()
        setTimeout(dieStderr, 50)
      })
      return
    }
    process.stdout.write(JSON.stringify({ type: 'started', id: message.id }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'done', id: message.id, status: 'ok', value: 1, executionCount: 1 }) + '\\n')
  }
})
setInterval(() => {}, 1_000)
`

function fakeRunnerProfile() {
  return {
    ...nodejsKernelProfile(process.execPath),
    stagedSource: FAKE_RUNNER,
  }
}

describe('KernelHost — exit diagnosis (omp af92dbc0b2/a19f742ef9)', () => {
  it('reports a dying runner’s last stderr in the exit message', { timeout: 30_000 }, async () => {
    const kernel = await KernelHost.start(fakeRunnerProfile(), startConfig({ FAKE_RUNNER_MODE: 'die-stderr' }))
    try {
      const result = await kernel.execute('die-stderr', 'ignored', [], {})
      expect(result.status).toBe('error')
      expect(result.killed).toBe(true)
      expect(result.message).toContain('exited with code 3')
      expect(result.message).toContain('; its last stderr output:')
      expect(result.message).toContain('fatal-runner-MARKER: died mid-cell')
    } finally {
      await kernel.shutdown()
    }
  })

  it('reports a silent death without inventing stderr output', { timeout: 30_000 }, async () => {
    const kernel = await KernelHost.start(fakeRunnerProfile(), startConfig({ FAKE_RUNNER_MODE: 'die-silent' }))
    try {
      const result = await kernel.execute('die-silent', 'ignored', [], {})
      expect(result.status).toBe('error')
      expect(result.killed).toBe(true)
      expect(result.message).toContain('exited with code 23')
      expect(result.message).not.toContain('last stderr output')
    } finally {
      await kernel.shutdown()
    }
  })

  it('keeps the death diagnosis when a late done frame lands during the stderr drain wait', { timeout: 30_000 }, async () => {
    const kernel = await KernelHost.start(fakeRunnerProfile(), startConfig({ FAKE_RUNNER_MODE: 'die-late-done' }))
    try {
      // Timeline: the runner dies ~50ms after the exec while a grandchild
      // holds the stderr pipe open; the grandchild's `done` frame (~150ms)
      // lands inside the bounded drain wait (~200ms) that the exit claim
      // spends collecting stderr. The settled guard must keep the death
      // diagnosis; without it the late frame would flip the run to ok.
      const result = await kernel.execute('late-done', 'ignored', [], {})
      expect(result.status).toBe('error')
      expect(result.killed).toBe(true)
      expect(result.value).toBeUndefined()
      expect(result.message).toContain('exited with code 3')
      expect(result.message).toContain('fatal-runner-MARKER')
      expect(result.message).not.toContain('late-done-MARKER')
    } finally {
      await kernel.shutdown()
    }
  })
})

describe('KernelHost — pre-aborted signal (omp 6dde5ac2d4)', () => {
  it('settles cancelled without reaching a live kernel', { timeout: 30_000 }, async () => {
    const kernel = await KernelHost.start(nodejsKernelProfile(process.execPath), startConfig())
    try {
      const controller = new AbortController()
      controller.abort(new Error('caller gave up'))
      const result = await kernel.execute('pre-aborted', 'return 1', [], { signal: controller.signal })
      expect(result.status).toBe('error')
      expect(result.cancelled).toBe(true)
      expect(result.killed).toBe(false)
      // The SIGINT never landed, so the runner lives on and serves the next run.
      expect(kernel.isAlive()).toBe(true)
      const after = await kernel.execute('still-works', 'return 2 + 2', [], {})
      expect(after.status).toBe('ok')
      expect(after.value).toBe(4)
    } finally {
      await kernel.shutdown()
    }
  })

  it('does not spawn a replacement kernel for an already-aborted session run', { timeout: 30_000 }, async () => {
    let starts = 0
    const registry = new SessionRegistry({
      label: 'nodejs kernel',
      start: () => {
        starts += 1
        return KernelHost.start(nodejsKernelProfile(process.execPath), startConfig())
      },
      sessionIdleMs: 0,
    })
    try {
      const controller = new AbortController()
      controller.abort(new Error('caller gave up'))
      const result = await registry.executeOnSession('pre-aborted', 'return 1', [], { signal: controller.signal })
      // One spawn for the session kernel, none for a pointless retry.
      expect(starts).toBe(1)
      expect(result.cancelled).toBe(true)
      expect(result.killed).toBe(false)
      const follow = await registry.executeOnSession('pre-aborted', 'return 2 + 2', [], {})
      expect(follow.status).toBe('ok')
      expect(follow.value).toBe(4)
    } finally {
      await registry.disposeAll()
    }
  })
})

describe('SessionRegistry — restart notice (omp d7197bd069)', () => {
  it('notices the replacement after a mid-run kernel death', { timeout: 60_000, skip: process.platform === 'win32' }, async () => {
    // The binding kills the kernel's own process group mid-call: the run
    // settles killed, the registry replaces the kernel and retries, and the
    // retried result must carry the restart notice ahead of its output. No
    // snapshot exists yet — the dying run is the session's first — so a
    // restore cannot suppress the notice.
    let kills = 0
    const bindings: PtcBindingNamespace[] = [{
      global: 'test',
      functions: {
        dieOnce: async (args: unknown) => {
          const { pid } = args as { pid: number }
          if (kills++ === 0) process.kill(-pid, 'SIGKILL')
          return null
        },
      },
    }]
    const manager = new KernelManager({
      languages: ['typescript'],
      snapshotDir: tempSnapshotDir(),
    })
    try {
      const result = await manager.run({
        language: 'typescript',
        sessionId: 'restart-notice',
        code: 'await test.dieOnce({ pid: process.pid })\nreturn 42',
        bindings,
      })
      expect(result.error).toBeUndefined()
      expect(result.value).toBe(42)
      expect(result.executionCount).toBe(1)
      expect(result.logs.join('')).toContain('Kernel restarted: the previous nodejs kernel is dead')
    } finally {
      await manager.teardown()
    }
  })

  it('stays silent when a snapshot restores the state of a kernel that died between cells', { timeout: 60_000 }, async () => {
    // Cell 1 succeeds and its namespace is snapshotted; the kernel then dies
    // before cell 2. The replacement kernel restores the snapshot, so a
    // "state is unavailable" notice would contradict the restored state —
    // the result carries only the runner's restore log instead.
    const manager = new KernelManager({
      languages: ['typescript'],
      snapshotDir: tempSnapshotDir(),
    })
    try {
      const scheduled = await manager.run({
        language: 'typescript',
        sessionId: 'restart-between-restore',
        code: 'globalThis.laneState = 41\nsetTimeout(() => { process.exit(5) }, 300)\nreturn "scheduled"',
      })
      expect(scheduled.error).toBeUndefined()
      expect(scheduled.logs.join('')).not.toContain('Kernel restarted')
      await delay(600)
      const second = await manager.run({
        language: 'typescript',
        sessionId: 'restart-between-restore',
        code: 'return globalThis.laneState + 1',
      })
      expect(second.error).toBeUndefined()
      expect(second.value).toBe(42)
      expect(second.logs.join('')).not.toContain('Kernel restarted')
    } finally {
      await manager.teardown()
    }
  })

  it('notices the replacement when snapshots are disabled', { timeout: 60_000, skip: process.platform === 'win32' }, async () => {
    // No snapshot function on the registry: the replacement kernel cannot
    // restore anything, so the notice must say the prior state is gone even
    // where a manager-configured snapshot would have suppressed it.
    let starts = 0
    let kills = 0
    const registry = new SessionRegistry({
      label: 'nodejs kernel',
      start: () => {
        starts += 1
        return KernelHost.start(nodejsKernelProfile(process.execPath), startConfig())
      },
      sessionIdleMs: 0,
    })
    const bindings: PtcBindingNamespace[] = [{
      global: 'test',
      functions: {
        dieOnce: async (args: unknown) => {
          const { pid } = args as { pid: number }
          if (kills++ === 0) process.kill(-pid, 'SIGKILL')
          return null
        },
      },
    }]
    try {
      const result = await registry.executeOnSession(
        'restart-notice-no-snapshot',
        'await test.dieOnce({ pid: process.pid })\nreturn 42',
        bindings,
      )
      expect(starts).toBe(2)
      expect(result.value).toBe(42)
      expect(result.executionCount).toBe(1)
      expect(result.logs.map(log => log.text).join('')).toContain('Kernel restarted: the previous nodejs kernel is dead')
    } finally {
      await registry.disposeAll()
    }
  })
})
