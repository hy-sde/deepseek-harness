/**
 * Native-sidecar routing for the model-facing `read` tool: when the resolved
 * bytes are a PDF (`%PDF-` magic) or a SQLite database (`SQLite format 3\0`
 * magic), the read is served by the `dsh-omp-native` sidecar — a standalone
 * binary extracted from the oh-my-pi Rust rewrite (`native/dsh-omp-native`)
 * — instead of failing as binary or non-text.
 *
 * Like the archive routing (`read-archive.ts`), this is read-only by
 * construction: PDF rasterization and SQLite querying never mutate the source.
 * The sidecar is an optional accelerator: when its binary is not configured or
 * not present, these routes return `undefined` and the regular read handles the
 * path (PDFs and SQLite databases then surface as ordinary/binary reads).
 * @module @deepseek-ai/dsh-tool-fs/src/read-native
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { buildWindow } from './read-render.ts'
import type { ReadToolCaps } from './read.ts'
import { resolveRegularReadTarget } from './read-target.ts'

/** PDF magic. */
const PDF_MAGIC = '%PDF-'
/** SQLite magic. */
const SQLITE_MAGIC = 'SQLite format 3\0'

/** SQLite path extensions, longest first (must mirror the sidecar's candidate split). */
const SQLITE_EXTENSIONS = ['.sqlite3', '.sqlite', '.db3', '.db'] as const

/** PDF path extensions. */
const PDF_EXTENSIONS = ['.pdf'] as const

/**
 * Extract the selector/query suffix after the database extension boundary
 * (`:table[:key]`, `?param=value`), matching the sidecar's own candidate split.
 */
export function sqliteSuffixOf(authoredPath: string): string {
  const normalized = authoredPath.replaceAll('\\', '/')
  const lower = normalized.toLowerCase()
  for (const extension of SQLITE_EXTENSIONS) {
    let start = 0
    while (true) {
      const relative = lower.indexOf(extension, start)
      if (relative === -1) break
      const end = relative + extension.length
      const boundary = lower[end]
      if (boundary === ':' || boundary === '?' || boundary === undefined) {
        return normalized.slice(end)
      }
      start = end
    }
  }
  return ''
}

/**
 * Gate `filePath` by the known PDF/SQLite extensions; the caller then confirms
 * by magic before routing. Returns the extension boundary suffix for SQLite
 * (`:table?…`), or `undefined` when the path names neither family.
 */
export function nativeFamilyOf(filePath: string): { family: 'pdf' | 'sqlite'; suffix: string } | undefined {
  const normalized = filePath.replaceAll('\\', '/')
  const lower = normalized.toLowerCase()
  for (const extension of PDF_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      // A `.pdf` path routes whole (no selector suffix in the omp syntax);
      // `.pdf:…`/`.pdf?…` fall through to `.sqlite` scan, then regular read.
      return { family: 'pdf', suffix: '' }
    }
  }
  return findSqliteBoundary(normalized, lower)
}

/** Sqlite boundary scan: longest extension matched next to `:`/`?` or end-of-path. */
function findSqliteBoundary(original: string, lowerNormalized: string): { family: 'sqlite'; suffix: string } | undefined {
  for (const extension of SQLITE_EXTENSIONS) {
    let start = 0
    while (true) {
      const relative = lowerNormalized.indexOf(extension, start)
      if (relative === -1) break
      const end = relative + extension.length
      const boundary = lowerNormalized[end]
      if (boundary === ':' || boundary === '?' || boundary === undefined) {
        return { family: 'sqlite', suffix: original.slice(end) }
      }
      start = end
    }
  }
  return undefined
}

/** Bounded line window over sidecar text output, mirroring the archive reads. */

/** Longest prefix read for magic sniffing. */
const SNIFF_BYTES = 64

/** Environment override for the sidecar binary; falls back to a repo-relative default. */
export const OMP_NATIVE_ENV = 'DSH_OMP_NATIVE_PATH'

/** Sidecar subcommand timeout. */
const NATIVE_TIMEOUT_MS = 30_000

/** Well-known build outputs probed in order when `DSH_OMP_NATIVE_PATH` is unset. */
const DEFAULT_BINARY_CANDIDATES = [
  'native/dsh-omp-native/target/release/dsh-omp-native',
  'native/dsh-omp-native/target/release/dsh-omp-native.exe',
]

/**
 * Resolve the native sidecar binary, or `undefined` when it is not available
 * (routing then declines and the regular read handles the path).
 */
export function resolveOmpNativeBinary(): string | undefined {
  const fromEnv = process.env[OMP_NATIVE_ENV]
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    if (existsSync(fromEnv)) return fromEnv
  }
  for (const candidate of DEFAULT_BINARY_CANDIDATES) {
    for (const root of [process.cwd(), homedir()]) {
      const full = resolve(root, candidate)
      if (existsSync(full)) return full
    }
  }
  return undefined
}

/** One bounded native invocation result. */
interface NativeInvocation {
  ok: boolean
  value?: Record<string, unknown>
  error?: { kind?: string; message: string; detail?: unknown }
  code: number
}

/** Invoke one sidecar subcommand with a positional argument list. */
function invokeNative(
  binary: string,
  args: string[],
  opts: { timeoutMs: number; signal: AbortSignal },
): Promise<NativeInvocation> {
  return new Promise((resolveInvocation) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: opts.signal,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    let settled = false
    /* v8 ignore start -- the timeout path requires a genuine 30-second hang: the sibling
       race guards (settled flags) beneath are defensive against a timeout racing a
       normal exit, which unit tests cannot produce without sleeping for the full
       NATIVE_TIMEOUT_MS per run. The binary contracts bound every read (<8 MiB out),
       so a 30s stall indicates a wedged process that the timeout+kill then recovers. */
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolveInvocation({ ok: false, error: { kind: 'timeout', message: `dsh-omp-native timed out after ${opts.timeoutMs}ms` }, code: 1 })
    }, opts.timeoutMs)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveInvocation({ ok: false, error: { kind: 'spawn', message: error.message }, code: 1 })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(stdout) as { ok?: unknown; error?: { kind?: string; message?: string; detail?: unknown } } | undefined
        if (parsed !== undefined && parsed.ok !== undefined && typeof parsed.ok === 'object' && parsed.ok !== null) {
          /* v8 ignore next -- code is null only on signal death, which the timeout guard consumes first. */
          resolveInvocation({ ok: true, value: parsed.ok as Record<string, unknown>, code: code ?? 0 })
        } else {
          const parsedError = parsed?.error
          let error: { kind?: string; message: string; detail?: unknown }
          if (parsedError !== undefined) {
            error = { message: parsedError.message ?? 'sidecar failed' }
            if (parsedError.kind !== undefined) error.kind = parsedError.kind
            if (parsedError.detail !== undefined) error.detail = parsedError.detail
          } else {
            error = { message: stderr || 'malformed sidecar output' }
          }
          /* v8 ignore next -- code is null only on signal death, which the timeout guard consumes first. */
          resolveInvocation({ ok: false, error, code: code ?? 1 })
        }
      } catch {
        /* v8 ignore next -- code is null only on signal death, which the timeout guard consumes first. */
        resolveInvocation({ ok: false, error: { message: stderr || 'malformed sidecar JSON output' }, code: code ?? 1 })
      }
    })
    /* v8 ignore stop */
  })
}

/** One resolved native read result: line window + pagination hint (SQLite) or raster summary (PDF). */
export interface NativeReadResult {
  displayPath: string
  lines: Array<{ number: number; text: string }>
  totalLines: number
  /** Optional model-facing footer appended after the read body. */
  notice?: string
}

/** Bounded line window over sidecar text output, mirroring the archive reads. */
async function windowSidecarText(text: string, caps: ReadToolCaps, displayPath: string) {
  return buildWindow(
    [text],
    {
      offset: 1,
      limit: caps.limit,
      maxLineLength: caps.maxLineLength,
      maxBytes: caps.maxBytes,
    },
    displayPath,
  )
}

/**
 * Try to read `filePath` through the `dsh-omp-native` sidecar. Returns a result
 * when the file is a PDF or SQLite database and the sidecar is present, or
 * `undefined` when the caller should fall through to the regular text read.
 * @param ctx - the plugin context providing `fs` resolution and observation.
 * @param exec - the current tool execution, including session cwd and signal.
 * @param filePath - the raw path supplied to the read tool.
 * @param caps - the resolved read caps (line/byte limits).
 */
export async function tryReadNative(
  ctx: Context,
  exec: ToolExecution,
  filePath: string,
  caps: ReadToolCaps,
): Promise<NativeReadResult | undefined> {
  const binary = resolveOmpNativeBinary()
  if (binary === undefined) return undefined

  // Extension gate first (mirrors the archive routing): only .pdf / .sqlite(3)
  // / .db(3) paths reach the byte sniff, so ordinary text reads never pay for a
  // native probe.
  const family = nativeFamilyOf(filePath)
  if (family === undefined) return undefined

  // Resolve only the database path portion: `db.sqlite:table?q=…` splits at the
  // extension boundary, and the suffix (selector/query) is not a filesystem path.
  const suffix = family.suffix
  const basePath = suffix.length > 0 ? filePath.slice(0, filePath.length - suffix.length) : filePath

  const { target, info } = await resolveRegularReadTarget(ctx, exec, basePath)
  if (info.size !== undefined && info.size > 20 * 1024 * 1024) {
    // PDF rasterizer ceiling (20 MiB). Leave huge files to the regular read.
    return undefined
  }

  /* v8 ignore next -- LocalFileSystem always reports size for regular files; the fallback guards exotic backends. */
  const sniffBytes = await ctx.fs.readBytes(target, exec.signal, Math.max(info.size ?? 0, SNIFF_BYTES))
  const asString = new TextDecoder().decode(sniffBytes.subarray(0, SNIFF_BYTES))

  if (family.family === 'sqlite' && asString.startsWith(SQLITE_MAGIC)) {
    const fullAuthoredTarget = `${target.displayPath}${suffix}`
    return readSqliteViaSidecar(binary, exec, target.displayPath, fullAuthoredTarget, caps)
  }
  if (family.family === 'pdf' && asString.startsWith(PDF_MAGIC)) {
    return readPdfViaSidecar(binary, exec, target.displayPath)
  }
  return undefined
}

async function readSqliteViaSidecar(
  binary: string,
  exec: ToolExecution,
  displayPath: string,
  fullAuthoredTarget: string,
  caps: ReadToolCaps,
): Promise<NativeReadResult | undefined> {
  // The caller composed the absolute database path with the selector/query
  // suffix (`db.sqlite:table?limit=10`), so the sidecar opens the host file
  // regardless of the harness cwd.
  const result = await invokeNative(
    binary,
    ['sqlite', fullAuthoredTarget],
    { timeoutMs: NATIVE_TIMEOUT_MS, signal: exec.signal },
  )
  if (!result.ok || result.value === undefined) {
    /* v8 ignore next -- invokeNative always supplies error.message; only kept as a type guard. */
    const message = result.error?.message ?? 'sidecar failed'
    if (result.error?.kind === 'usage' || result.code === 2) {
      return undefined
    }
    throw new FsError(`cannot read SQLite database "${displayPath}": ${message}`, 'FS_IO_ERROR')
  }
  const textValue = result.value.text
  const text = typeof textValue === 'string' ? textValue : ''
  const windowed = await windowSidecarText(text, caps, displayPath)
  return { displayPath, lines: windowed.lines, totalLines: windowed.totalLines }
}

async function readPdfViaSidecar(
  binary: string,
  exec: ToolExecution,
  displayPath: string,
): Promise<NativeReadResult> {
  const result = await invokeNative(
    binary,
    ['pdf', displayPath, '1'],
    { timeoutMs: NATIVE_TIMEOUT_MS, signal: exec.signal },
  )
  if (!result.ok || result.value === undefined) {
    /* v8 ignore next -- invokeNative always supplies error.message; only kept as a type guard. */
    const message = result.error?.message ?? 'sidecar failed'
    throw new FsError(`cannot rasterize PDF "${displayPath}": ${message}`, 'FS_IO_ERROR')
  }
  const page = Number(result.value.page)
  const totalPages = Number(result.value.total_pages)
  const width = Number(result.value.width)
  const height = Number(result.value.height)
  const base64Value = result.value.data_base64
  const base64 = typeof base64Value === 'string' ? base64Value : ''
  const body = [
    `PDF, ${totalPages} page${totalPages === 1 ? '' : 's'}; page ${page} rendered to ${width}x${height} px (${Math.round((base64.length * 3) / 4)} bytes PNG).`,
    'Rasterized by the dsh-omp-native sidecar (hayro). Use read_image with an image-capable model to view the rendered page.',
  ].join('\n')
  const plainLines = body.split('\n')
  return {
    displayPath,
    lines: plainLines.map((text, index) => ({ number: index + 1, text })),
    totalLines: plainLines.length,
  }
}
