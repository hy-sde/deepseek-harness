/**
 * Zstd-aware read routing for the model-facing `read` tool: session logs
 * (`session.jsonl.zstd`) and standalone `.zst`/`.zstd` files are served as
 * decoded text instead of being rejected as binary — the same container
 * format understanding the session persistence backend uses (concatenated
 * checksummed frames, not a single collapsed stream). A session log read
 * with a `?outline=1` suffix renders the turn outline (read-session) in
 * place of the transcript; any suffix/parse failure falls back to today's
 * behavior, and a literal path that carries `?` and exists on disk wins.
 *
 * Read-only by construction: decoded content has no edit path (matches
 * archive/native routing). The host file is observed as present, and the
 * decoded window is rendered through the standard read window so offset/limit
 * slicing and byte caps apply uniformly.
 * @module @deepseek-ai/dsh-tool-fs/src/read-zstd
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import {
  decompressZstdFrame, scanZstdFrames,
} from '@deepseek-ai/dsh-zstd-frame'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { buildWindow, type FileTextLine } from './read-render.ts'
import { tryRenderSessionTranscript, tryRenderSessionTurnOutline } from './read-session.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { ReadToolCaps } from './read.ts'

/** Default cap on zstd input bytes loaded into memory (the `readMaxZstdBytes` config). */
export const READ_MAX_ZSTD_BYTES = 64 * 1024 * 1024

/** Default cap on decoded plaintext (any single decompressed frame or the whole stream). */
export const READ_MAX_ZSTD_DECODED_BYTES = 128 * 1024 * 1024

/** One resolved zstd read: the decoded text window of the compressed file. */
export interface ZstdReadResult {
  /** Full display path for the read outcome (suffix stripped). */
  displayPath: string
  /** Line-numbered window of the decoded plaintext. */
  lines: FileTextLine[]
  /** Exact total line count of the decoded plaintext. */
  totalLines: number
  /** Explanatory footer for the outcome; set only when the outline rendered. */
  notice?: string
}

const ZSTD_MAGIC_BYTES = [0x28, 0xb5, 0x2f, 0xfd]

/** Zstd path extensions, longest first (mirrors the native routing's scan). */
const ZSTD_EXTENSIONS = ['.zstd', '.zst'] as const

function hasZstdMagic(data: Uint8Array): boolean {
  return data.byteLength >= 4
    && data[0] === ZSTD_MAGIC_BYTES[0] && data[1] === ZSTD_MAGIC_BYTES[1]
    && data[2] === ZSTD_MAGIC_BYTES[2] && data[3] === ZSTD_MAGIC_BYTES[3]
}

/** Strip the trailing `.zst`/`.zstd` for the display path, honoring `foo.jsonl.zstd` → `foo.jsonl`. */
function stripZstdSuffix(filePath: string): string {
  return filePath.replace(/\.(?:zst|zstd)$/i, '')
}

/**
 * Split an authored path at the zstd extension boundary: the extension must be
 * followed by `?` (query suffix) or end-of-path. Mirrors the native routing's
 * `findSqliteBoundary` scan — case-insensitive, longest extension first, and a
 * non-boundary character continues the scan. `:` is deliberately NOT a
 * boundary here (no `<log>.zst:<selector>` surface). Returns the base path and
 * the raw query (without the `?`), or undefined when the path names no zstd
 * target.
 */
export function zstdTargetOf(authoredPath: string): { path: string; query: string | undefined } | undefined {
  const normalized = authoredPath.replaceAll('\\', '/')
  const lower = normalized.toLowerCase()
  for (const extension of ZSTD_EXTENSIONS) {
    let start = 0
    while (true) {
      const relative = lower.indexOf(extension, start)
      if (relative === -1) break
      const end = relative + extension.length
      const boundary = lower[end]
      if (boundary === '?' || boundary === undefined) {
        return {
          path: boundary === undefined ? normalized : normalized.slice(0, end),
          query: boundary === undefined ? undefined : normalized.slice(end + 1),
        }
      }
      start = end
    }
  }
  return undefined
}

/** True when the suffix query requests outline mode (`?outline=1`). */
function outlineRequested(query: string | undefined): boolean {
  return query !== undefined && new URLSearchParams(query).get('outline') === '1'
}

/**
 * Try to read `filePath` as a zstd-compressed text stream (`foo.zst`,
 * `foo.zstd`, `foo.jsonl.zstd`, optionally `…?outline=1`). Returns a result
 * when the path carries a zstd extension AND the file actually begins with
 * the zstd magic; otherwise returns undefined so the caller falls through to
 * the regular text read. A literal path whose name carries `?` and exists on
 * disk wins (the regular read serves it); a session log read with
 * `?outline=1` renders its turn outline instead of the transcript.
 * @param ctx - the plugin context, providing `fs` resolution and observation.
 * @param exec - the current tool execution, including session cwd and signal.
 * @param filePath - the raw path supplied to the read tool.
 * @param caps - the resolved read caps (line/byte limits).
 */
export async function tryReadZstd(
  ctx: Context,
  exec: ToolExecution,
  filePath: string,
  caps: ReadToolCaps,
): Promise<ZstdReadResult | undefined> {
  const target = zstdTargetOf(filePath)
  if (target === undefined) return undefined

  // A real file (or directory) whose literal name carries the `?` wins — the
  // regular read serves it, whatever it is. Never shadow an existing path.
  if (target.query !== undefined) {
    const literal = await ctx.fs.resolve(filePath, await sessionResolveOptions(ctx, exec, filePath))
    const literalInfo = await ctx.fs.stat(literal, exec.signal)
    if (literalInfo !== undefined) return undefined
  }

  const resolved = await ctx.fs.resolve(target.path, await sessionResolveOptions(ctx, exec, target.path))
  const info = await ctx.fs.stat(resolved, exec.signal)
  if (info === undefined || info.type !== 'file') return undefined

  let data: Uint8Array
  try {
    data = await ctx.fs.readBytes(resolved, exec.signal, caps.maxZstdBytes)
  } catch (error) {
    throw new FsError(`cannot read zstd file "${resolved.displayPath}": ${describeError(error)}`, 'FS_IO_ERROR')
  }
  if (!hasZstdMagic(data)) return undefined // not actually zstd — let the regular read decide

  // Decoded content is immutable text; observe the host file so a later
  // guarded mutation of the compressed file races correctly.
  ctx.emit('fs/observed', resolved, { kind: 'present', version: info.version }, exec)

  const decoded = await decodeZstdText(data, resolved.displayPath)
  if (decoded === undefined) return undefined // not valid UTF-8 text → fall through

  // Upgrade: a decoded stream that parses as a session log renders as a
  // readable transcript (current-surface projection + compaction digests)
  // instead of the raw JSONL window — or, when `?outline=1` is requested, as
  // the bounded turn outline. Any parse/fold problem falls back to the
  // generic decoded-plaintext window below.
  const outline = outlineRequested(target.query) ? tryRenderSessionTurnOutline(decoded) : undefined
  const rendered = outline ?? tryRenderSessionTranscript(decoded) ?? decoded
  const notice = outline === undefined
    ? undefined
    : 'Rendered the turn outline (?outline=1); read the same path without ?outline=1 for the full transcript.'

  const window = await buildWindow(
    [rendered],
    {
      offset: 1,
      limit: caps.limit,
      maxLineLength: caps.maxLineLength,
      maxBytes: caps.maxBytes,
    },
    stripZstdSuffix(resolved.displayPath),
  )
  return {
    displayPath: stripZstdSuffix(resolved.displayPath),
    lines: window.lines,
    totalLines: window.totalLines,
    ...notice !== undefined ? { notice } : {},
  }
}

/**
 * Decode concatenated checksummed zstd frames into one UTF-8 string.
 * Returns undefined when the decoded content is not valid UTF-8 (binary) so
 * the caller falls through; throws a clear FsError when a frame is corrupt or
 * the decoded output exceeds the cap.
 */
async function decodeZstdText(data: Uint8Array, displayPath: string): Promise<string | undefined> {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
  let frames
  try {
    frames = scanZstdFrames(buffer, 10_000).frames
  } catch (error) {
    throw new FsError(`cannot decode zstd file "${displayPath}": ${describeError(error)}`, 'FS_IO_ERROR')
  }
  const decoded: Buffer[] = []
  let total = 0
  for (const frame of frames) {
    let plain: Buffer
    try {
      plain = await decompressZstdFrame(buffer.subarray(frame.start, frame.end), READ_MAX_ZSTD_DECODED_BYTES)
    } catch (error) {
      throw new FsError(`cannot decode zstd file "${displayPath}": ${describeError(error)}`, 'FS_IO_ERROR')
    }
    total += plain.length
    if (total > READ_MAX_ZSTD_DECODED_BYTES) {
      throw new FsError(
        `cannot decode zstd file "${displayPath}": decoded plaintext exceeds ${READ_MAX_ZSTD_DECODED_BYTES} bytes`,
        'FS_TOO_LARGE',
      )
    }
    decoded.push(plain)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(decoded))
  } catch {
    return undefined
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
