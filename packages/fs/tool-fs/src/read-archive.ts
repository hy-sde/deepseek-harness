/**
 * Archive-aware read routing for the model-facing `read` tool: when the path
 * carries an archive extension (`foo.zip:dir/file.txt`) or names an archive
 * file directly, member text is served through the ported multi-format engine
 * (`@deepseek-ai/dsh-fs-archive`) instead of being rejected as binary.
 *
 * Read-only by construction: archive members have no edit path, matching the
 * upstream oh-my-pi behavior. The archive file itself is observed (a plain
 * "present" observation of the host file), so a later guarded mutation of the
 * archive file still races correctly, but member reads never register edits.
 * @module @deepseek-ai/dsh-tool-fs/src/read-archive
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  ArchiveReader,
  parseArchivePathCandidates,
  sniffArchiveFormat,
} from '@deepseek-ai/dsh-fs-archive'
import { formatArchiveEntryLines, openArchive } from '@deepseek-ai/dsh-fs-archive'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { buildWindow, type FileTextLine } from './read-render.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { ReadToolCaps } from './read.ts'

/** One resolved archive read: either a member text window or a directory listing. */
export interface ArchiveReadResult {
  /** Full display path for the read outcome (`archive.ext:member` or the archive path). */
  displayPath: string
  /** Line-numbered window (member text) or listing lines, in display order. */
  lines: FileTextLine[]
  /** Exact total line count of the member text or listing. */
  totalLines: number
}

/** Resolve a member/subdirectory path within the archive, tolerating trailing slashes. */
function resolveArchiveNode(
  reader: ArchiveReader,
  subPath: string,
): { isDirectory: boolean; display: string } | undefined {
  if (subPath === '') return { isDirectory: true, display: '' }
  const normalized = subPath.replace(/\/+$/, '')
  const node = reader.getNode(normalized)
  if (node !== undefined) return { isDirectory: node.isDirectory, display: node.path }
  return undefined
}

/** Open one archive path from bytes via content sniffing. */
async function openFromBytes(bytes: Uint8Array): Promise<ArchiveReader | undefined> {
  const format = sniffArchiveFormat(bytes)
  if (format === undefined) return undefined
  return openArchive({ bytes, format }, {})
}

/**
 * Try to read `filePath` as an archive (`archive.ext` listing or
 * `archive.ext:member` text). Returns a result when the path names a readable
 * archive, or undefined when it is not an archive path (caller falls through
 * to the regular text read).
 * @param ctx - the plugin context, providing `fs` resolution and observation.
 * @param exec - the current tool execution, including session cwd and signal.
 * @param filePath - the raw path supplied to the read tool.
 * @param caps - the resolved read caps (line/byte limits).
 */
export async function tryReadArchive(
  ctx: Context,
  exec: ToolExecution,
  filePath: string,
  caps: ReadToolCaps,
): Promise<ArchiveReadResult | undefined> {
  // No archive extension → not an archive path; leave the regular read to decide.
  const candidates = parseArchivePathCandidates(filePath)
  if (candidates.length === 0) return undefined

  for (const candidate of candidates) {
    const target = await ctx.fs.resolve(candidate.archivePath, sessionResolveOptions(exec, candidate.archivePath))
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined || info.type !== 'file') continue

    // Archive members are immutable; observe the host file as present so a
    // later write to the archive file itself still observes correctly.
    ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

    let data: Uint8Array
    try {
      data = await ctx.fs.readBytes(target, exec.signal, caps.maxArchiveBytes)
    } catch (error) {
      throw new FsError(`cannot read archive "${target.displayPath}": ${describeError(error)}`, 'FS_IO_ERROR')
    }
    const reader = await openFromBytes(data)
    if (reader === undefined) continue

    const resolved = resolveArchiveNode(reader, candidate.subPath)
    if (resolved === undefined) {
      throw new FsError(
        `Path '${candidate.subPath || candidate.archivePath}' not found inside archive '${target.displayPath}'`,
        'FS_NOT_FOUND',
      )
    }

    if (resolved.isDirectory) {
      const listing = directoryListingLines(reader, resolved.display, caps)
      const displayPath =
        resolved.display === '' ? target.displayPath : `${target.displayPath}:${resolved.display}`
      return {
        displayPath,
        lines: listing.lines,
        totalLines: listing.total,
      }
    }

    const entry = await reader.readFile(resolved.display)
    const text = utf8Decode(entry.bytes)
    if (text === null) {
      return {
        displayPath: target.displayPath,
        lines: [{ number: 1, text: `[Cannot read binary archive member '${resolved.display}']` }],
        totalLines: 1,
      }
    }

    const window = await buildWindow(
      [text],
      {
        offset: 1,
        limit: caps.limit,
        maxLineLength: caps.maxLineLength,
        maxBytes: caps.maxBytes,
      },
      `${target.displayPath}:${resolved.display}`,
    )
    return {
      displayPath: `${target.displayPath}:${resolved.display}`,
      lines: window.lines,
      totalLines: window.totalLines,
    }
  }
  return undefined
}

function directoryListingLines(
  reader: ArchiveReader,
  display: string,
  caps: ReadToolCaps,
): { lines: FileTextLine[]; total: number } {
  const entries = reader.listDirectory(display)
  const entryLines = entries.length > 0 ? formatArchiveEntryLines(entries) : ['(empty archive directory)']
  return {
    lines: entryLines.slice(0, caps.limit).map((text, index) => ({ number: index + 1, text })),
    total: entryLines.length,
  }
}

/** Strict UTF-8 decode; returns null for binary members. */
function utf8Decode(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
