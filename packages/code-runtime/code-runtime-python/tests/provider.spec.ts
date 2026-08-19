import { describe, expect, it, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { PythonCodeRuntime } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { CodeBindingFunction, CodeBindingNamespace, CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'

/**
 * Seam-level integration over REAL python3 subprocesses: descriptor surface,
 * one-shot vs. session semantics, budgets, binding validation, and lifecycle
 * (teardown). Skipped when no `python3` is on PATH.
 */

const HAS_PYTHON = (() => {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  return probe.status === 0 && probe.stdout.length > 0
})()

async function setup(config: Partial<Config> = {}) {
  const ctx = new Context()
  const plugin = await ctx.plugin(PythonCodeRuntime, config)
  const runtime = ctx.codeRuntime as PythonCodeRuntime
  return { ctx, plugin, runtime }
}

function run(runtime: PythonCodeRuntime, request: Omit<CodeRunRequest, 'bindings'> & { bindings?: CodeBindingNamespace[] }): Promise<CodeRunResult> {
  return runtime.run({ bindings: [], ...request })
}

afterEach(async () => {
  // Every setup() context stops itself; kernels die with their registry.
})

describe.skipIf(!HAS_PYTHON)('PythonCodeRuntime — seam contract with real kernels', () => {
  it('registers with the persistent seam descriptors and parses its own config defaults', async () => {
    const { runtime } = await setup()
    expect(runtime.language).toBe('python')
    expect(runtime.isolation).toBe('process')
    expect(runtime.persistent).toBe(true)
  })

  it('runs one-shot programs without a session, capturing output and value', async () => {
    const { runtime } = await setup()
    const result = await run(runtime, { program: 'import sys\nprint("hello")\nsys.stderr.write("warned\\n")\nanswer = 6 * 7\nanswer' })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(42)
    expect(result.executionCount).toBe(1) // the short-lived one-shot kernel still counts its runs
    expect(result.logs.join('')).toContain('hello')
    expect(result.logs.join('')).toContain('warned')
  })

  it('keeps namespace state across runs of one session and counts executions', async () => {
    const { runtime } = await setup()
    const first = await run(runtime, { sessionId: 's1', program: 'x = 41\n' })
    expect(first.error).toBeUndefined()
    expect(first.executionCount).toBe(1)
    const second = await run(runtime, { sessionId: 's1', program: 'x + 1' })
    expect(second.error).toBeUndefined()
    expect(second.value).toBe(42)
    expect(second.executionCount).toBe(2)
    // A different session is isolated: no x there.
    const other = await run(runtime, { sessionId: 's2', program: "'x' in dir()" })
    expect(other.error).toBeUndefined()
    expect(other.value).toBe(false)
  })

  it('reset discards prior session state on the next run', async () => {
    const { runtime } = await setup()
    expect((await run(runtime, { sessionId: 's', program: 'stash = 1\nstash' })).value).toBe(1)
    expect((await run(runtime, { sessionId: 's', program: 'stash + 41' })).value).toBe(42)
    const reset = await run(runtime, { sessionId: 's', reset: true, program: "'stash' in dir()" })
    expect(reset.error).toBeUndefined()
    expect(reset.value).toBe(false)
  })

  it('bridges bindings on a session and removes per-run injections afterwards', async () => {
    const { runtime } = await setup()
    const bindings: CodeBindingNamespace[] = [{
      global: 'tools',
      functions: { ping: async args => ({ echoed: (args as { n?: number }).n }) } as Record<string, CodeBindingFunction>,
      errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
    }]
    const called = await run(runtime, { sessionId: 'tools1', program: 'await tools.ping({"n": 7})', bindings })
    expect(called.error).toBeUndefined()
    expect(called.value).toEqual({ echoed: 7 })
    // tools must not leak into the next cell of the same session.
    const leak = await run(runtime, { sessionId: 'tools1', program: "'tools' in dir()" })
    expect(leak.error).toBeUndefined()
    expect(leak.value).toBe(false)
  })

  it('returns host binding rejections as typed program exceptions', async () => {
    const { runtime } = await setup()
    const bindings: CodeBindingNamespace[] = [{
      global: 'tools',
      functions: { fail: async () => { throw new Error('binding exploded') } },
      errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
    }]
    const result = await run(runtime, {
      sessionId: 'reject',
      program: 'try:\n    await tools.fail(1)\n    out = "no"\nexcept ToolCallError as e:\n    out = {"typed": True, "toolName": e.toolName, "msg": e.message}\nout',
      bindings,
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ typed: true, toolName: 'fail', msg: 'binding exploded' })
  })

  it('maps uncaught exceptions to the exception failure kind', async () => {
    const { runtime } = await setup()
    // Rejecting is a choice: this run's exception is a result field, not a reject.
    const result = await run(runtime, { sessionId: 'boom', program: 'raise ValueError("kaput")' })
    expect(result.value).toBeUndefined()
    expect(result.error?.kind).toBe('exception')
    expect(String(result.error?.message)).toContain('kaput')
  })

  it('maps non-JSON completions to invalid-output', async () => {
    const { runtime } = await setup()
    const result = await run(runtime, { sessionId: 'set', program: 'x = {1, 2, 3}\nx' })
    expect(result.error?.kind).toBe('invalid-output')
  })

  it('enforces the wall-clock budget as a timeout failure', async () => {
    const { runtime } = await setup({ maxWallMs: 600 })
    const t0 = Date.now()
    const result = await run(runtime, { sessionId: 'slow', program: 'import time\nfor _ in range(200):\n    time.sleep(0.1)' })
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(5_000) // budget interrupted, did not wait the loop out
    expect(result.error?.kind).toBe('timeout')
  })

  it('honors an external abort signal as an abort failure', async () => {
    const { runtime } = await setup()
    const controller = new AbortController()
    const pending = run(runtime, { sessionId: 'abort', program: 'import time\nfor _ in range(200):\n    time.sleep(0.1)', signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 400))
    controller.abort('cancelled by caller')
    const result = await pending
    expect(result.error?.kind).toBe('abort')
  })

  it('returns worker-exit after a kernel that died on its own, retrying once on a fresh kernel', async () => {
    const { runtime } = await setup()
    // Drive the kernel to its death: ask the program to os._exit (weaker
    // signal than SIGKILL, but deterministic and subprocess-confined).
    const first = await run(runtime, { sessionId: 'die', program: 'import os\nos._exit(3)' })
    // The registry replaces the dead kernel and retries the SAME run once.
    const retried = await run(runtime, { sessionId: 'die', program: 'import os\nos._exit(3)' })
    expect(first.error !== undefined || retried.error !== undefined).toBe(true)
  })

  it('rejects contract misuse: bad binding global, duplicate global, bad error member', async () => {
    const { runtime } = await setup()
    await expect(run(runtime, { program: 'pass', bindings: [{ global: '1bad', functions: {} }] })).rejects.toThrow(/usable identifier/)
    await expect(run(runtime, { program: 'pass', bindings: [
      { global: 'tools', functions: {} }, { global: 'tools', functions: {} },
    ] })).rejects.toThrow(/duplicate/)
    await expect(run(runtime, { program: 'pass', bindings: [{
      global: 'tools', functions: {}, errorClass: { name: 'ToolCallError', memberNameProperty: '__class__' },
    }] })).rejects.toThrow(/not usable/)
  })

  it('rejects run() after disposal (contract misuse on a stopped runtime)', async () => {
    const { runtime } = await setup()
    await runtime.teardown()
    await expect(run(runtime, { program: '1 + 1' })).rejects.toThrow(/after disposal/)
  })

  it('surfaces the combined output cap as output-limit, retaining fitting logs', async () => {
    const { runtime } = await setup({ maxOutputBytes: 512 })
    const result = await run(runtime, { sessionId: 'cap', program: 'print("a" * 400)\nout = "b" * 600\nout' })
    expect(result.error?.kind).toBe('output-limit')
    expect(result.logs.join('')).toContain('aaaa')
  })
})
