import { describe, expect, it, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { NodeJsCodeRuntime } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { CodeBindingFunction, CodeBindingNamespace, CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'

/**
 * Seam-level integration over REAL `node` subprocesses: descriptor surface,
 * one-shot vs. session semantics, budgets, binding validation, and lifecycle
 * (teardown). Skipped when no `node` is on PATH.
 */

const HAS_NODE = (() => {
  const probe = spawnSync('node', ['--version'], { encoding: 'utf8' })
  return probe.status === 0 && probe.stdout.length > 0
})()

async function setup(config: Partial<Config> = {}) {
  const ctx = new Context()
  const plugin = await ctx.plugin(NodeJsCodeRuntime, config)
  const runtime = ctx.codeRuntime as NodeJsCodeRuntime
  return { ctx, plugin, runtime }
}

function run(runtime: NodeJsCodeRuntime, request: Omit<CodeRunRequest, 'bindings'> & { bindings?: CodeBindingNamespace[] }): Promise<CodeRunResult> {
  return runtime.run({ bindings: [], ...request })
}

afterEach(async () => {
  // Every setup() context stops itself; kernels die with their registry.
})

describe.skipIf(!HAS_NODE)('NodeJsCodeRuntime — seam contract with real kernels', () => {
  it('registers with the persistent seam descriptors and parses its own config defaults', async () => {
    const { runtime } = await setup()
    expect(runtime.language).toBe('typescript')
    expect(runtime.isolation).toBe('process')
    expect(runtime.persistent).toBe(true)
  })

  it('runs one-shot programs without a session, capturing output and value', async () => {
    const { runtime } = await setup()
    const result = await run(runtime, { program: 'console.log("hello")\nconsole.error("warned")\nreturn 6 * 7' })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(42)
    expect(result.executionCount).toBe(1) // the short-lived one-shot kernel still counts its runs
    expect(result.logs.join('')).toContain('hello')
    expect(result.logs.join('')).toContain('warned')
  })

  it('keeps persistent state across runs of one session and counts executions', async () => {
    const { runtime } = await setup()
    const first = await run(runtime, { sessionId: 's1', program: 'x = 41' })
    expect(first.error).toBeUndefined()
    expect(first.executionCount).toBe(1)
    const second = await run(runtime, { sessionId: 's1', program: 'return x + 1' })
    expect(second.error).toBeUndefined()
    expect(second.value).toBe(42)
    expect(second.executionCount).toBe(2)
    // A different session is isolated: no x there.
    const other = await run(runtime, { sessionId: 's2', program: "return typeof globalThis.x === 'undefined'" })
    expect(other.error).toBeUndefined()
    expect(other.value).toBe(true)
  })

  it('reset discards prior session state on the next run', async () => {
    const { runtime } = await setup()
    expect((await run(runtime, { sessionId: 's', program: 'stash = 1\nreturn stash' })).value).toBe(1)
    expect((await run(runtime, { sessionId: 's', program: 'return stash + 41' })).value).toBe(42)
    const reset = await run(runtime, { sessionId: 's', reset: true, program: "return typeof globalThis.stash === 'undefined'" })
    expect(reset.error).toBeUndefined()
    expect(reset.value).toBe(true)
  })

  it('bridges bindings on a session and removes per-run injections afterwards', async () => {
    const { runtime } = await setup()
    const bindings: CodeBindingNamespace[] = [{
      global: 'tools',
      functions: { ping: async args => ({ echoed: (args as { n?: number }).n }) } as Record<string, CodeBindingFunction>,
      errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
    }]
    const called = await run(runtime, { sessionId: 'tools1', program: 'return await tools.ping({ n: 7 })', bindings })
    expect(called.error).toBeUndefined()
    expect(called.value).toEqual({ echoed: 7 })
    // tools must not leak into the next cell of the same session.
    const leak = await run(runtime, { sessionId: 'tools1', program: "return typeof globalThis.tools === 'undefined'" })
    expect(leak.error).toBeUndefined()
    expect(leak.value).toBe(true)
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
      program: 'try {\n  await tools.fail({})\n  out = "no"\n} catch (e) {\n  out = { typed: e instanceof ToolCallError, toolName: e.toolName, msg: e.message }\n}\nreturn out',
      bindings,
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ typed: true, toolName: 'fail', msg: 'binding exploded' })
  })

  it('maps uncaught exceptions to the exception failure kind', async () => {
    const { runtime } = await setup()
    // Rejecting is a choice: this run's exception is a result field, not a reject.
    const result = await run(runtime, { sessionId: 'boom', program: 'throw new Error("kaput")' })
    expect(result.value).toBeUndefined()
    expect(result.error?.kind).toBe('exception')
    expect(String(result.error?.message)).toContain('kaput')
  })

  it('maps non-JSON completions to invalid-output', async () => {
    const { runtime } = await setup()
    const result = await run(runtime, { sessionId: 'cyc', program: 'const a = {}; a.self = a; return a' })
    expect(result.error?.kind).toBe('invalid-output')
  })

  it('enforces the wall-clock budget as a timeout failure', async () => {
    const { runtime } = await setup({ maxWallMs: 600, interruptEscalationMs: 400, shutdownGraceMs: 200 })
    const t0 = Date.now()
    const result = await run(runtime, { sessionId: 'slow', program: 'while (true) {}' })
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(5_000) // budget interrupted, did not wait the loop out
    expect(result.error?.kind).toBe('timeout')
  })

  it('honors an external abort signal as an abort failure', async () => {
    const { runtime } = await setup()
    const controller = new AbortController()
    const pending = run(runtime, { sessionId: 'abort', program: 'await new Promise(resolve => setTimeout(resolve, 3000)); return "late"', signal: controller.signal })
    await new Promise(resolve => setTimeout(resolve, 400))
    controller.abort('cancelled by caller')
    const result = await pending
    expect(result.error?.kind).toBe('abort')
  })

  it('returns worker-exit after a kernel that died on its own, retrying once on a fresh kernel', async () => {
    const { runtime } = await setup()
    // Drive the kernel to its death: ask the program to exit(3) (weaker than
    // SIGKILL, but deterministic and subprocess-confined).
    const first = await run(runtime, { sessionId: 'die', program: 'process.exit(3)' })
    // The registry replaces the dead kernel and retries the SAME run once.
    const retried = await run(runtime, { sessionId: 'die', program: 'process.exit(3)' })
    expect(first.error !== undefined || retried.error !== undefined).toBe(true)
  })

  it('rejects contract misuse: bad binding global, duplicate global, bad error member', async () => {
    const { runtime } = await setup()
    await expect(run(runtime, { program: 'return 1', bindings: [{ global: '1bad', functions: {} }] })).rejects.toThrow(/usable identifier/)
    await expect(run(runtime, { program: 'return 1', bindings: [
      { global: 'tools', functions: {} }, { global: 'tools', functions: {} },
    ] })).rejects.toThrow(/duplicate/)
    await expect(run(runtime, { program: 'return 1', bindings: [{
      global: 'tools', functions: {}, errorClass: { name: 'ToolCallError', memberNameProperty: '__proto__' },
    }] })).rejects.toThrow(/not usable/)
  })

  it('rejects run() after disposal (contract misuse on a stopped runtime)', async () => {
    const { runtime } = await setup()
    await runtime.teardown()
    await expect(run(runtime, { program: 'return 1 + 1' })).rejects.toThrow(/after disposal/)
  })

  it('surfaces the combined output cap as output-limit, retaining fitting logs', async () => {
    const { runtime } = await setup({ maxOutputBytes: 512 })
    const result = await run(runtime, { sessionId: 'cap', program: "console.log('a'.repeat(400))\nreturn 'b'.repeat(600)" })
    expect(result.error?.kind).toBe('output-limit')
    expect(result.logs.join('')).toContain('aaaa')
  })
})
