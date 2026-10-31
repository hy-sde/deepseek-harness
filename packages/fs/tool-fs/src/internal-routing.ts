/**
 * The read tool's internal-URL routing: when `ctx.internalUrls` is mounted and
 * the requested path is a handled `scheme://` URL (or a `<path>:conflicts`
 * selector), the read resolves through the registry instead of the filesystem,
 * renders the virtual content as a line-numbered window, and — for regular
 * filesystem reads — scans the surfaced lines for git conflict blocks,
 * registering them with the session history and appending a resolution notice.
 * @module @deepseek-ai/dsh-tool-fs/internal-routing
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { InternalUrlsService } from '@deepseek-ai/dsh-internal-urls'
import {
  ConflictHistory,
  formatConflictSummary,
  formatConflictWarning,
  formatScanCapNote,
  scanConflictsInContent,
  scanConflictLines,
} from '@deepseek-ai/dsh-internal-urls/conflict'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { buildWindow } from './read-render.ts'
import type { FileTextLine } from './read-render.ts'
import { sessionCwd } from './session-cwd.ts'

/** The subset of read caps the routing needs to build a bounded window. */
export interface InternalReadCaps {
  maxLineLength: number
  maxBytes: number
}

/** Tool-owned window request (validated read args). */
export interface ReadRequest {
  filePath: string
  offset: number
  limit: number
}

/** A fully-formed read outcome, virtual or filesystem-backed. */
export interface InternalReadOutcome {
  /** Model-facing path (the internal URL for virtual reads). */
  path: string
  offset: number
  lines: FileTextLine[]
  totalLines: number
  /** Optional conflict-resolution notice, rendered after the file body. */
  notice?: string
}

/** The calling agent's session id, used to key session-scoped handler state. */
export function sessionKeyOf(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.id
}

/** Build a {@link ResolveContext} for the calling tool execution. */
export async function resolveContextOf(ctx: Context, exec: ToolExecution, path: string): Promise<{
  cwd?: string
  signal: AbortSignal
  sessionKey?: string
}> {
  const cwd = await sessionCwd(ctx, exec, path)
  const sessionKey = sessionKeyOf(exec)
  return {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
    ...sessionKey !== undefined ? { sessionKey } : {},
  }
}

/**
 * Resolve a scheme URL (or `<path>:conflicts` selector) into a virtual window.
 * Returns `undefined` when the path is not an internal URL, so the caller
 * falls through to the filesystem path untouched.
 */
export async function tryReadInternal(
  ctx: Context,
  iu: InternalUrlsService,
  exec: ToolExecution,
  request: ReadRequest,
  caps: InternalReadCaps,
): Promise<InternalReadOutcome | undefined> {
  const filePath = request.filePath

  // `<path>:conflicts` — whole-file conflict summary for a plain file.
  if (!iu.canHandle(filePath) && filePath.endsWith(':conflicts')) {
    return readConflictSummary(ctx, iu, exec, filePath, request, caps)
  }

  if (!iu.canHandle(filePath)) return undefined
  const resource = await iu.resolve(filePath, await resolveContextOf(ctx, exec, filePath))
  if (resource.isDirectory === true) {
    throw new FsError(`cannot read "${resource.url}": directory listing must be read as text (content summary)`, 'FS_NOT_REGULAR_FILE')
  }
  const window = await buildWindow(
    [resource.content],
    { offset: request.offset, limit: request.limit, maxLineLength: caps.maxLineLength, maxBytes: caps.maxBytes },
    resource.url,
  )
  return { path: resource.url, offset: request.offset, lines: window.lines, totalLines: window.totalLines }
}

/**
 * Byte cap for the `<path>:conflicts` whole-file scan. Matches the read
 * pipeline's stream threshold: past the cap, blocks are not counted or
 * registered here, and reconciliation leaves them alone.
 */
const CONFLICT_SCAN_MAX_BYTES = 10 * 1024 * 1024

/**
 * Binary-sample window for the capped :conflicts scan, matching fs-local's
 * readText binary sniff (fsio.ts BINARY_SAMPLE_BYTES = 8192).
 */
const BINARY_SAMPLE_BYTES = 8192

/** Read `<path>:conflicts` — scan the whole file, register every block, render a summary. */
async function readConflictSummary(
  ctx: Context,
  iu: InternalUrlsService,
  exec: ToolExecution,
  rawPath: string,
  request: ReadRequest,
  caps: InternalReadCaps,
): Promise<InternalReadOutcome> {
  const base = rawPath.slice(0, -':conflicts'.length)
  const cwd = await sessionCwd(ctx, exec, base)
  const target = await ctx.fs.resolve(base, cwd !== undefined ? { cwd } : undefined)
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new FsError(`cannot read "${base}": not found`, 'FS_NOT_FOUND')
  if (info.type !== 'file') throw new FsError(`cannot read "${base}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  // Bounded scan: a byte cap keeps pathological files cheap, and blocks past
  // the cap are neither listed nor retired here (reconcilePath preserves them).
  const truncated = info.size !== undefined && info.size > CONFLICT_SCAN_MAX_BYTES
  let text: string
  let truncatedAtLine: number | undefined
  if (truncated) {
    const bytes = await ctx.fs.readByteRange(target, { offset: 0, length: CONFLICT_SCAN_MAX_BYTES }, exec.signal)
    // The raw byte path has no readText binary check: mirror fs-local's sniff
    // so a binary file still fails with FS_NOT_TEXT instead of decoding to
    // mojibake and reporting a misleading "no unresolved conflicts" success.
    if (bytes.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
      throw new FsError(`cannot read "${base}": binary file`, 'FS_NOT_TEXT')
    }
    // Decode strictly like readText below the cap: invalid UTF-8 is an error
    // (FS_NOT_TEXT), not silently-replaced mojibake (fsio.ts notTextError).
    // A byte cap can split a multi-byte sequence at the prefix end; trim back
    // to the last complete codepoint boundary first, or a valid file whose cap
    // byte falls inside a sequence is spuriously rejected (fs-local's
    // streaming decoder carries partial sequences across chunks).
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(trimToCodepointBoundary(bytes))
    } catch {
      throw new FsError(`cannot read "${base}": invalid UTF-8 text`, 'FS_NOT_TEXT')
    }
    truncatedAtLine = text.split('\n').length
  } else {
    // Keep readText (not raw bytes) so a binary file still fails with FS_NOT_TEXT.
    text = await ctx.fs.readText(target, exec.signal)
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1)
  const blocks = scanConflictsInContent(text)
  const history = iu.conflicts(sessionKeyOf(exec))
  const absolutePath = ctx.fs.processPath(target)
  history.reconcilePath(absolutePath, truncatedAtLine !== undefined ? { blocks, truncatedAtLine } : { blocks })
  const entries = blocks.map(block => history.register({
    ...block,
    absolutePath,
    displayPath: base,
  }))
  const summary = entries.length === 0
    ? truncatedAtLine !== undefined
      ? `No unresolved conflicts before line ${truncatedAtLine} of ${base}.\n${formatScanCapNote(base, truncatedAtLine)}`
      : 'No unresolved conflicts in ' + base + '.'
    : formatConflictSummary(entries, base, truncatedAtLine)
  const window = await buildWindow(
    [summary],
    { offset: request.offset, limit: request.limit, maxLineLength: caps.maxLineLength, maxBytes: caps.maxBytes },
    rawPath,
  )
  return { path: rawPath, offset: request.offset, lines: window.lines, totalLines: window.totalLines }
}

/**
 * Scan a completed filesystem read's window for conflict blocks, register them
 * with the calling session's history (id reuse by path+start line), and render
 * the resolution notice. Returns `undefined` when nothing to report or no
 * session key / registry are available.
 */
/**
 * Trim a byte prefix back to the last complete UTF-8 codepoint boundary: a
 * byte-capped read can cut a multi-byte sequence mid-way, and the strict
 * decoder (fatal: true) would reject the incomplete tail as invalid UTF-8
 * even though the underlying file is valid.
 */
function trimToCodepointBoundary(bytes: Uint8Array): Uint8Array {
  let end = bytes.length
  let back = 0
  // Walk back over up to 3 continuation bytes (10xxxxxx) to the last lead byte.
  while (back < 4 && end > 0 && ((bytes[end - 1] ?? 0) & 0xc0) === 0x80) {
    end -= 1
    back += 1
  }
  if (back === 0) return bytes
  const lead = bytes[end - 1] ?? 0
  // Expected sequence length from the lead byte; a continuation byte here
  // (4+ continuations, already invalid) decodes expected 1 and stays put so
  // the fatal decoder reports it.
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  if (back < expected) return bytes.subarray(0, end - 1)
  return bytes
}

export function conflictNoticeForRead(
  ctx: Context,
  iu: InternalUrlsService,
  exec: ToolExecution,
  target: FsTarget,
  outcome: { path: string; offset: number; lines: FileTextLine[] },
): string | undefined {
  const sessionKey = sessionKeyOf(exec)
  if (sessionKey === undefined) return undefined
  const blocks = scanConflictLines(outcome.lines.map(line => line.text), outcome.offset)
  if (blocks.length === 0) return undefined
  const history: ConflictHistory = iu.conflicts(sessionKey)
  const absolutePath = ctx.fs.processPath(target)
  const entries = blocks.map(block => history.register({
    ...block,
    absolutePath,
    displayPath: outcome.path,
  }))
  return formatConflictWarning(entries)
}
