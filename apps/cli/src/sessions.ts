/**
 * `dsh sessions` — inspect and maintain the JSONL session log store.
 *
 * Three actions share one convention: everything is a **preview** unless the
 * destructive switch is given.
 * - `ls`: list every stored session with on-disk size (default table, `--json`
 *   for automation).
 * - `prune --older-than <days>`: preview; `--archive` moves matched sessions
 *   (whole session directories) to `<root>/.trash/<project>/<id>`,
 *   `--delete` removes them. Sessions modified in the last five minutes are
 *   skipped (an active writer owns them).
 * - `recompress [--level N]`: preview; `--exec` rewrites each `.jsonl.zstd`
 *   log into a header frame plus ONE large frame at the given level. The
 *   rewrite is lossless (same plaintext; frame-per-batch semantics preserved
 *   for future appends) and is the migration that reclaims the disk lost to
 *   the per-200ms-batch frame encoding of older releases.
 *
 * The command reads logs through the shared `@deepseek-ai/dsh-zstd-frame`
 * codec and a header-line parse identical to the backend's own, so a log the
 * backend refuses is skipped loudly rather than corrupted.
 * @module @deepseek-ai/dsh/cli/sessions
 */

import { readdir, readFile, stat, rename, rm, mkdir, writeFile } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'
import { homedir } from 'node:os'
import { scanZstdFrames, decompressZstdFrame, compressZstdFrame } from '@deepseek-ai/dsh-zstd-frame'
import type { SessionsInvocation } from './args.ts'

const ZSTD_SUFFIX = '.jsonl.zstd'
const PLAIN_SUFFIX = '.jsonl'
/** Sessions touched within this window are presumed owned by an active writer. */
const ACTIVE_WRITER_WINDOW_MS = 5 * 60 * 1000

interface SessionEntry {
  /** Session id from the stored header. */
  id: string
  /** Header createdAt epoch-ms. */
  createdAt: number
  /** Project cwd recorded in the header, when present. */
  cwd: string | undefined
  /** Parent session id, when the session is a fork. */
  parentSession: string | undefined
  /** Human project directory key (`--Users-hui-...--`). */
  project: string
  /** Artifact path. */
  path: string
  /** Stored artifact bytes. */
  bytes: number
  /** Last mtime epoch-ms (a recent writer?). */
  mtimeMs: number
}

/** Resolve the session store root: `--root`, then `$DSH_HOME/sessions`, then `~/.dsh/sessions`. */
export function resolveSessionsRoot(override: string | undefined): string {
  if (override !== undefined) return override
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** Parse the first JSON line of a session artifact into the minimal header shape the CLI needs. */
function parseHeaderLine(line: string): { id: string; createdAt: number; cwd?: string; parentSession?: string } | undefined {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.type !== 'session' || typeof record.id !== 'string' || typeof record.createdAt !== 'number') return undefined
  return {
    id: record.id,
    createdAt: record.createdAt,
    ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
    ...(typeof record.parentSession === 'string' ? { parentSession: record.parentSession } : {}),
  }
}

/** Read just the header line of one artifact (zstd: first frame; plain: first line). */
export async function readHeader(path: string, zstd: boolean): Promise<ReturnType<typeof parseHeaderLine>> {
  const data = await readFile(path)
  if (!zstd) {
    const newline = data.indexOf(0x0A)
    return parseHeaderLine(data.subarray(0, newline === -1 ? data.length : newline).toString('utf8'))
  }
  const { frames } = scanZstdFrames(data)
  const firstFrame = frames[0]
  if (firstFrame === undefined) return undefined
  const first = data.subarray(firstFrame.start, firstFrame.end)
  const plaintext = await decompressZstdFrame(first)
  const newline = plaintext.indexOf(0x0A)
  return parseHeaderLine(plaintext.subarray(0, newline === -1 ? plaintext.length : newline).toString('utf8'))
}

/** Enumerate every session artifact under the root; skips unreadable entries with the reason. */
export async function listSessions(root: string): Promise<{ entries: SessionEntry[]; skipped: string[] }> {
  const entries: SessionEntry[] = []
  const skipped: string[] = []
  let projects: string[]
  try {
    projects = await readdir(root)
  } catch {
    return { entries, skipped: [`<root> unreadable: ${root}`] }
  }
  for (const project of projects.sort()) {
    // Hidden directories carry tooling state (e.g. `.trash`); never walk them.
    if (project.startsWith('.')) continue
    const projectDir = join(root, project)
    let sessionDirs: string[]
    try {
      const dirStat = await stat(projectDir)
      if (!dirStat.isDirectory()) continue
      sessionDirs = await readdir(projectDir)
    } catch (error) {
      skipped.push(`${project}: ${String(error)}`)
      continue
    }
    for (const sessionDir of sessionDirs.sort()) {
      // Hidden entries (`.DS_Store`, tooling) and plain files are not session dirs.
      if (sessionDir.startsWith('.')) continue
      const dir = join(projectDir, sessionDir)
      try {
        if (!(await stat(dir)).isDirectory()) continue
      } catch {
        continue
      }
      for (const name of [ZSTD_SUFFIX, PLAIN_SUFFIX]) {
        const path = join(dir, `session${name}`)
        try {
          const info = await stat(path)
          if (!info.isFile()) continue
          const header = await readHeader(path, name === ZSTD_SUFFIX)
          if (header === undefined) {
            skipped.push(`${path}: unparsable header`)
            continue
          }
          entries.push({
            id: header.id,
            createdAt: header.createdAt,
            cwd: header.cwd,
            parentSession: header.parentSession,
            project,
            path,
            bytes: info.size,
            mtimeMs: info.mtimeMs,
          })
        } catch (error) {
          // The other representation (or a .trash-only twin) simply does not
          // exist here: that is the normal branch, not a skip.
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue
          skipped.push(`${path}: ${String(error)}`)
        }
        break
      }
    }
  }
  return { entries, skipped }
}

function formatFlags(entry: SessionEntry): string {
  const flags = []
  if (entry.parentSession !== undefined) flags.push('fork')
  if (Date.now() - entry.mtimeMs < ACTIVE_WRITER_WINDOW_MS) flags.push('active')
  return flags.length > 0 ? ` [${flags.join(',')}]` : ''
}

/** `dsh sessions ls`. */
export async function runSessionList(root: string, json: boolean): Promise<number> {
  const { entries, skipped } = await listSessions(root)
  const ordered = [...entries].sort((a, b) => b.createdAt - a.createdAt)
  const total = ordered.reduce((sum, entry) => sum + entry.bytes, 0)
  if (json) {
    process.stdout.write(`${JSON.stringify(ordered.map(entry => ({
      id: entry.id,
      createdAt: entry.createdAt,
      cwd: entry.cwd ?? null,
      parentSession: entry.parentSession ?? null,
      project: entry.project,
      path: entry.path,
      bytes: entry.bytes,
      mtimeMs: entry.mtimeMs,
    })), null, 2)}\n`)
  } else {
    process.stdout.write(`${'created'.padEnd(20)} ${'mb'.padStart(9)}  project / id\n`)
    for (const entry of ordered) {
      process.stdout.write(
        `${new Date(entry.createdAt).toISOString().padEnd(20)} ${(entry.bytes / 1048576).toFixed(2).padStart(9)}  ${entry.project} / ${entry.id}${formatFlags(entry)}\n`,
      )
    }
    process.stdout.write(`\n${entries.length} sessions, ${(total / 1048576).toFixed(1)} MB (${skipped.length} skipped)\n`)
  }
  for (const skip of skipped) process.stderr.write(`dsh sessions: skipped ${skip}\n`)
  return 0
}

/** `dsh sessions prune`: preview, then archive or delete on request. */
export async function runSessionPrune(
  root: string,
  olderThanDays: number,
  archive: boolean,
  delete_: boolean,
): Promise<number> {
  const { entries } = await listSessions(root)
  const threshold = Date.now() - olderThanDays * 24 * 60 * 60 * 1000
  const candidates = entries.filter(entry => entry.createdAt < threshold)
    .filter(entry => Date.now() - entry.mtimeMs >= ACTIVE_WRITER_WINDOW_MS)
  if (!archive && !delete_) {
    process.stdout.write(`preview: ${candidates.length} session(s) older than ${olderThanDays} day(s)\n`)
    for (const entry of candidates) {
      process.stdout.write(`  would remove: ${entry.project} / ${entry.id} (${(entry.bytes / 1048576).toFixed(2)} MB)\n`)
    }
    process.stdout.write('pass --archive (reversible move to <root>/.trash) or --delete to apply.\n')
    return 0
  }
  const trashRoot = join(root, '.trash')
  let done = 0
  for (const entry of candidates) {
    const dir = dirname(entry.path)
    try {
      if (delete_) {
        await rm(dir, { recursive: true, force: true })
      } else {
        const trashDir = join(trashRoot, entry.project, basename(dir))
        await mkdir(trashDir, { recursive: true })
        await rename(dir, trashDir)
      }
      process.stdout.write(`${delete_ ? 'deleted' : 'archived'}: ${entry.project} / ${entry.id} (${(entry.bytes / 1048576).toFixed(2)} MB)\n`)
      done += 1
    } catch (error) {
      process.stderr.write(`dsh sessions: ${delete_ ? 'delete' : 'archive'} failed for ${entry.path}: ${String(error)}\n`)
    }
  }
  process.stdout.write(`${done} of ${candidates.length} applied.\n`)
  return 0
}

/** `dsh sessions recompress`: preview, then rewrite each zstd log into header frame + one big frame. */
export async function runSessionRecompress(root: string, level: number, exec: boolean): Promise<number> {
  const { entries, skipped } = await listSessions(root)
  const candidates = entries.filter(entry => entry.path.endsWith(ZSTD_SUFFIX))
  if (!exec) {
    process.stdout.write(`preview: ${candidates.length} zstd log(s) to rewrite at level ${level} (${(candidates.reduce((s, e) => s + e.bytes, 0) / 1048576).toFixed(1)} MB stored)\n`)
    process.stdout.write('pass --exec to apply; rewrites are lossless and stay readable by the backend.\n')
    return 0
  }
  let done = 0
  for (const entry of candidates) {
    try {
      const before = entry.bytes
      const after = await recompressLog(entry.path, level)
      process.stdout.write(`rewrote ${entry.project} / ${entry.id}: ${(before / 1048576).toFixed(2)} MB -> ${(after / 1048576).toFixed(2)} MB\n`)
      done += 1
    } catch (error) {
      process.stderr.write(`dsh sessions: recompress failed for ${entry.path}: ${String(error)}\n`)
    }
  }
  for (const skip of skipped) process.stderr.write(`dsh sessions: skipped ${skip}\n`)
  process.stdout.write(`${done} of ${candidates.length} rewritten.\n`)
  return 0
}

/**
 * Rewrite one zstd session log: decode and validate every frame, then re-encode
 * as [header frame, one large frame] at `level`. The plaintext (header line +
 * JSONL event lines) is byte-identical to the original, so any reader — this
 * backend or the `zstd` CLI — sees the same log; appends after the rewrite
 * continue as per-batch frames, exactly as before. Written to a temp file and
 * renamed, so a failure leaves the original untouched.
 */
async function recompressLog(path: string, level: number): Promise<number> {
  const data = await readFile(path)
  const { frames, tornStart } = scanZstdFrames(data)
  if (tornStart !== undefined) {
    throw new Error('log has a torn final frame (an interrupted append); finish or repair it before recompressing')
  }
  const chunks: Buffer[] = []
  for (const frame of frames) {
    chunks.push(await decompressZstdFrame(data.subarray(frame.start, frame.end)))
  }
  const plaintext = Buffer.concat(chunks)
  const newline = plaintext.indexOf(0x0A)
  if (newline === -1) throw new Error('log has no header line')
  const headerLine = plaintext.subarray(0, newline + 1)
  const rest = plaintext.subarray(newline + 1)
  // Validate every JSONL record before rewriting: a corrupted source must
  // never be silently re-encoded.
  for (const line of rest.toString('utf8').split('\n')) {
    if (line === '') continue
    JSON.parse(line)
  }
  const headerFrame = await compressZstdFrame(headerLine, { level })
  const eventFrame = rest.length > 0 ? await compressZstdFrame(rest, { level }) : Buffer.alloc(0)
  const encoded = eventFrame.length > 0 ? Buffer.concat([headerFrame, eventFrame]) : headerFrame
  const tmp = `${path}.recompress-${process.pid}.tmp`
  await writeFile(tmp, encoded)
  await rename(tmp, path)
  return encoded.length
}

/** Dispatch one `dsh sessions` invocation and return the process exit code. */
export async function runSessions(invocation: SessionsInvocation): Promise<number> {
  const root = resolveSessionsRoot(invocation.root)
  switch (invocation.action) {
    case 'ls':
      return runSessionList(root, invocation.json === true)
    case 'prune':
      return runSessionPrune(root, invocation.olderThanDays ?? 0, invocation.archive === true, invocation.delete === true)
    case 'recompress':
      return runSessionRecompress(root, invocation.level ?? 19, invocation.exec === true)
  }
}
