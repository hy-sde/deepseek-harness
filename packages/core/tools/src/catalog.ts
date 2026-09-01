/**
 * Catalog mode `dyn` device transport. Under `mode: 'catalog'` the registry
 * projects only eager tools' full schemas; device tools ride a discoverable
 * transport at zero schema slots — `search` lists a bounded one-line catalog,
 * `docs` returns one device's full schema, `invoke` routes a call through the
 * guarded pipeline as a nested transport dispatch.
 * @module @deepseek-ai/dsh-tools/src/catalog
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { FIRST_PARTY_SECTION_ORDER } from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from './schema.ts'
import type { ToolDefinition, ToolExecutionResult, ToolRunContext } from './index.ts'

/** The model-facing name of the catalog mode device transport. */
export const DYN_NAME = 'dyn'

/** Prompt order of the `tools:catalog` section, before any single-tool guidance. */
export const CATALOG_SECTION_ORDER = FIRST_PARTY_SECTION_ORDER.CATALOG_ONLY

/** UTF-8 byte cap for a device's one-line catalog summary. */
export const DEVICE_SUMMARY_CAP = 200

/** Maximum catalog rows returned by one `search` when `limit` is omitted. */
export const CATALOG_SEARCH_LIMIT = 50

/** Stable model-facing guidance for the live dynamic-device transport. */
export const CATALOG_GUIDANCE = `\`${DYN_NAME}\` is the only direct route to device tools under catalog mode. Use \`search\` to discover them, \`docs\` for the exact schema and guidance of one device, and \`invoke\` with that schema to call it. Retry an empty or narrow search with different terms; absent devices are unavailable and MUST NOT be advertised or guessed. Eager tools (those with full schemas in this prompt) stay callable directly.`

/** One bounded catalog row: the device name plus its capped one-line summary. */
export interface CatalogEntry {
  readonly name: string
  readonly summary: string
}

/** The three operations accepted by the stable `dyn` schema. */
export type CatalogOp = 'search' | 'docs' | 'invoke'

/** Registry-private capabilities the transport receives at construction. */
export interface DynBridgeOptions {
  /** Render one bounded catalog row per currently visible device tool, in stable order. */
  entries(agent: Agent | undefined): readonly CatalogEntry[]
  /** Render full docs + JSON schema for one device; undefined when absent or not a device. */
  docsFor(name: string, agent: Agent | undefined): string | undefined
  /** Run a device through the guarded pipeline as a nested transport dispatch. */
  invoke(name: string, args: JsonValue, exec: ToolRunContext): Promise<ToolExecutionResult>
}

/** The canonical value returned by the `dyn` transport, op-tagged for the model. */
export type DynOutput =
  | { op: 'search'; total: number; entries: CatalogEntry[]; truncated: boolean }
  | { op: 'docs'; name: string; docs: string }
  | { op: 'invoke'; name: string; isError: true; content: string; error: string }
  | { op: 'invoke'; name: string; isError: false; content: string; result: JsonValue }

/** Bound an external one-line summary to {@link DEVICE_SUMMARY_CAP} UTF-8 bytes. */
/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes on a character boundary.
 * @param text - the text to bound; returned whole when it already fits.
 * @param maxBytes - the UTF-8 byte ceiling.
 * @returns the bounded text.
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) return text
  let result = ''
  for (const char of text) {
    if (encoder.encode(result + char).length > maxBytes) break
    result += char
  }
  return result
}

/**
 * A device's bounded one-line catalog summary: its description's first line,
 * else its name, capped at {@link DEVICE_SUMMARY_CAP} UTF-8 bytes. First-party
 * devices are expected to keep the line short for exactly this renderer.
 * @param definition - the device's name and full description.
 * @returns the device's one-line catalog row.
 */
export function catalogSummary(definition: { name: string; description: string }): string {
  const firstLine = definition.description.split('\n')[0]?.trim() ?? ''
  const summary = firstLine.length > 0 ? firstLine : definition.name
  return truncateUtf8(summary, DEVICE_SUMMARY_CAP)
}

/** Join one execution result's content blocks into the plain text the model reads. */
function resultText(content: readonly ContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === 'text') return block.text
      /* v8 ignore next -- first-party transports emit text; keep others lossless-visible. */
      return JSON.stringify(block)
    })
    .join('\n')
}

/**
 * Build the `dyn` {@link ToolDefinition}: `search` / `docs` / `invoke` over the
 * registry's device tools. The registry reserves it as presentation
 * infrastructure under `mode: 'catalog'`, outside the filterable global/scoped
 * capability layers.
 * @param options - the registry-private capabilities described above.
 * @returns the registry-ready definition.
 */
export function createDynTool(options: DynBridgeOptions): ToolDefinition {
  const { entries, docsFor, invoke } = options
  return defineTool({
    name: DYN_NAME,
    description: CATALOG_GUIDANCE,
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['search', 'docs', 'invoke'],
        description: 'Which operation to run: `search` discovers devices, `docs` fetches one device\'s schema, `invoke` calls one device.',
      },
      text: {
        type: 'string',
        description: 'search: case-insensitive text matched against device names and summaries.',
      },
      offset: {
        type: 'number',
        description: 'search: number of matched catalog rows to skip (default 0).',
      },
      limit: {
        type: 'number',
        description: 'search: maximum rows to return (default 50).',
      },
      name: {
        type: 'string',
        description: 'docs/invoke: the device name, exactly as `search` lists it.',
      },
      args: {
        type: 'json',
        description: 'invoke: the lossless-JSON arguments object the device\'s schema declares.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', required: true },
          total: { type: 'number' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                summary: { type: 'string', required: true },
              },
            },
          },
          truncated: { type: 'boolean' },
          name: { type: 'string' },
          docs: { type: 'string' },
          isError: { type: 'boolean' },
          content: { type: 'string' },
          error: { type: 'string' },
          result: { type: 'json' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDynOutput(value as DynOutput) }],
    },
    async execute(args, exec): Promise<DynOutput> {
      switch (args.op) {
        case 'search': {
          const all = entries(exec.agent)
          const needle = (args.text ?? '').toLowerCase()
          const matched = needle.length > 0
            ? all.filter(entry => entry.name.toLowerCase().includes(needle) || entry.summary.toLowerCase().includes(needle))
            : all
          const offset = args.offset ?? 0
          const limit = args.limit ?? CATALOG_SEARCH_LIMIT
          const rows = matched.slice(offset, offset + limit)
          return {
            op: 'search',
            total: matched.length,
            entries: rows,
            truncated: offset + rows.length < matched.length,
          }
        }
        case 'docs': {
          if (args.name === undefined || typeof args.name !== 'string') {
            throw new Error('dyn docs requires a `name`')
          }
          const docs = docsFor(args.name, exec.agent)
          if (docs === undefined) {
            throw unknownDeviceError(args.name, entries(exec.agent))
          }
          return { op: 'docs', name: args.name, docs }
        }
        case 'invoke': {
          if (args.name === undefined || typeof args.name !== 'string') {
            throw new Error('dyn invoke requires a `name`')
          }
          const result = await invoke(args.name, args.args ?? {}, exec)
          if (result.isError) {
            return {
              op: 'invoke',
              name: args.name,
              isError: true,
              content: resultText(result.content),
              error: result.error.message,
            }
          }
          return {
            op: 'invoke',
            name: args.name,
            isError: false,
            content: resultText(result.content),
            result: result.value,
          }
        }
      }
    },
  })
}

/** The wrong-device failure, hinting at the live catalog when it is non-empty. */
function unknownDeviceError(name: string, known: readonly CatalogEntry[]): Error {
  const mounted = known.length > 0
    ? ` Mounted devices: ${known.map(entry => entry.name).join(', ')}`
    : ' No devices are mounted.'
  return new Error(`no such device "${name}".${mounted}`)
}

/** Present one `dyn` outcome as the model-facing text. */
function renderDynOutput(value: DynOutput): string {
  switch (value.op) {
    case 'search': {
      if (value.entries.length === 0) return `No devices match. (${value.total} total before filtering)`
      const lines = value.entries.map(entry => `- ${entry.name} — ${entry.summary}`)
      return [
        `${value.total} device${value.total === 1 ? '' : 's'} (showing ${lines.length}):`,
        ...lines,
        value.truncated ? `(${value.total - value.entries.length} more — run dyn search again with an offset)` : '',
      ].filter(line => line.length > 0).join('\n')
    }
    case 'docs':
      return value.docs
    case 'invoke':
      return value.isError
        ? `${value.name} failed: ${value.error}`
        : value.content
  }
}
