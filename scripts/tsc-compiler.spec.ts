import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { removeFixtureSafely } from './test-fixture-cleanup.ts'
import { readTsforkStamp, resolveTscCompiler, tscSpawn } from './tsc-compiler.ts'

const root = resolve(import.meta.dirname, '..')
const stockEntry = fileURLToPath(import.meta.resolve('typescript/bin/tsc'))

/** Create a throwaway home directory whose parked fork binary exists as described, or not. */
function fakeHome(fork: 'executable' | 'plain-file' | 'absent'): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-tsc-compiler-home-'))
  onTestFinished(() => { removeFixtureSafely(home) })
  if (fork !== 'absent') {
    mkdirSync(join(home, '.dsh', 'tsfork'), { recursive: true })
    writeFileSync(join(home, '.dsh', 'tsfork', 'tsc'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(home, '.dsh', 'tsfork', 'tsc'), fork === 'executable' ? 0o755 : 0o644)
  }
  return home
}

describe('resolveTscCompiler', () => {
  it('selects the pinned stock compiler by default even when a parked fork is present', () => {
    const compiler = resolveTscCompiler({ env: {}, home: fakeHome('executable') })
    expect(compiler).toEqual({ kind: 'typescript', command: process.execPath, args: [stockEntry] })
    expect(resolveTscCompiler({ env: {}, home: fakeHome('absent') }).kind).toBe('typescript')
  })

  it('requires an explicit DSH_TSC=tsfork to name a runnable fork binary', () => {
    const plainFile = fakeHome('plain-file')
    expect(() => { resolveTscCompiler({ env: { DSH_TSC: 'tsfork' }, home: plainFile }) })
      .toThrow(`tsc-compiler: DSH_TSC=tsfork requires the parked fork binary at ${join(plainFile, '.dsh', 'tsfork', 'tsc')}`)
    const directory = fakeHome('absent')
    mkdirSync(join(directory, '.dsh', 'tsfork', 'tsc'), { recursive: true })
    expect(() => { resolveTscCompiler({ env: { DSH_TSC: 'tsfork' }, home: directory }) })
      .toThrow('tsc-compiler: DSH_TSC=tsfork requires the parked fork binary at')
  })

  it('forces the pinned stock compiler under DSH_TSC=stock even with a fork present', () => {
    const compiler = resolveTscCompiler({ env: { DSH_TSC: 'stock' }, home: fakeHome('executable') })
    expect(compiler).toEqual({ kind: 'typescript', command: process.execPath, args: [stockEntry] })
  })

  it('requires the parked fork under DSH_TSC=tsfork and never silently degrades', () => {
    expect(resolveTscCompiler({ env: { DSH_TSC: 'tsfork' }, home: fakeHome('executable') }).kind).toBe('tsfork')
    const absent = fakeHome('absent')
    expect(() => { resolveTscCompiler({ env: { DSH_TSC: 'tsfork' }, home: absent }) })
      .toThrow(`tsc-compiler: DSH_TSC=tsfork requires the parked fork binary at ${join(absent, '.dsh', 'tsfork', 'tsc')}`)
  })

  it('resolves DSH_TSC paths with ~ expansion and rejects missing binaries', () => {
    const home = fakeHome('executable')
    expect(resolveTscCompiler({ env: { DSH_TSC: '~/.dsh/tsfork/tsc' }, home }).command).toBe(join(home, '.dsh', 'tsfork', 'tsc'))
    expect(() => { resolveTscCompiler({ env: { DSH_TSC: join(home, 'nope', 'tsc') }, home }) })
      .toThrow(`tsc-compiler: DSH_TSC names a missing binary: ${join(home, 'nope', 'tsc')}`)
  })

  it('treats an empty DSH_TSC like the stock default', () => {
    expect(resolveTscCompiler({ env: { DSH_TSC: '' }, home: fakeHome('executable') }).kind).toBe('typescript')
    expect(resolveTscCompiler({ env: { DSH_TSC: '' }, home: fakeHome('absent') }).kind).toBe('typescript')
  })
})

describe('tscSpawn', () => {
  it('prepends the Node heap budget and stock entry for the stock compiler', () => {
    const spawn = tscSpawn(['-p', 'tsconfig.host.json'], { env: {}, heapOldSpaceMb: 8192, home: fakeHome('absent') })
    expect(spawn).toEqual({
      kind: 'typescript',
      command: process.execPath,
      args: ['--max-old-space-size=8192', stockEntry, '-p', 'tsconfig.host.json'],
    })
  })

  it('omits the heap flag when no heap size is given and never flags the fork', () => {
    expect(tscSpawn(['-b', 'tsconfig.client.json'], { env: {}, home: fakeHome('absent') }).args)
      .toEqual([stockEntry, '-b', 'tsconfig.client.json'])
    const spawn = tscSpawn(['-b', 'tsconfig.client.json'], { env: { DSH_TSC: 'tsfork' }, heapOldSpaceMb: 8192, home: fakeHome('executable') })
    expect(spawn.kind).toBe('tsfork')
    expect(spawn.args).toEqual(['-b', 'tsconfig.client.json'])
  })
})

describe('readTsforkStamp', () => {
  it('reads the first line of the VERSION stamp next to the binary', () => {
    const home = fakeHome('executable')
    const binary = join(home, '.dsh', 'tsfork', 'tsc')
    expect(readTsforkStamp(binary)).toBeNull()
    writeFileSync(join(home, '.dsh', 'tsfork', 'VERSION'), 'binary: tsc-v4 (Go TS 7.1.0-dev)\nbuilt: 2026-10-25\n')
    expect(readTsforkStamp(binary)).toBe('binary: tsc-v4 (Go TS 7.1.0-dev)')
  })

  it('treats an empty or absent stamp as null', () => {
    const home = fakeHome('executable')
    writeFileSync(join(home, '.dsh', 'tsfork', 'VERSION'), '\n')
    expect(readTsforkStamp(join(home, '.dsh', 'tsfork', 'tsc'))).toBeNull()
    expect(readTsforkStamp(join(home, 'elsewhere', 'tsc'))).toBeNull()
  })
})

describe('tsc-compiler CLI', () => {
  it('prints the selection notice and forwards the compiler exit status', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', resolve(root, 'scripts', 'tsc-compiler.ts'), '--version'], {
      encoding: 'utf8',
      env: { ...process.env, DSH_TSC: 'stock' },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('tsc-compiler: stock typescript (node_modules/typescript)')
  })

  it('fails when an explicit DSH_TSC selection is missing', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', resolve(root, 'scripts', 'tsc-compiler.ts'), '--version'], {
      encoding: 'utf8',
      env: { ...process.env, DSH_TSC: join(root, 'no-such-compiler') },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('tsc-compiler: DSH_TSC names a missing binary')
  })
})
