/**
 * logseq-cli runner and shared LogSeq helpers for the diary and work-log
 * extensions. The graph is reached exclusively through the `logseq` CLI in
 * JSON mode, exactly like the ported oh-my-pi extensions.
 * @module @deepseek-ai/dsh-logseq-example/logseq
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** The `data` payload of a successful `logseq -o json` response. */
export interface LogseqData {
  result?: unknown
  items?: Array<Record<string, unknown>>
}

/** The `logseq -o json` response envelope. */
export interface LogseqResponse {
  status: string
  data?: LogseqData
}

/** Discriminated outcome of one `logseq` invocation. */
export type CliResult =
  | { ok: true; data: LogseqResponse }
  | { ok: false; error: string }

/**
 * Run one `logseq` command with JSON output, resolving to the parsed envelope.
 * A non-zero exit or an unparseable stdout resolves to `{ ok: false, error }`,
 * so callers reason about CLI failures as data rather than exceptions.
 * @param args - the command path plus options (the trailing `-o json` is added here).
 * @param signal - optional caller cancellation forwarded to the child process.
 * @returns the parsed response or the captured failure text.
 */
export async function runLogseq(args: string[], signal?: AbortSignal): Promise<CliResult> {
  try {
    const { stdout } = await execFileAsync('logseq', [...args, '-o', 'json'], { signal })
    return { ok: true, data: JSON.parse(stdout) as LogseqResponse }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** JSON double-quoted strings are valid EDN strings. */
export function ednString(value: string): string {
  return JSON.stringify(value)
}

/**
 * Parse a `YYYY-MM-DD` date into unpadded year/month/day titles, matching the
 * numeric month/day block titles Life Logs and Work logs use ("8", "31").
 * @param date - the entry date to parse.
 * @returns the split parts, or null when the input is not a strict date.
 */
export function parseDate(date: string): { year: string; month: string; day: string } | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date.trim())
  if (!match) return null
  const year = match[1]
  const month = match[2]
  const day = match[3]
  if (year === undefined || month === undefined || day === undefined) return null
  return { year, month: String(Number(month)), day: String(Number(day)) }
}

/**
 * Narrow a CLI `result` field into an array of tuples, keeping only rows that
 * are themselves arrays. The JSON boundary is `unknown`, so this typed
 * projection (rather than raw indexing of an `any[]`) is what the query
 * helpers read from.
 * @param result - the raw `data.result` from a `logseq` JSON response.
 * @returns the array-of-arrays rows.
 */
function asRows(result: unknown): unknown[][] {
  if (!Array.isArray(result)) return []
  return result.filter((row): row is unknown[] => Array.isArray(row))
}

/**
 * Run a Datascript query that returns one numeric id in its first row.
 * @param graph - the graph name to query.
 * @param query - the Datascript query text.
 * @param inputs - the JSON-encoded query inputs vector.
 * @returns the first result column, or null when absent or not numeric.
 */
async function queryBlockId(graph: string, query: string, inputs: string): Promise<number | null> {
  const res = await runLogseq(['query', '--graph', graph, '--query', query, '--inputs', inputs])
  if (!res.ok) return null
  const rows = asRows(res.data.data?.result)
  const first = rows[0]
  if (first === undefined || typeof first[0] !== 'number') return null
  return first[0]
}

/**
 * Find the child block id of a parent block with an exact title, or null.
 * @param graph - the graph name to query.
 * @param parentId - the parent block's numeric id.
 * @param title - the exact child block title to look up.
 * @returns the first matching block id, or null when absent.
 */
export async function findBlockId(graph: string, parentId: number, title: string): Promise<number | null> {
  const query = '[:find ?c :in $ ?p ?t :where [?c :block/parent ?p] [?c :block/title ?t]]'
  return queryBlockId(graph, query, JSON.stringify([parentId, title]))
}

/**
 * Find the block id of a page whose title equals `page`, or null.
 * @param graph - the graph name to query.
 * @param page - the exact page title to look up.
 * @returns the page's block id, or null when absent.
 */
export async function findPageId(graph: string, page: string): Promise<number | null> {
  const query = '[:find ?p :in $ ?t :where [?p :block/title ?t]]'
  return queryBlockId(graph, query, JSON.stringify([page]))
}

/**
 * List the child block titles of one block.
 * @param graph - the graph name to query.
 * @param parentId - the parent block's numeric id.
 * @returns the children's titles; empty on CLI failure.
 */
export async function listChildTitles(graph: string, parentId: number): Promise<string[]> {
  const query = '[:find ?t :in $ ?p :where [?c :block/parent ?p] [?c :block/title ?t]]'
  const inputs = JSON.stringify([parentId])
  const res = await runLogseq(['query', '--graph', graph, '--query', query, '--inputs', inputs])
  if (!res.ok) return []
  return asRows(res.data.data?.result).map((row) => {
    const value = row[0]
    return typeof value === 'string' ? value : ''
  })
}

/**
 * Split an optional leading `YYYY-MM-DD` off a slash command's raw input;
 * the rest is the user's text (or the raw input when no date precedes it).
 * @param text - the command's `rawInput`.
 * @returns the optional date and the remaining text.
 */
export function parseCommandDate(text: string): { date?: string; rest: string } {
  const match = /^(\d{4}-\d{1,2}-\d{1,2})\s+([\s\S]*)$/.exec(text.trim())
  if (match === null) return { rest: text }
  const date = match[1]
  const rest = match[2] ?? ''
  if (date === undefined) return { rest }
  return { date, rest }
}

/**
 * Format a date as `YYYY-MM-DD`.
 * @param now - the instant to format; defaults to the current local time.
 * @returns the zero-padded local date string.
 */
export function todayString(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * Append lines as child blocks of a day block, skipping any line whose title
 * already exists under the day. The deduplication makes an ingest idempotent
 * for both fresh and existing days.
 * @param graph - the graph name to write into.
 * @param dayId - the day block's numeric id.
 * @param lines - the lines to append, already normalized and linked.
 * @param signal - optional caller cancellation forwarded to the child processes.
 * @returns the failure text of the first failing append, or null on success.
 */
export async function appendDayLines(
  graph: string,
  dayId: number,
  lines: string[],
  signal?: AbortSignal,
): Promise<string | null> {
  const existingLines = new Set((await listChildTitles(graph, dayId)).map(title => title.trim()))
  for (const line of lines) {
    if (existingLines.has(line)) continue
    const res = await runLogseq(['upsert', 'block', '--graph', graph, '--target-id', String(dayId), '--pos', 'last-child', '--content', line], signal)
    if (!res.ok) return res.error
    existingLines.add(line)
  }
  return null
}

/**
 * Resolve the year -> month -> day hierarchy under a page, creating every
 * missing level as the last child of its parent. The page must already exist.
 * @param graph - the graph name.
 * @param page - the page title that already exists.
 * @param parse - the parsed date parts.
 * @returns the resolved day block id and its ancestry, or the failure reason.
 */
export async function ensureHierarchy(
  graph: string,
  page: string,
  parse: { year: string; month: string; day: string },
): Promise<{ ok: true; dayId: number; year: string; month: string; day: string } | { ok: false; error: string }> {
  let pageId = await findPageId(graph, page)
  if (pageId === null) {
    const made = await runLogseq(['upsert', 'page', '--graph', graph, '--page', page])
    if (!made.ok) return { ok: false, error: made.error }
    pageId = await findPageId(graph, page)
    if (pageId === null) return { ok: false, error: `Could not create page "${page}"` }
  }
  let yearId = await findBlockId(graph, pageId, parse.year)
  if (yearId === null) {
    const made = await runLogseq(['upsert', 'block', '--graph', graph, '--target-page', page, '--pos', 'last-child', '--content', parse.year])
    if (!made.ok) return { ok: false, error: made.error }
    yearId = await findBlockId(graph, pageId, parse.year)
    if (yearId === null) return { ok: false, error: `Could not create year block ${parse.year} in ${page}` }
  }
  let monthId = await findBlockId(graph, yearId, parse.month)
  if (monthId === null) {
    const made = await runLogseq(['upsert', 'block', '--graph', graph, '--target-id', String(yearId), '--pos', 'last-child', '--content', parse.month])
    if (!made.ok) return { ok: false, error: made.error }
    monthId = await findBlockId(graph, yearId, parse.month)
    if (monthId === null) return { ok: false, error: `Could not create month block ${parse.month} in ${parse.year}` }
  }
  let dayId = await findBlockId(graph, monthId, parse.day)
  if (dayId === null) {
    const made = await runLogseq(['upsert', 'block', '--graph', graph, '--target-id', String(monthId), '--pos', 'last-child', '--content', parse.day])
    if (!made.ok) return { ok: false, error: made.error }
    dayId = await findBlockId(graph, monthId, parse.day)
    if (dayId === null) return { ok: false, error: `Could not create day block ${parse.day}` }
  }
  return { ok: true, dayId, ...parse }
}
