/**
 * Resolve the TypeScript compiler behind the repository's type-check gates. The default
 * is the pinned stock `typescript` package, spawned through Node (never a platform shell
 * shim) and honoring `--max-old-space-size`. A Go-native tsfork binary (the can1357
 * perf fork, parked at `~/.dsh/tsfork/tsc`) may be selected explicitly — it spawns
 * without Node flags — but never automatically: its TS 7.1.0-dev harvest cannot yet
 * type JSON import attributes (`with { type: "json" }`), which the vendor/pi-ai
 * providers use, so an automatic fork preference would fail the graph.
 *
 * `DSH_TSC` selects the compiler: `stock` (or unset) forces the pinned compiler,
 * `tsfork` requires the parked binary, and any other value names a fork binary path
 * directly. An explicit selection never silently degrades — a missing forced compiler
 * is an error. Keep one compiler selection per `.tsbuildinfo` directory: the builder
 * tags its incremental state with the compiler version, so alternating selections
 * make every run cold.
 * @module tsc-compiler
 */

import { spawnSync } from 'node:child_process'
import { constants as fsConstants, accessSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Spawn specification of one resolved TypeScript compiler. */
export interface TscCompiler {
  /** Which compiler family the spawn runs. */
  readonly kind: 'tsfork' | 'typescript'
  /** Executable to spawn: the Go binary itself, or Node running the stock JS entry. */
  readonly command: string
  /** Arguments before the caller's tsc arguments: Node flags and the JS entry for stock, empty for tsfork. */
  readonly args: readonly string[]
}

/** Optional inputs of the compiler search; every field defaults to the live process value. */
export interface TscSpawnOptions {
  /** Node `--max-old-space-size` applied to the stock compiler; tsfork ignores Node heap flags. */
  readonly heapOldSpaceMb?: number | undefined
  /** Environment read for `DSH_TSC`; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv | undefined
  /** Home directory searched for the parked fork and `~` expansion; defaults to `os.homedir()`. */
  readonly home?: string | undefined
}

/**
 * Search for the TypeScript compiler without composing arguments.
 * @param options - Environment and home-directory overrides for the search.
 * @returns The resolved compiler kind, executable, and argument prefix.
 * @throws If `DSH_TSC` names `tsfork` or a path whose binary is missing or not executable.
 */
export function resolveTscCompiler(options: TscSpawnOptions = {}): TscCompiler {
  const home = options.home ?? homedir()
  const selection = (options.env ?? process.env).DSH_TSC
  if (selection === undefined || selection === '' || selection === 'stock') return stockCompiler()
  const fork = selection === 'tsfork' ? join(home, '.dsh', 'tsfork', 'tsc') : expandHome(selection, home)
  if (isExecutableFile(fork)) return { kind: 'tsfork', command: fork, args: [] }
  if (selection === 'tsfork') {
    throw new Error(`tsc-compiler: DSH_TSC=tsfork requires the parked fork binary at ${fork}`)
  }
  throw new Error(`tsc-compiler: DSH_TSC names a missing binary: ${fork}`)
}

/**
 * Compose the full spawn specification for one compiler invocation.
 * @param tscArgs - Arguments handed to the compiler itself, in `-b`/`-p` argument order.
 * @param options - Heap size for the stock compiler, plus the search overrides.
 * @returns The spawn specification; the caller spawns `command` with the joined arguments.
 * @throws If `DSH_TSC` names a compiler that is missing.
 */
export function tscSpawn(tscArgs: readonly string[], options: TscSpawnOptions = {}): TscCompiler {
  const compiler = resolveTscCompiler(options)
  if (compiler.kind === 'tsfork') return { ...compiler, args: [...tscArgs] }
  const heap = options.heapOldSpaceMb === undefined ? [] : [`--max-old-space-size=${String(options.heapOldSpaceMb)}`]
  return { ...compiler, args: [...heap, ...compiler.args, ...tscArgs] }
}

/**
 * Read the build stamp parked next to a tsfork binary (`<dir>/VERSION`), if any.
 * @param binary - Path of the tsfork binary.
 * @returns The stamp's first line, or `null` when the stamp is absent or empty.
 */
export function readTsforkStamp(binary: string): string | null {
  try {
    const stamp = readFileSync(join(dirname(binary), 'VERSION'), 'utf8').trim()
    return stamp === '' ? null : stamp.split('\n')[0]?.trim() || null
  } catch {
    return null
  }
}

function stockCompiler(): TscCompiler {
  return { kind: 'typescript', command: process.execPath, args: [fileURLToPath(import.meta.resolve('typescript/bin/tsc'))] }
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

if (import.meta.main) {
  // The CLI replaces the direct `node --max-old-space-size=… typescript/bin/tsc` script
  // segments; 8192 matches the heap every current caller passed to the stock compiler.
  const invocation = tscSpawn(process.argv.slice(2), { heapOldSpaceMb: 8192 })
  console.error(selectionNotice(invocation))
  const result = spawnSync(invocation.command, [...invocation.args], { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  process.exitCode = result.status ?? 1
}

function selectionNotice(compiler: TscCompiler): string {
  if (compiler.kind === 'typescript') return 'tsc-compiler: stock typescript (node_modules/typescript)'
  const stamp = readTsforkStamp(compiler.command)
  return `tsc-compiler: tsfork${stamp === null ? '' : ` ${stamp}`} (${compiler.command})`
}
