/**
 * Diary extension: the `logseq_diary_ingest` model tool and the `/diary`
 * slash command, ported from the oh-my-pi extension of the same purpose.
 * Ingests diary text into the Life Logs page under year -> month -> day,
 * linking every mentioned restaurant/place/person to an existing page or
 * creating a new one.
 * @module @deepseek-ai/dsh-logseq-example/diary
 */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferArgs, type InferValue } from '@deepseek-ai/dsh-tools'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import {
  appendDayLines,
  ensureHierarchy,
  parseCommandDate,
  parseDate,
  runLogseq,
  todayString,
} from './logseq.ts'

/** One mention's display name and the page title it resolves to. */
interface Mention {
  name: string
  canonical: string
}

/** Canonical result of one diary ingestion. */
export interface DiaryValue {
  ok: boolean
  ingestedDate: string
  page: string
  year: string
  month: string
  day: string
  created: string[]
  existing: string[]
  error?: string
}

/** Escape a literal string for use inside a regular expression. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rewrite mention names in a line into `[[canonical]]` links, longest name
 * first so "St. Louis Bread" is not partially rewritten by "Bread".
 * @param line - the line to linkify.
 * @param mentions - resolved mentions to rewrite.
 * @returns the linked line.
 */
function linkify(line: string, mentions: Mention[]): string {
  let out = line
  for (const m of [...mentions].sort((a, b) => b.name.length - a.name.length)) {
    out = out.replace(new RegExp(escapeRegex(m.name), 'gi'), `[[${m.canonical}]]`)
  }
  return out
}

/**
 * Classify each raw mention against the graph: an existing page with an
 * exact-titled match is linked reusing its canonical title, otherwise a new
 * page is created by the ingest. Deduplicated case-insensitively and ignores
 * names shorter than two characters.
 * @param graph - the graph name to search.
 * @param mentions - raw mention names extracted by the model from the diary text.
 * @returns the resolved mentions plus created and linked page lists.
 */
async function resolveMentions(
  graph: string,
  mentions: string[],
): Promise<{ resolved: Mention[]; created: string[]; existing: string[] }> {
  const existing: string[] = []
  const created: string[] = []
  const resolved: Mention[] = []
  const seen = new Set<string>()
  for (const raw of mentions) {
    const name = raw.trim()
    const key = name.toLowerCase()
    if (name.length < 2 || seen.has(key)) continue
    seen.add(key)
    const res = await runLogseq(['search', 'page', '--graph', graph, '--content', name])
    let canonical = name
    if (res.ok) {
      const items = res.data.data?.items ?? []
      const hit = items.find((it) => {
        const title = it['block/title']
        return typeof title === 'string' && title.toLowerCase() === key
      })
      if (hit && typeof hit['block/title'] === 'string') {
        canonical = hit['block/title']
        existing.push(canonical)
      } else {
        created.push(name)
      }
    } else {
      created.push(name)
    }
    resolved.push({ name, canonical })
  }
  return { resolved, created, existing }
}

const DIARY_PARAMETERS = {
  date: { type: 'string', required: true, description: 'Entry date in YYYY-MM-DD' },
  diaryText: {
    type: 'string',
    required: true,
    description: 'The diary text to store (lines become child blocks of the day)',
  },
  mentions: {
    type: 'array',
    items: { type: 'string' },
    description: 'Restaurant/place/person names mentioned in the diary text; extract them yourself',
  },
  page: { type: 'string', description: 'LogSeq page to append into' },
  graph: { type: 'string', description: 'Graph name from `logseq graph list`' },
} as const

type DiaryArgs = InferArgs<typeof DIARY_PARAMETERS>

// The diary and work-log output schemas share their first six fields by
// design — the two tools are deliberately parallel. jscpd:ignore-start
/* jscpd:ignore-start */
const DIARY_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    ingestedDate: { type: 'string', required: true },
    page: { type: 'string', required: true },
    year: { type: 'string', required: true },
    month: { type: 'string', required: true },
    day: { type: 'string', required: true },
    created: { type: 'array', items: { type: 'string' }, required: true },
    existing: { type: 'array', items: { type: 'string' }, required: true },
    error: { type: 'string' },
  },
} as const
/* jscpd:ignore-end */

type DiaryOutput = InferValue<typeof DIARY_OUTPUT>

/** Render the canonical diary value into the model-facing message. */
function renderDiary(_args: DiaryArgs, value: DiaryOutput): ContentBlock[] {
  const message = !value.ok
    ? value.error ?? `Could not append ${value.ingestedDate} in ${value.page}.`
    : `Ingested ${value.ingestedDate} into ${value.page} (${value.year}/${value.month}/${value.day}). `
      + `Created pages: ${value.created.join(', ') || 'none'}. `
      + `Linked existing: ${value.existing.join(', ') || 'none'}.`
  return [{ type: 'text', text: message }]
}

/**
 * Register the diary ingest tool on the given context.
 * @param ctx - registrant context carrying the tool registry.
 */
export function registerDiaryTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'logseq_diary_ingest',
    description:
      'Append a diary entry to the Life Logs page in LogSeq under the year -> month -> day structure, '
      + 'linking any mentioned restaurants/places/persons: each mention is searched in the graph first '
      + 'and linked to the existing page when present, or a new page is created when it does not exist. '
      + 'Returns the ingested date plus created and linked page lists.',
    parameters: DIARY_PARAMETERS,
    output: { schema: DIARY_OUTPUT, render: renderDiary },
    async execute(args, exec) {
      const mentions = args.mentions ?? []
      const page = args.page ?? 'Life Logs'
      const graph = args.graph ?? 'logseq'
      const parsed = parseDate(args.date)
      if (!parsed) {
        const error = `Invalid date "${args.date}" (expected YYYY-MM-DD)`
        return { ok: false, ingestedDate: args.date, page, year: '', month: '', day: '', created: [], existing: [], error }
      }
      const { resolved, created, existing } = await resolveMentions(graph, mentions)

      // Ensure page and year -> month -> day hierarchy exist.
      const hierarchy = await ensureHierarchy(graph, page, parsed)
      if (!hierarchy.ok) {
        return {
          ok: false,
          ingestedDate: args.date,
          page,
          year: parsed.year,
          month: parsed.month,
          day: parsed.day,
          created,
          existing,
          error: hierarchy.error,
        }
      }

      // Link mentions, split into lines, and append only lines not already present.
      const lines = args.diaryText
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => linkify(line, resolved))
      const appendError = await appendDayLines(graph, hierarchy.dayId, lines, exec.signal)
      if (appendError !== null) {
        return {
          ok: false,
          ingestedDate: args.date,
          page,
          year: parsed.year,
          month: parsed.month,
          day: parsed.day,
          created,
          existing,
          error: appendError,
        }
      }

      return {
        ok: true,
        ingestedDate: args.date,
        page,
        year: parsed.year,
        month: parsed.month,
        day: parsed.day,
        created,
        existing,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'LogSeq diary ingest', kind: 'other', rawInput: args.diaryText }),
    timeoutMs: 60_000,
  }))
}

/**
 * Register the `/diary` command on the given context.
 * @param ctx - registrant context carrying the command registry.
 */
export function registerDiaryCommand(ctx: Context): void {
  ctx.commands.register({
    name: 'diary',
    description: 'Log a diary entry to LogSeq. Usage: /diary <text> (optionally /diary YYYY-MM-DD <text>)',
    input: { hint: '<text>' },
    handler: ({ agent, rawInput }): CommandResult => {
      const { date, rest } = parseCommandDate(rawInput)
      const text = rest.trim()
      if (!text) {
        return { kind: 'error', text: 'No diary text provided — /diary <text> or /diary YYYY-MM-DD <text>' }
      }
      const prompt =
        'Log this diary entry to LogSeq with the logseq_diary_ingest tool. '
        + `date=${date ?? todayString()}; `
        + 'page="Life Logs"; graph="logseq". '
        + 'Read the diary text, extract any restaurant/place/person names mentioned, and pass them as exact strings in mentions. '
        + 'Then report the ingested date and the created vs linked pages.\n\n'
        + `Diary text:\n${text}`
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      return { kind: 'success', text: 'Diary queued for LogSeq ingest' }
    },
  })
}
