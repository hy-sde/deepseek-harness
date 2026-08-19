import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import type { CodeBindingFunction, CodeBindingNamespace } from '@deepseek-ai/dsh-code-runtime'
import { NodeJsKernel, doneFailure, parseKernelFrame } from '../src/kernel.ts'
import type { NodeJsKernelStartConfig } from '../src/kernel.ts'

/**
 * Integration suite over REAL `node` subprocesses (no mocks — the runner is
 * the point, per docs/testing.md's real-over-mock policy). Every test builds
 * its own kernel so timing budgets cannot leak across cases. Skipped when no
 * `node` is on PATH (the backend is exactly that interpreter dependency).
 */

const HAS_NODE = (() => {
  const probe = spawnSync('node', ['--version'], { encoding: 'utf8' })
  return probe.status === 0 && probe.stdout.length > 0
})()

function startConfig(overrides: Partial<NodeJsKernelStartConfig> = {}): NodeJsKernelStartConfig {
  return {
    nodePath: 'node',
    cwd: process.cwd(),
    env: process.env,
    startupTimeoutMs: 10_000,
    interruptEscalationMs: 500,
    shutdownGraceMs: 500,
    ...overrides,
  }
}

/** One `tools` namespace with the given functions. */
function tools(functions: Record<string, (args: unknown) => Promise<unknown>>): CodeBindingNamespace[] {
  return [{
    global: 'tools',
    functions: functions as Record<string, CodeBindingFunction>,
    errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
  }]
}

describe('parseKernelFrame (hostile-peer validation)', () => {
  it('accepts every well-formed frame and rejects junk field by field', () => {
    expect(parseKernelFrame({ type: 'ready', pid: 1 })).toEqual({ type: 'ready', pid: 1 })
    expect(parseKernelFrame({ type: 'ready', pid: 'x' })).toBeUndefined()
    expect(parseKernelFrame({ type: 'started', id: 'r' })).toEqual({ type: 'started', id: 'r' })
    expect(parseKernelFrame({ type: 'log', id: 'r', text: 't', stream: 'stderr' }))
      .toEqual({ type: 'log', id: 'r', text: 't', stream: 'stderr' })
    expect(parseKernelFrame({ type: 'log', id: 'r', text: 't' })).toEqual({ type: 'log', id: 'r', text: 't', stream: 'stdout' })
    expect(parseKernelFrame({ type: 'log', id: 'r' })).toBeUndefined()
    expect(parseKernelFrame({ type: 'call', id: 'r', seq: 1, global: 'tools', name: 'ping', args: { a: 1 } }))
      .toEqual({ type: 'call', id: 'r', seq: 1, global: 'tools', name: 'ping', args: { a: 1 } })
    expect(parseKernelFrame({ type: 'call', id: 'r', seq: '1', global: 'tools', name: 'ping' })).toBeUndefined()
    expect(parseKernelFrame({ type: 'error', id: 'r', ename: 'E', evalue: 'm', traceback: ['a', 1] }))
      .toEqual({ type: 'error', id: 'r', ename: 'E', evalue: 'm', traceback: ['a'] })
    expect(parseKernelFrame({ type: 'done', id: 'r', status: 'ok', value: null, executionCount: 3, cancelled: true }))
      .toEqual({ type: 'done', id: 'r', status: 'ok', value: null, executionCount: 3, cancelled: true })
    expect(parseKernelFrame({ type: 'done', id: 'r', status: 'error' })).toEqual({ type: 'done', id: 'r', status: 'error' })
    expect(parseKernelFrame({ type: 'done', id: 'r', status: 'ok', value: 'x' })).toEqual({ type: 'done', id: 'r', status: 'ok', value: 'x' })
    expect(parseKernelFrame({ type: 'nope', id: 'r' })).toBeUndefined()
    expect(parseKernelFrame('x')).toBeUndefined()
  })

  it('doneFailure distills the done frame onto the seam failure taxonomy', () => {
    expect(doneFailure({ type: 'done', id: 'r', status: 'ok' })).toEqual({ ok: true })
    expect(doneFailure({ type: 'done', id: 'r', status: 'error' })).toEqual({ ok: false, error: { kind: 'exception', message: 'program failed' } })
    expect(doneFailure({ type: 'done', id: 'r', status: 'error', invalidOutput: true }))
      .toEqual({ ok: false, error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } })
    expect(doneFailure({ type: 'done', id: 'r', status: 'error', message: 'boom' }))
      .toEqual({ ok: false, error: { kind: 'exception', message: 'boom' } })
    expect(doneFailure({ type: 'done', id: 'r', status: 'error', invalidOutput: true, message: 'bad' }))
      .toEqual({ ok: false, error: { kind: 'invalid-output', message: 'bad' } })
  })
})

describe.skipIf(!HAS_NODE)('NodeJsKernel — real node subprocess', () => {
  it('starts, handshakes, and reports liveness', async () => {
    const kernel = await NodeJsKernel.start(startConfig())
    try {
      expect(kernel.isAlive()).toBe(true)
      expect(kernel.pid).toBeGreaterThan(0)
    } finally {
      await kernel.shutdown()
    }
  })

  it('preserves persistent state across executions in one kernel', async () => {
    const kernel = await NodeJsKernel.start(startConfig())
    try {
      const first = await kernel.execute('a', 'x = 41\nstate.tally = 1', [])
      expect(first.status).toBe('ok')
      expect(first.executionCount).toBe(1)
      const second = await kernel.execute('b', 'return x + state.tally', [])
      expect(second.status).toBe('ok')
      expect(second.value).toBe(42)
      expect(second.executionCount).toBe(2)
    } finally {
      await kernel.shutdown()
    }
  })

  it('supports top-level await and captures stdout/stderr logs', async () => {
    const kernel = await NodeJsKernel.start(startConfig())
    try {
      const result = await kernel.execute('log', 'await new Promise(resolve => setTimeout(resolve, 10))\nconsole.log("hello")\nconsole.error("warned")\nreturn 5', [])
      expect(result.status).toBe('ok')
      expect(result.value).toBe(5)
      const combined = result.logs.map(entry => entry.text).join('')
      expect(combined).toContain('hello')
      expect(combined).toContain('warned')
    } finally {
      await kernel.shutdown()
    }
  })

  it('bridges tool calls across the wire, including concurrent in-flight calls', async () => {
    const kernel = await NodeJsKernel.start(startConfig())
    try {
      const calls: string[] = []
      const bindings = tools({
        ping: async (args) => { calls.push(String((args as { n?: number }).n ?? '')); return 'pong' },
        add: async args => (args as { a: number; b: number }).a + (args as { a: number; b: number }).b,
      })
      const result = await kernel.execute('tools', 'const [r1, r2] = await Promise.all([tools.ping({ n: 1 }), tools.add({ a: 2, b: 3 })])\nreturn [r1, r2]', bindings)
      expect(result.status).toBe('ok')
      expect(result.value).toEqual(['pong', 5])
      expect(calls).toEqual(['1'])
    } finally {
      await kernel.shutdown()
    }
  })

  it('returns a binding rejection as a typed program exception', async () => {
    const kernel = await NodeJsKernel.start(startConfig())
    try {
      const bindings = tools({ fail: async () => { throw new Error('binding exploded') } })
      const result = await kernel.execute('err', 'try {\n  await tools.fail({})\n  outcome = "no"\n} catch (e) {\n  outcome = { typed: e instanceof ToolCallError, toolName: e.toolName, msg: e.message, ctor: e.constructor.name }\n}\nreturn outcome', bindings)
      expect(result.status).toBe('ok')
      expect(result.value).toEqual({ typed: true, toolName: 'fail', msg: 'binding exploded', ctor: 'ToolCallError' })
    } finally {
      await kernel.shutdown()
    }
  })

  it('reports uncaught exceptions on the result message', async () => {
    const kernel = await NodeJsKernel.start(startConfig())
    try {
      const result = await kernel.execute('boom', 'throw new Error("boom")', [])
      expect(result.status).toBe('error')
      expect(result.message).toContain('boom')
      expect(result.cancelled).toBe(false)
    } finally {
      await kernel.shutdown()
    }
  })

  it('reports non-JSON completion as invalid output and keeps the kernel alive', async () => {
    const kernel = await NodeJsKernel.start(startConfig())
    try {
      const result = await kernel.execute('circ', 'const a = {}; a.self = a; return a', [])
      expect(result.status).toBe('error')
      expect(result.invalidOutput).toBe(true)
      // Kernel survives: next run still works.
      const next = await kernel.execute('after', 'return 9', [])
      expect(next.status).toBe('ok')
      expect(next.value).toBe(9)
    } finally {
      await kernel.shutdown()
    }
  })

  it('interrupts an in-flight run promptly, then keeps serving', async () => {
    const kernel = await NodeJsKernel.start(startConfig({ interruptEscalationMs: 5_000, shutdownGraceMs: 1_000 }))
    try {
      const controller = new AbortController()
      const pending = kernel.execute('long', 'await new Promise(resolve => setTimeout(resolve, 3000)); return "done late"', [], { signal: controller.signal })
      // Give the run a moment to start, then abort.
      await new Promise(resolve => setTimeout(resolve, 400))
      const t0 = Date.now()
      controller.abort('user cancelled')
      const result = await pending
      expect(Date.now() - t0).toBeLessThan(2500)
      expect(result.cancelled).toBe(true)
      // The kernel itself survived the interrupt.
      const after = await kernel.execute('survivor', 'return 1 + 1', [])
      expect(after.status).toBe('ok')
      expect(after.value).toBe(2)
    } finally {
      await kernel.shutdown()
    }
  })

  it('surfaces a kernel that died mid-run as killed, and rejects runs on a dead kernel', async () => {
    const kernel = await NodeJsKernel.start(startConfig())
    await kernel.shutdown()
    const result = await kernel.execute('dead', 'return 1', [])
    expect(result.killed).toBe(true)
    expect(result.status).toBe('error')
  })

  it('shutdown confirms once the runner exits and is idempotent', async () => {
    const kernel = await NodeJsKernel.start(startConfig())
    expect(await kernel.shutdown()).toEqual({ confirmed: true })
    expect(await kernel.shutdown()).toEqual({ confirmed: true })
    expect(kernel.isAlive()).toBe(false)
  })
})
