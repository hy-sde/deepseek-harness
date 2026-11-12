import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import type { Writable } from 'node:stream'
import {
  childProcessTarget,
  subprocessHandleTarget,
  TerminationLadder,
  TerminationLadderConfigError,
} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, TerminationLadderTarget } from '@deepseek-ai/dsh-subprocess'

describe('TerminationLadder construction', () => {
  it('rejects an EOF window shorter than the SIGTERM window', () => {
    expect(() => new TerminationLadder({ eofGraceMs: 100, termGraceMs: 1_000 }))
      .toThrow(TerminationLadderConfigError)
    try {
      new TerminationLadder({ eofGraceMs: 100, termGraceMs: 1_000 })
    } catch (error: unknown) {
      expect((error as Error).name).toBe('TerminationLadderConfigError')
      expect((error as Error).message).toContain('100')
      expect((error as Error).message).toContain('1000')
    }
  })

  it('rejects a negative SIGTERM window', () => {
    expect(() => new TerminationLadder({ eofGraceMs: 100, termGraceMs: -1 }))
      .toThrow(TerminationLadderConfigError)
  })

  it('rejects non-finite grace windows', () => {
    expect(() => new TerminationLadder({ eofGraceMs: Number.NaN, termGraceMs: 0 }))
      .toThrow(TerminationLadderConfigError)
    expect(() => new TerminationLadder({ eofGraceMs: 100, termGraceMs: Number.POSITIVE_INFINITY }))
      .toThrow(TerminationLadderConfigError)
  })

  it('accepts equal windows and a zero SIGTERM window', () => {
    expect(() => new TerminationLadder({ eofGraceMs: 100, termGraceMs: 100 })).not.toThrow()
    expect(() => new TerminationLadder({ eofGraceMs: 0, termGraceMs: 0 })).not.toThrow()
  })
})

/** A teardown target whose tier outcomes are scripted by the test. */
const scriptableTarget = (script: {
  exited?: boolean
  exitResults?: Array<boolean | Error>
  forceTerminateError?: Error
  withoutEndStdin?: boolean
} = {}): TerminationLadderTarget & { calls: string[] } => {
  const calls: string[] = []
  const results = [...(script.exitResults ?? [])]
  return {
    calls,
    ...(script.withoutEndStdin ? {} : { endStdin: () => { calls.push('endStdin') } }),
    hasExited: () => script.exited ?? false,
    exitWithin: () => {
      calls.push('exitWithin')
      const result = results.shift() ?? false
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
    },
    signalTerm: () => { calls.push('signalTerm') },
    forceTerminate: () => {
      calls.push('forceTerminate')
      return script.forceTerminateError !== undefined
        ? Promise.reject(script.forceTerminateError)
        : Promise.resolve()
    },
  }
}

describe('TerminationLadder.run tier order', () => {
  it('exits during the EOF window without signaling', async () => {
    const target = scriptableTarget({ exitResults: [true] })
    await new TerminationLadder({ eofGraceMs: 100, termGraceMs: 50 }).run(target)
    expect(target.calls).toEqual(['endStdin', 'exitWithin'])
  })

  it('escalates to the graceful tier when the EOF window elapses', async () => {
    const target = scriptableTarget({ exitResults: [false, true] })
    await new TerminationLadder({ eofGraceMs: 100, termGraceMs: 50 }).run(target)
    expect(target.calls).toEqual(['endStdin', 'exitWithin', 'signalTerm', 'exitWithin'])
  })

  it('force-terminates when both windows elapse', async () => {
    const target = scriptableTarget({ exitResults: [false, false] })
    await new TerminationLadder({ eofGraceMs: 100, termGraceMs: 50 }).run(target)
    expect(target.calls).toEqual(['endStdin', 'exitWithin', 'signalTerm', 'exitWithin', 'forceTerminate'])
  })

  it('skips the graceful tier entirely on win32', async () => {
    const target = scriptableTarget({ exitResults: [false] })
    await new TerminationLadder({ eofGraceMs: 100, termGraceMs: 50, platform: 'win32' }).run(target)
    expect(target.calls).toEqual(['endStdin', 'exitWithin', 'forceTerminate'])
  })

  it('runs zero-grace configs straight from stdin EOF to termination', async () => {
    const target = scriptableTarget()
    await new TerminationLadder({ eofGraceMs: 0, termGraceMs: 0 }).run(target)
    expect(target.calls).toEqual(['endStdin', 'signalTerm', 'forceTerminate'])
  })

  it('runs win32 zero-grace configs straight to forced termination', async () => {
    const target = scriptableTarget()
    await new TerminationLadder({ eofGraceMs: 0, termGraceMs: 0, platform: 'win32' }).run(target)
    expect(target.calls).toEqual(['endStdin', 'forceTerminate'])
  })

  it('skips the ladder for a target that already exited', async () => {
    const target = scriptableTarget({ exited: true })
    await new TerminationLadder({ eofGraceMs: 100, termGraceMs: 50 }).run(target)
    expect(target.calls).toEqual([])
  })

  it('never touches stdin when the target owns its stdin writer', async () => {
    const target = scriptableTarget({ withoutEndStdin: true, exitResults: [true] })
    await new TerminationLadder({ eofGraceMs: 100, termGraceMs: 50 }).run(target)
    expect(target.calls).toEqual(['exitWithin'])
  })

  it('observes each tier for exactly its own window', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      let waitIndex = 0
      const target: TerminationLadderTarget = {
        endStdin: () => { calls.push('endStdin') },
        hasExited: () => false,
        exitWithin: (graceMs: number) => new Promise<boolean>((resolve) => {
          calls.push(`exitWithin:${String(graceMs)}`)
          waitIndex += 1
          // The SIGTERM-window observation finds the exit halfway through its own window.
          const delay = waitIndex === 2 ? graceMs / 2 : graceMs
          setTimeout(() => { resolve(waitIndex === 2) }, delay)
        }),
        signalTerm: () => { calls.push('signalTerm') },
        forceTerminate: () => {
          calls.push('forceTerminate')
          return Promise.resolve()
        },
      }
      const ladder = new TerminationLadder({ eofGraceMs: 100, termGraceMs: 50 })
      const disposed = ladder.run(target)
      await vi.advanceTimersByTimeAsync(100)
      expect(calls).toEqual(['endStdin', 'exitWithin:100', 'signalTerm', 'exitWithin:50'])
      await vi.advanceTimersByTimeAsync(25)
      await disposed
      expect(calls).toEqual(['endStdin', 'exitWithin:100', 'signalTerm', 'exitWithin:50'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a single wait failure bare', async () => {
    const eofFailure = new Error('eof observation failed')
    const target = scriptableTarget({ exitResults: [eofFailure, true] })
    await expect(new TerminationLadder({ eofGraceMs: 100, termGraceMs: 50 }).run(target))
      .rejects.toBe(eofFailure)
    expect(target.calls).toEqual(['endStdin', 'exitWithin', 'signalTerm', 'exitWithin'])
  })

  it('keeps escalating after a wait failure and aggregates in observation order', async () => {
    const eofFailure = new Error('eof observation failed')
    const termFailure = new Error('term observation failed')
    const forceFailure = new Error('forced termination failed')
    const target = scriptableTarget({
      exitResults: [eofFailure, termFailure],
      forceTerminateError: forceFailure,
    })
    let caught: unknown
    try {
      await new TerminationLadder({ eofGraceMs: 100, termGraceMs: 50 }).run(target)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([eofFailure, termFailure, forceFailure])
  })
})

const node = (source: string, stdin: 'pipe' | 'ignore' = 'pipe'): ChildProcess =>
  spawn(process.execPath, ['--input-type=module', '--eval', source], {
    stdio: [stdin, 'pipe', 'pipe'],
  })

/** A child that keeps running until its stdin writer ends. */
const EOF_COOPERATIVE_SOURCE = 'process.stdin.once("data", () => {}); process.stdin.on("end", () => process.exit(0)); setInterval(() => {}, 60_000)'

/** A child that ignores stdin EOF and only dies from a signal. */
const EOF_DEAF_SOURCE = 'setInterval(() => {}, 60_000)'

const exitOf = (child: ChildProcess): Promise<SubprocessOutcome> =>
  new Promise((resolve) => {
    child.once('exit', (exitCode, signal) => {
      resolve({ exitCode, signal: signal ?? null })
    })
  })

describe('childProcessTarget', () => {
  it('exits within the EOF window without any signal', { timeout: 10_000 }, async () => {
    const child = node(EOF_COOPERATIVE_SOURCE)
    try {
      const exited = exitOf(child)
      await new TerminationLadder({ eofGraceMs: 5_000, termGraceMs: 200 }).run(childProcessTarget(child))
      const outcome = await exited
      expect(outcome.exitCode).toBe(0)
      expect(outcome.signal).toBeNull()
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('escalates to SIGTERM when the child ignores EOF', { timeout: 10_000 }, async () => {
    const child = node(EOF_DEAF_SOURCE, 'ignore')
    try {
      const exited = exitOf(child)
      await new TerminationLadder({ eofGraceMs: 200, termGraceMs: 200 }).run(childProcessTarget(child))
      const outcome = await exited
      if (process.platform === 'win32') {
        expect(outcome.exitCode).not.toBeNull()
      } else {
        expect(outcome.signal).toBe('SIGTERM')
      }
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.listenerCount('error')).toBe(0)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('reaches SIGKILL when the child traps SIGTERM', { timeout: 10_000 }, async () => {
    const child = node('process.on("SIGTERM", () => {}); process.stdout.write("armed\\n"); ' + EOF_DEAF_SOURCE, 'ignore')
    try {
      const armed = new Promise<void>((resolve) => {
        child.stdout!.setEncoding('utf8')
        child.stdout!.on('data', (chunk: string) => {
          if (chunk.includes('armed')) resolve()
        })
      })
      await armed
      const exited = exitOf(child)
      await new TerminationLadder({ eofGraceMs: 50, termGraceMs: 50 }).run(childProcessTarget(child))
      const outcome = await exited
      if (process.platform === 'win32') {
        expect(outcome.exitCode).not.toBeNull()
      } else {
        expect(outcome.signal).toBe('SIGKILL')
      }
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('skips the graceful signal on win32 and kills directly', { timeout: 10_000 }, async () => {
    const child = node(EOF_DEAF_SOURCE, 'ignore')
    try {
      const exited = exitOf(child)
      const kill = vi.spyOn(child, 'kill')
      await new TerminationLadder({ eofGraceMs: 50, termGraceMs: 50, platform: 'win32' })
        .run(childProcessTarget(child))
      const outcome = await exited
      expect(kill.mock.calls.map(([signal]) => signal)).toEqual(['SIGKILL'])
      if (process.platform === 'win32') {
        expect(outcome.exitCode).not.toBeNull()
      } else {
        expect(outcome.signal).toBe('SIGKILL')
      }
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('resolves immediately for an already-exited child without ending stdin', { timeout: 10_000 }, async () => {
    const child = node('')
    await exitOf(child)
    const kill = vi.spyOn(child, 'kill')
    await new TerminationLadder({ eofGraceMs: 1_000, termGraceMs: 200 }).run(childProcessTarget(child))
    expect(kill).not.toHaveBeenCalled()
    expect(child.stdin?.writableEnded).toBe(false)
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
  })
})

/** A `SubprocessHandle` whose termination verbs are scripted by the test. */
const fakeHandle = (
  record: string[],
  options: {
    done?: Promise<SubprocessOutcome>
    onTerminate?: () => void
    onWaitForExit?: (signal: AbortSignal | undefined) => Promise<boolean>
    stdin?: Writable | undefined
  } = {},
): SubprocessHandle => ({
  control: undefined,
  stdin: options.stdin ?? new PassThrough(),
  stdout: undefined,
  stderr: undefined,
  collected: {},
  done: options.done ?? new Promise<SubprocessOutcome>(() => {}),
  terminate: () => {
    record.push('terminate')
    options.onTerminate?.()
  },
  waitForExit: (signal?: AbortSignal) => {
    record.push(signal === undefined ? 'waitForExit:final' : 'waitForExit:window')
    return options.onWaitForExit?.(signal) ?? Promise.resolve(true)
  },
})

/** A scripted handle wait: window waits report the range as still occupied. */
const occupiedUntilForced = (signal: AbortSignal | undefined): Promise<boolean> => {
  if (signal === undefined) return Promise.resolve(true)
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve(false) }, { once: true })
  })
}

describe('subprocessHandleTarget', () => {
  it('terminates exactly once across the graceful and forced tiers', async () => {
    const record: string[] = []
    const handle = fakeHandle(record, { onWaitForExit: occupiedUntilForced })
    await new TerminationLadder({ eofGraceMs: 50, termGraceMs: 50 })
      .run(subprocessHandleTarget(handle))
    expect(record).toEqual(['waitForExit:window', 'terminate', 'waitForExit:window', 'waitForExit:final'])
    expect(handle.stdin?.writableEnded).toBe(true)
  })

  it('begins termination from the forced tier on win32', async () => {
    const record: string[] = []
    const handle = fakeHandle(record, { onWaitForExit: occupiedUntilForced })
    await new TerminationLadder({ eofGraceMs: 50, termGraceMs: 50, platform: 'win32' })
      .run(subprocessHandleTarget(handle))
    expect(record).toEqual(['waitForExit:window', 'terminate', 'waitForExit:final'])
  })

  it('survives a stdin writer that closes concurrently', async () => {
    const record: string[] = []
    const stdin = new PassThrough()
    const handle = fakeHandle(record, { stdin, onWaitForExit: occupiedUntilForced })
    stdin.end()
    stdin.destroy()
    await new TerminationLadder({ eofGraceMs: 50, termGraceMs: 50 })
      .run(subprocessHandleTarget(handle))
    expect(record).toEqual(['waitForExit:window', 'terminate', 'waitForExit:window', 'waitForExit:final'])
  })

  it('skips the ladder for a range that already finished', async () => {
    const record: string[] = []
    const handle = fakeHandle(record, {
      done: Promise.resolve({ exitCode: 0, signal: null }),
    })
    const target = subprocessHandleTarget(handle)
    await Promise.resolve()
    await new TerminationLadder({ eofGraceMs: 50, termGraceMs: 50 }).run(target)
    expect(record).toEqual([])
    expect(handle.stdin?.writableEnded).toBe(false)
  })

  it('still terminates when the range outcome rejects', async () => {
    const record: string[] = []
    const handle = fakeHandle(record, {
      done: Promise.reject(new Error('spawn failed')),
      onWaitForExit: () => Promise.resolve(true),
    })
    await new TerminationLadder({ eofGraceMs: 0, termGraceMs: 0 })
      .run(subprocessHandleTarget(handle))
    expect(record).toEqual(['terminate', 'waitForExit:final'])
  })

  it('waits unbounded in the forced tier for the owner exit proof', async () => {
    vi.useFakeTimers()
    try {
      const record: string[] = []
      const exited = Promise.withResolvers<boolean>()
      const handle = fakeHandle(record, {
        onWaitForExit: (signal) => {
          if (signal === undefined) return exited.promise
          return new Promise((resolve) => {
            signal.addEventListener('abort', () => { resolve(false) }, { once: true })
          })
        },
      })
      const disposed = new TerminationLadder({ eofGraceMs: 50, termGraceMs: 50 })
        .run(subprocessHandleTarget(handle))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(record).toEqual(['waitForExit:window', 'terminate', 'waitForExit:window', 'waitForExit:final'])
      let settled = false
      void disposed.then(() => { settled = true })
      await Promise.resolve()
      expect(settled).toBe(false)
      exited.resolve(true)
      await disposed
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves stdin open when the target omits endStdin', async () => {
    const record: string[] = []
    const handle = fakeHandle(record, {
      onWaitForExit: () => Promise.resolve(true),
    })
    const { endStdin: _ownedByQuery, ...target } = subprocessHandleTarget(handle)
    await new TerminationLadder({ eofGraceMs: 0, termGraceMs: 0 }).run(target)
    expect(handle.stdin?.writableEnded).toBe(false)
    expect(record).toEqual(['terminate', 'waitForExit:final'])
  })
})
