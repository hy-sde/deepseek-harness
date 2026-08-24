/**
 * Zstd-aware read routing for the model-facing `read` tool: session logs
 * (`session.jsonl.zstd`) and standalone `.zst`/`.zstd` files are served as
 * decoded text instead of being rejected as binary — the same container
 * format understanding the session persistence backend uses (concatenated
 * checksummed frames, not a single collapsed stream).
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
}

const ZSTD_MAGIC_BYTES = [0x28, 0xb5, 0x2f, 0xfd]

function hasZstdMagic(data: Uint8Array): boolean {
  return data.byteLength >= 4
    && data[0] === ZSTD_MAGIC_BYTES[0] && data[1] === ZSTD_MAGIC_BYTES[1]
    && data[2] === ZSTD_MAGIC_BYTES[2] && data[3] === ZSTD_MAGIC_BYTES[3]
}

function isZstdPath(filePath: string): boolean {
  return /\.zst$/i.test(filePath) || /\.zstd$/i.test(filePath)
}

/** Strip the trailing `.zst`/`.zstd` for the display path, honoring `foo.jsonl.zstd` → `foo.jsonl`. */
function stripZstdSuffix(filePath: string): string {
  return filePath.replace(/\.(?:zst|zstd)$/i, '')
}

/**
 * Try to read `filePath` as a zstd-compressed text stream (`foo.zst`,
 * `foo.zstd`, `foo.jsonl.zstd`). Returns a result when the path carries a zstd
 * extension AND the file actually begins with the zstd magic; otherwise
 * returns undefined so the caller falls through to the regular text read.
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
  if (!isZstdPath(filePath)) return undefined

  const target = await ctx.fs.resolve(filePath, sessionResolveOptions(exec, filePath))
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined || info.type !== 'file') return undefined

  let data: Uint8Array
  try {
    data = await ctx.fs.readBytes(target, exec.signal, caps.maxZstdBytes)
  } catch (error) {
    throw new FsError(`cannot read zstd file "${target.displayPath}": ${describeError(error)}`, 'FS_IO_ERROR')
  }
  if (!hasZstdMagic(data)) return undefined // not actually zstd — let the regular read decide

  // Decoded content is immutable text; observe the host file so a later
  // guarded mutation of the compressed file races correctly.
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

  const decoded = await decodeZstdText(data, target.displayPath)
  if (decoded === undefined) return undefined // not valid UTF-8 text → fall through

  const window = await buildWindow(
    [decoded],
    {
      offset: 1,
      limit: caps.limit,
      maxLineLength: caps.maxLineLength,
      maxBytes: caps.maxBytes,
    },
    stripZstdSuffix(target.displayPath),
  )
  return {
    displayPath: stripZstdSuffix(target.displayPath),
    lines: window.lines,
    totalLines: window.totalLines,
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
