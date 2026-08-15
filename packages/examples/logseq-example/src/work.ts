/**
 * Work-log extension: the `logseq_work_log_ingest` model tool and the
 * `/diary-work` slash command, ported from the oh-my-pi extension of the
 * same purpose. Ingests work-log text into the Work logs page under the
 * year -> month -> day structure, storing each line as-is without linking.
 * @module @deepseek-ai/dsh-logseq-example/work
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
  todayString,
} from './logseq.ts'

/** Canonical result of one work-log ingestion. */
export interface WorkValue {
  ok: boolean
  ingestedDate: string
  page: string
  year: string
  month: string
  day: string
  error?: string
}

const WORK_PARAMETERS = {
  date: { type: 'string', required: true, description: 'Entry date in YYYY-MM-DD' },
  logText: {
    type: 'string',
    required: true,
    description: 'The work log text to store (lines become child blocks of the day)',
  },
  page: { type: 'string', description: 'LogSeq page to append into' },
  graph: { type: 'string', description: 'Graph name from `logseq graph list`' },
} as const

type WorkArgs = InferArgs<typeof WORK_PARAMETERS>

// The diary and work-log output schemas share their first six fields by
// design — the two tools are deliberately parallel. jscpd:ignore-start
/* jscpd:ignore-start */
const WORK_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    ingestedDate: { type: 'string', required: true },
    page: { type: 'string', required: true },
    year: { type: 'string', required: true },
    month: { type: 'string', required: true },
    day: { type: 'string', required: true },
    error: { type: 'string' },
  },
} as const
/* jscpd:ignore-end */

type WorkOutput = InferValue<typeof WORK_OUTPUT>

/** Render the canonical work-log value into the model-facing message. */
function renderWork(_args: WorkArgs, value: WorkOutput): ContentBlock[] {
  const message = !value.ok
    ? value.error ?? `Could not append ${value.ingestedDate} in ${value.page}.`
    : `Ingested ${value.ingestedDate} into ${value.page} (${value.year}/${value.month}/${value.day}).`
  return [{ type: 'text', text: message }]
}

/**
 * Register the work-log ingest tool on the given context.
 * @param ctx - registrant context carrying the tool registry.
 */
export function registerWorkTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'logseq_work_log_ingest',
    description:
      'Append a work log entry to the Work logs page in LogSeq under the year -> month -> day '
      + 'structure, storing the text as-is (no mention extraction or linking). '
      + 'Returns the ingested date.',
    parameters: WORK_PARAMETERS,
    output: { schema: WORK_OUTPUT, render: renderWork },
    async execute(args, exec) {
      const page = args.page ?? 'Work logs'
      const graph = args.graph ?? 'logseq'
      const parsed = parseDate(args.date)
      if (!parsed) {
        const error = `Invalid date "${args.date}" (expected YYYY-MM-DD)`
        return { ok: false, ingestedDate: args.date, page, year: '', month: '', day: '', error }
      }
      const hierarchy = await ensureHierarchy(graph, page, parsed)
      if (!hierarchy.ok) {
        return {
          ok: false,
          ingestedDate: args.date,
          page,
          year: parsed.year,
          month: parsed.month,
          day: parsed.day,
          error: hierarchy.error,
        }
      }

      // Append only lines not already present under the day.
      const lines = args.logText
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
      const appendError = await appendDayLines(graph, hierarchy.dayId, lines, exec.signal)
      if (appendError !== null) {
        return {
          ok: false,
          ingestedDate: args.date,
          page,
          year: parsed.year,
          month: parsed.month,
          day: parsed.day,
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
      }
    },
    presentCall: args => ({ card: 'generic', title: 'LogSeq work-log ingest', kind: 'other', rawInput: args.logText }),
    timeoutMs: 60_000,
  }))
}

/**
 * Register the `/diary-work` command on the given context.
 * @param ctx - registrant context carrying the command registry.
 */
export function registerWorkCommand(ctx: Context): void {
  ctx.commands.register({
    name: 'diary-work',
    description: 'Log a work log entry to LogSeq. Usage: /diary-work <text> (optionally /diary-work YYYY-MM-DD <text>)',
    input: { hint: '<text>' },
    handler: ({ agent, rawInput }): CommandResult => {
      const { date, rest } = parseCommandDate(rawInput)
      const text = rest.trim()
      if (!text) {
        return { kind: 'error', text: 'No work log text provided — /diary-work <text> or /diary-work YYYY-MM-DD <text>' }
      }
      const prompt =
        'Log this work log entry to LogSeq with the logseq_work_log_ingest tool. '
        + `date=${date ?? todayString()}; `
        + 'page="Work logs"; graph="logseq". '
        + 'Do not extract or link any mentions — store the text as-is. '
        + 'Then report the ingested date.\n\n'
        + `Work log text:\n${text}`
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      return { kind: 'success', text: 'Work log queued for LogSeq ingest' }
    },
  })
}
