/**
 * Kernel-exit diagnosis and restart visibility (ported from oh-my-pi
 * af92dbc0b2, a19f742ef9, 6dde5ac2d4, d7197bd069). A kernel that dies
 * mid-run must carry its last stderr into the exit message, a late `done`
 * frame from a dying runner must not overwrite that diagnosis, an
 * already-aborted signal must settle cancelled without burning kernel
 * spawns, and a replacement kernel's result must say so. Real subprocesses,
 * dying on cue.
 */

import { describe, expect, it } from 'vitest'
import { KernelHost, nodejsKernelProfile } from '../src/core/kernel.ts'

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
