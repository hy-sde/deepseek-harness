/**
 * Model-facing UTF-8 read. It performs one provider stat for type, routing, and observed version,
 * streams large or size-unknown files, renders a bounded window, then emits the observation.
 * @module @deepseek-ai/dsh-tool-fs/src/read
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ReadResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type { } from '@deepseek-ai/dsh-fs'
import type { } from '@deepseek-ai/dsh-internal-urls'
import { buildWindow, formatReadOutput, langFromPath, readMetaFromMeta } from './read-render.ts'
import { SNAPSHOT_MAX_BYTES, getSessionSnapshotStore, normalizeToLF, stripBom } from '@deepseek-ai/dsh-hashline'
import { tryReadArchive } from './read-archive.ts'
import { tryReadNative } from './read-native.ts'
import { tryReadZstd } from './read-zstd.ts'
import { conflictNoticeForRead, tryReadInternal } from './internal-routing.ts'
import { resolveRegularReadTarget } from './read-target.ts'

/** Default and maximum number of lines returned by one `read` call (the `readLimit` config). */
export const READ_LIMIT = 2000

/**
 * Default streaming threshold (the `readStreamMinSize` config): files at or
 * above this size stream; smaller files read whole into memory.
 */
export const STREAM_MIN_SIZE = 10 * 1024 * 1024

/** Maximum bytes of an archive file loaded for member reads (the `readMaxArchiveBytes` config). */
export const READ_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

/** Maximum bytes of a zstd file loaded for decoded reads (the `readMaxZstdBytes` config). */
export const READ_MAX_ZSTD_BYTES = 64 * 1024 * 1024

/** Resolved read-tool caps — plugin config after defaulting (see `Config` in index.ts). */
export interface ReadToolCaps {
  /** Default and maximum number of lines returned by one call. */
  limit: number
  /** Maximum characters returned for a single line. */
  maxLineLength: number
  /** Maximum bytes returned for selected file lines. */
  maxBytes: number
  /** Files at or above this size stream; smaller files read whole into memory. */
  streamMinSize: number
  /** Maximum bytes of an archive file loaded into memory for member reads. */
  maxArchiveBytes: number
  /** Maximum bytes of a zstd file loaded into memory for decoded reads. */
  maxZstdBytes: number
  /** Render hashline `[path#TAG]` headers for eligible reads (whole small files recorded into the session snapshot store). */
  snapshotTags: boolean
}

/** Validated `read` arguments after defaulting. */
interface ReadInput {
  filePath: string
  offset: number
  limit: number
  /** Effective per-call column cap after defaulting to the configured value. */
  maxLineLength: number
}

/**
 * Upper bound on the per-call `maxLineLength` input. The configured
 * `readMaxLineLength` is the default, not a ceiling: the full-width re-read
 * remedy for column-cut lines needs to raise the cap above it. Output stays
 * bounded by `maxBytes` regardless.
 */
export const READ_MAX_LINE_LENGTH_CAP = 1_000_000

/** Wide-line notice: at most this many line numbers are listed before "and N more". */
const MAX_WIDE_NOTICE_LINES = 20

function parsePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Validate value constraints the schema DSL can't express. `maxLimit` is the deployment's line cap.
 * @param args - the schema-validated raw tool arguments; `offset`/`limit` must be positive integers when given,
 *   and `maxLineLength` either 0 (restore the default) or a positive integer within the absolute cap.
 * @param maxLimit - the configured line cap: both the default `limit` and the largest one accepted.
 * @param defaultMaxLineLength - the configured column cap applied when `maxLineLength` is omitted or 0.
 * @returns the validated input with `offset` defaulted to 1, `limit` to `maxLimit`, and `maxLineLength` to `defaultMaxLineLength`.
 */
export function parseReadArgs(
  args: { file_path: string; offset?: number; limit?: number; maxLineLength?: number },
  maxLimit: number,
  defaultMaxLineLength: number,
): ReadInput {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, 'offset')
  const limit = args.limit === undefined ? maxLimit : parsePositiveInteger(args.limit, 'limit')
  if (limit > maxLimit) throw new Error(`limit must be less than or equal to ${maxLimit}`)
  let maxLineLength = defaultMaxLineLength
  if (args.maxLineLength !== undefined && args.maxLineLength !== 0) {
    maxLineLength = parsePositiveInteger(args.maxLineLength, 'maxLineLength')
    if (maxLineLength > READ_MAX_LINE_LENGTH_CAP) {
      throw new Error(`maxLineLength must be less than or equal to ${READ_MAX_LINE_LENGTH_CAP}`)
    }
  }
  return { filePath: args.file_path, offset, limit, maxLineLength }
}

/**
 * Register the `read` tool and its scope-aware system-prompt guidance.
 * @param ctx - the plugin context; registrations are effects scoped to it, and execution uses its `fs` service.
 * @param caps - the deployment's resolved read caps (plugin config after defaulting).
 */
export function applyReadTool(ctx: Context, caps: ReadToolCaps): void {
  ctx.systemPrompt.section({
    name: 'tool:read',
    order: ctx.systemPrompt.getSectionOrder('TOOL_READ'),
    text: ({ scope }) => ctx.tools.get('read', scope) === undefined
      ? ''
      : 'Use the read tool — not shell commands like cat, sed, head, or tail — to inspect text files. Results include line numbers. Use offset and limit to read a line range or continue a large file. Archive paths (foo.zip, foo.zip:dir) list archive members; foo.zip:dir/file reads one member as text. Zstd paths (foo.zst, foo.zstd, session.jsonl.zstd) serve their decoded text; append ?outline=1 to a session log to read its turn outline instead of the transcript.',
  })

  ctx.tools.register(defineTool({
    name: 'read',
    description:
      'Read a UTF-8 text file and return line-numbered content. Archive paths (foo.zip, foo.zip:dir, foo.zip:dir/file) list the archive or read a member as text through a built-in multi-format engine. Zstd paths (foo.zst, foo.zstd, session.jsonl.zstd) serve their decoded plaintext/JSONL through the same line-numbered window; a session log read with a ?outline=1 suffix (e.g. session.jsonl.zstd?outline=1) serves its turn outline instead of the transcript. Reads of a whole small UTF-8 file prefix the content with a hashline anchor header ([path#TAG]) — copy that tag verbatim into the edit tool\'s hashline sections so edits anchor on the exact content you saw. Lines longer than maxLineLength display truncated and are not registered as seen for edits; re-read them with a raised maxLineLength before editing.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${caps.limit}.` },
      maxLineLength: {
        type: 'number',
        description: `Maximum characters returned for a single line; longer lines display with a truncation suffix. Defaults to ${caps.maxLineLength} — raise it (up to ${READ_MAX_LINE_LENGTH_CAP}) to read wide lines in full; 0 restores the default. Applies to regular file reads.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Canonical absolute path in the filesystem execution world.' },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          totalLines: { type: 'integer', required: true },
          notice: { type: 'string', description: 'Optional model-facing footer appended after the file body (e.g. a conflict-resolution notice).' },
          snapshotTag: { type: 'string', description: 'Hashline content-hash tag recorded for this file; when present the rendered text carries a [path#TAG] header.' },
        },
      },
      render: (args, value) => {
        const input = parseReadArgs(args, caps.limit, caps.maxLineLength)
        const endLine = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1)
        const truncatedByBytes = value.lines.length < input.limit && endLine < value.totalLines
        return [{
          type: 'text',
          text: formatReadOutput(value.path, {
            offset: value.offset,
            lines: value.lines,
            totalLines: value.totalLines,
            ...truncatedByBytes ? { truncatedByBytes: true } : {},
            ...value.notice !== undefined ? { notice: value.notice } : {},
            ...value.snapshotTag !== undefined ? { snapshotTag: value.snapshotTag } : {},
          }),
        }]
      },
      // Project the structured window into persisted `meta` so a UI's read card
      // survives replay: the raw canonical output object is not on the wire, only
      // the model-facing text, from which the line/lang data cannot be recovered.
      presentationMeta: (_args, value) => {
        const lang = langFromPath(value.path)
        return {
          path: value.path,
          offset: value.offset,
          lines: value.lines.map(({ number, text }) => ({ number, text })),
          totalLines: value.totalLines,
          ...lang === undefined ? {} : { lang },
        }
      },
    },
    // Observation races fail closed because guarded mutations re-check the version in-lock.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input = parseReadArgs(args, caps.limit, caps.maxLineLength)
      // Internal-URL routing (conflict://, pr://, issue://, …) is opt-in via a
      // mounted `ctx.internalUrls` registry; without one, read stays
      // filesystem-only.
      const iu = ctx.get('internalUrls')
      if (iu !== undefined) {
        const internal = await tryReadInternal(ctx, iu, exec, input, caps)
        if (internal !== undefined) {
          return internal.notice !== undefined ? { ...internal, notice: internal.notice } : internal
        }
      }

      // Zstd routing (`foo.zst`, `foo.zstd`, `session.jsonl.zstd`): serve the
      // decoded JSONL/plaintext window when the file actually carries the zstd
      // magic. Must run before archive routing — the archive sniffer can
      // mis-read zstd bytes as a listing — and falls through for non-zstd data.
      const zstdRead = await tryReadZstd(ctx, exec, input.filePath, caps)
      if (zstdRead !== undefined) {
        return {
          path: zstdRead.displayPath,
          offset: 1,
          lines: zstdRead.lines,
          totalLines: zstdRead.totalLines,
          ...zstdRead.notice !== undefined ? { notice: zstdRead.notice } : {},
        }
      }

      // Archive routing (`foo.zip`, `foo.zip:dir`, `foo.zip:dir/file.txt`):
      // when the path names a real archive, serve member text or a directory
      // listing through the engine instead of failing as a non-text file.
      // Falls through to the regular read when the path isn't an archive.
      const archiveRead = await tryReadArchive(ctx, exec, input.filePath, caps)
      if (archiveRead !== undefined) {
        return {
          path: archiveRead.displayPath,
          offset: 1,
          lines: archiveRead.lines,
          totalLines: archiveRead.totalLines,
        }
      }

      // Native-sidecar routing (`dsh-omp-native`): PDFs and SQLite databases
      // are read through the extracted Rust sidecar (rasterization / table
      // query) when the binary is present. Falls through to the regular read
      // when the sidecar is absent or the path is not PDF/SQLite.
      const nativeRead = await tryReadNative(ctx, exec, input.filePath, caps)
      if (nativeRead !== undefined) {
        return {
          path: nativeRead.displayPath,
          offset: 1,
          lines: nativeRead.lines,
          totalLines: nativeRead.totalLines,
        }
      }

      // One stat: absence observation OR type check + size routing + present version.
      // A concurrent write can only make a later guarded mutation fail stale and require reread.
      const { target, info } = await resolveRegularReadTarget(ctx, exec, input.filePath)

      // Stream when the file is large OR size is unknown, so a size-less backend
      // never buffers an arbitrarily large file.
      let fullText: string | undefined
      const chunks = info.size === undefined || info.size >= caps.streamMinSize
        ? await ctx.fs.streamText(target, exec.signal)
        : [(fullText = await ctx.fs.readText(target, exec.signal))]
      const window = await buildWindow(
        chunks,
        { offset: input.offset, limit: input.limit, maxLineLength: input.maxLineLength, maxBytes: caps.maxBytes },
        target.displayPath,
      )

      // Hashline snapshot: when we hold the whole small UTF-8 file in memory,
      // record it (with the displayed window lines as seen-line origin)
      // into the session's hashline snapshot store and surface its content-hash
      // tag as a [path#TAG] header, so the model anchors a follow-up edit on
      // exactly the content it saw. Windowed/streamed reads never snapshot:
      // the tag hashes the WHOLE normalized file, which a partial read cannot
      // attest to (and an oversized file would evict the session's budget).
      let snapshotTag: string | undefined
      let wideNotice: string | undefined
      if (caps.snapshotTags && fullText !== undefined && info.size !== undefined && info.size < SNAPSHOT_MAX_BYTES) {
        // Normalization mirrors the edit patcher's read convention (BOM-strip,
        // LF), so this tag is byte-identical to the one hashline computes on
        // its own re-read — a copied header validates on the first edit.
        const normalized = normalizeToLF(stripBom(fullText).text)
        if (normalized.length > 0) {
          const sessionKey = (exec.agent?.session as object | undefined)
          // A column-cut row never registers as seen: the model saw a truncated
          // prefix, and treating it as seen would let an edit silently drop the
          // tail (oh-my-pi #15649). Any window that displayed nothing — an
          // all-column-cut window, or one whose every displayable row was
          // dropped by the byte cap — still records seen-state via the
          // non-anchor sentinel (lines are 1-based): an empty seen set means
          // unrestricted (the write-tag fast path), which a read must never
          // mint. A genuinely empty file never reaches record() (its
          // normalized length is 0 and no tag is minted).
          const wide = new Set(window.wideLineNumbers)
          const seenLines = window.lines.map(line => line.number).filter(number => !wide.has(number))
          snapshotTag = getSessionSnapshotStore(sessionKey).record(
            target.displayPath,
            normalized,
            seenLines.length > 0 ? seenLines : [0],
          )
          if (wide.size > 0) {
            // The listed numbers are model-visible text on top of a
            // byte-capped window: bound the list so a tiny per-call column
            // cap cannot push the notice past the output budget.
            const listed = window.wideLineNumbers.slice(0, MAX_WIDE_NOTICE_LINES)
            const more = window.wideLineNumbers.length - listed.length
            wideNotice =
              `Line(s) ${listed.join(', ')}${more > 0 ? ` and ${more} more` : ''} longer than ` +
              `${input.maxLineLength} chars were shown truncated and are not editable until re-read with a ` +
              'higher maxLineLength input.'
          }
        }
      }

      const outcome = {
        path: ctx.fs.processPath(target),
        offset: input.offset,
        lines: window.lines,
        totalLines: window.totalLines,
        ...(snapshotTag === undefined ? {} : { snapshotTag }),
        ...(wideNotice === undefined ? {} : { notice: wideNotice }),
      }
      // Conflict surfacing: register any conflict block inside this read's
      // window with the session history so `write({ path: "conflict://<N>" })`
      // can resolve it, and append the resolution notice to the model text.
      if (iu !== undefined) {
        const notice = conflictNoticeForRead(ctx, iu, exec, target, outcome)
        if (notice !== undefined) {
          // Record the present observation too: the read succeeded and the
          // model now holds a version it can splice against.
          ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
          return { ...outcome, notice: wideNotice === undefined ? notice : `${notice}\n${wideNotice}` }
        }
      }
      // Record the present observation (a no-op when no policy plugin listens). The
      // read already succeeded; an fs/observed listener is contractually a
      // synchronous, side-effect-only recorder.
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return outcome
    },
    // Result-time display: a `read` card carrying the structured line window a
    // capable UI renders as a line-numbered, syntax-highlighted view. The
    // structured data is narrowed from the persisted `meta` (replay-safe); the
    // envelope-stripped model-facing text rides along as `content` so a UI without
    // the read capability still shows the file text. A malformed or absent meta,
    // or a result whose text is not the read envelope, declines to `undefined`
    // (the generic fallback), never throwing on replay of obsolete logged output.
    presentResult(_args, result: ToolResult): ReadResultView | undefined {
      if (result.isError) return undefined
      const meta = readMetaFromMeta(result.meta)
      if (meta === undefined) return undefined
      const only = result.content.length === 1 ? result.content[0] : undefined
      const text = only?.type === 'text' ? only.text : undefined
      if (text === undefined) return undefined
      // Group 1 always captures (possibly empty) when the envelope matches.
      const body = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
      if (body === undefined) return undefined
      return {
        card: 'read',
        path: meta.path,
        offset: meta.offset,
        lines: meta.lines,
        totalLines: meta.totalLines,
        ...meta.lang === undefined ? {} : { lang: meta.lang },
        content: [{ type: 'text', text: body }],
      }
    },
    // Pure display: a generic card titled by the file with the read window appended (`Read
    // foo.txt (5 - 8)`), `read` kind (icon), and a follow-along location whose line is the
    // read's offset (defaulting to 1). The window reflects raw args, so an omitted limit keeps
    // the title bare instead of smuggling config into this pure presenter.
    presentCall(args): GenericCallView {
      const { offset, limit } = args
      const window = limit !== undefined && limit > 0
        ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
        : offset !== undefined ? ` (from line ${offset})` : ''
      return {
        card: 'generic',
        title: `Read ${args.file_path}${window}`,
        kind: 'read',
        locations: [{ path: args.file_path, line: offset ?? 1 }],
      }
    },
  }))
}
