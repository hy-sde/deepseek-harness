/**
 * Model-facing `lsp` tool over `ctx.lsp`. One read-only tool with four operations
 * (`goToDefinition`/`findReferences`/`goToImplementation`/`hover`); it converts one-based UTF-16
 * cursor coordinates to the seam's zero-based positions, requires the session workspace with no
 * fallback, caps and renders results, and attaches a configurable timeout budget for
 * `dsh-tool-call-timeout-policy` to enforce. It runtime-injects only `tools`, `lsp`, and `systemPrompt` and
 * imports no provider.
 *
 * Namespace plugin (named exports, no default export).
 * @module @deepseek-ai/dsh-tool-lsp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { LspError } from '@deepseek-ai/dsh-lsp'
import type {} from '@deepseek-ai/dsh-lsp'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  DEFAULT_MAX_LOCATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatCodeActions,
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatLocations,
  formatRename,
  LSP_OPERATIONS,
  parseLspArgs,
  presentLspCall,
} from './render.ts'
import type { LspToolArgs } from './render.ts'
import { sessionCwd } from './session-cwd.ts'

export {
  DEFAULT_MAX_LOCATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatCodeActions,
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatLocations,
  formatRename,
  LSP_OPERATIONS,
  parseLspArgs,
  presentLspCall,
  renderUri,
} from './render.ts'
export { sessionCwd } from './session-cwd.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-lsp'

/** Services required by this plugin. */
export const inject = ['tools', 'lsp', 'systemPrompt']

/** Default tool-call timeout budget (ms), covering the queued open/query/close lifecycle. */
export const DEFAULT_LSP_TOOL_TIMEOUT_MS = 60_000

/** The stable system-prompt guidance positioning LSP as a precision aid. */
export const LSP_PROMPT_TEXT =
  'Use search/read for ordinary navigation. Use lsp when textual matches are ambiguous or before a change requires precise definitions, implementations, references, or symbol structure. Positions are one-based line and character (UTF-16) at the cursor; an off-symbol position may return no results. findReferences always includes the declaration. documentSymbols and diagnostics use the file only (pass 1 1 for line/character). rename requires new_name and returns a preview of every edit the server would make (it never writes files).'

/** Plugin configuration: result caps and the timeout budget. */
export interface Config {
  /** Largest number of rendered locations before an omission marker (default 100). */
  maxLocations?: number
  /** Largest complete rendered result in characters, including truncation metadata (default 16000). */
  maxResultChars?: number
  /** Tool-call timeout budget in ms (default 60000). */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  maxLocations: z.number().default(DEFAULT_MAX_LOCATIONS),
  maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_LSP_TOOL_TIMEOUT_MS),
})

type ResolvedConfig = Required<Config>

const LSP_POSITION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    line: { type: 'integer', required: true },
    character: { type: 'integer', required: true },
  },
} as const

const LSP_RANGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    start: { ...LSP_POSITION_OUTPUT_SCHEMA, required: true },
    end: { ...LSP_POSITION_OUTPUT_SCHEMA, required: true },
  },
} as const

/**
 * Register the `lsp` tool and its system-prompt guidance.
 * @param ctx - the plugin context (must inject `tools`, `lsp`, `systemPrompt`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxLocations', resolved.maxLocations)
  assertPositiveInteger('maxResultChars', resolved.maxResultChars)
  assertTimer('timeoutMs', resolved.timeoutMs)

  ctx.systemPrompt.section({
    name: 'tool:lsp',
    order: ctx.systemPrompt.getSectionOrder('TOOL_LSP'),
    text: LSP_PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'lsp',
    device: true,
    description:
      'Query a language server for precise code navigation. operation is one of goToDefinition, findReferences, goToImplementation, goToTypeDefinition, hover, documentSymbols, codeActions, rename, diagnostics. line and character are one-based UTF-16 cursor coordinates; pass 1 1 for documentSymbols and diagnostics, which use only the file. findReferences includes the declaration; codeActions lists available quick fixes/refactorings (never applies them); rename previews every edit for new_name (never writes files).',
    parameters: {
      operation: {
        type: 'string',
        required: true,
        enum: [...LSP_OPERATIONS],
        description: 'goToDefinition, findReferences, goToImplementation, goToTypeDefinition, hover, documentSymbols, codeActions, rename, or diagnostics.',
      },
      file_path: { type: 'string', required: true, description: 'The source file to query, relative to the workspace or absolute.' },
      line: { type: 'number', required: true, description: 'One-based line of the cursor (pass 1 for documentSymbols / diagnostics).' },
      character: { type: 'number', required: true, description: 'One-based UTF-16 column of the cursor (pass 1 for documentSymbols / diagnostics).' },
      new_name: { type: 'string', description: 'The new symbol name for rename; required by rename, ignored by others.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'locations' },
              locations: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    uri: { type: 'string', required: true },
                    range: { ...LSP_RANGE_OUTPUT_SCHEMA, required: true },
                  },
                },
              },
              resolvedWorkspaceUri: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'hover' },
              hover: {
                required: true,
                oneOf: [
                  { type: 'null' },
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      contents: { type: 'string', required: true },
                      range: LSP_RANGE_OUTPUT_SCHEMA,
                    },
                  },
                ],
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'documentSymbols' },
              symbols: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true },
                    kind: { type: 'number', required: true },
                    range: { ...LSP_RANGE_OUTPUT_SCHEMA, required: true },
                    selectionRange: { ...LSP_RANGE_OUTPUT_SCHEMA, required: true },
                    depth: { type: 'number', required: true },
                    detail: { type: 'string' },
                  },
                },
              },
              resolvedWorkspaceUri: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'codeActions' },
              actions: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string', required: true },
                    kind: { type: 'string' },
                    isPreferred: { type: 'boolean' },
                    diagnostics: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          range: { ...LSP_RANGE_OUTPUT_SCHEMA, required: true },
                          severity: { type: 'number' },
                          source: { type: 'string' },
                          message: { type: 'string', required: true },
                        },
                      },
                    },
                  },
                },
              },
              resolvedWorkspaceUri: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'rename' },
              files: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    uri: { type: 'string', required: true },
                    edits: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          range: { ...LSP_RANGE_OUTPUT_SCHEMA, required: true },
                          newText: { type: 'string', required: true },
                        },
                      },
                    },
                  },
                },
              },
              resolvedWorkspaceUri: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'diagnostics' },
              diagnostics: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    range: { ...LSP_RANGE_OUTPUT_SCHEMA, required: true },
                    severity: { type: 'number' },
                    source: { type: 'string' },
                    message: { type: 'string', required: true },
                  },
                },
              },
              resolvedWorkspaceUri: { type: 'string', required: true },
            },
          },
        ],
      },
      render: (args, value) => {
        const filePath = (args as LspToolArgs | null | undefined)?.file_path ?? ''
        switch (value.kind) {
          case 'locations':
            return [{ type: 'text', text: formatLocations(value.locations, value.resolvedWorkspaceUri, resolved.maxLocations, resolved.maxResultChars) }]
          case 'hover':
            return [{ type: 'text', text: formatHover(value.hover, resolved.maxResultChars) }]
          case 'documentSymbols':
            return [{ type: 'text', text: formatDocumentSymbols(filePath, value.symbols, resolved.maxLocations, resolved.maxResultChars) }]
          case 'codeActions':
            return [{ type: 'text', text: formatCodeActions(value.actions, resolved.maxLocations, resolved.maxResultChars) }]
          case 'rename':
            return [{ type: 'text', text: formatRename(value.files, value.resolvedWorkspaceUri, resolved.maxLocations, resolved.maxResultChars) }]
          case 'diagnostics':
            return [{ type: 'text', text: formatDiagnostics(filePath, value.diagnostics, resolved.maxLocations, resolved.maxResultChars) }]
          /* v8 ignore next -- exhaustive over the output schema's closed union; unreachable. */
          default:
            return assertNever(value, 'tool-lsp output')
        }
      },
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const input = parseLspArgs(args)
      const workspaceRoot = sessionCwd(exec)
      if (workspaceRoot === undefined) {
        throw new LspError('the lsp tool requires a session workspace cwd', 'LSP_WORKSPACE_REQUIRED')
      }
      const result = await ctx.lsp.query({
        operation: input.operation,
        filePath: input.filePath,
        position: input.position,
        workspaceRoot,
        ...(input.newName === undefined ? {} : { newName: input.newName }),
      }, exec.signal)
      switch (result.kind) {
        case 'locations':
          return {
            kind: 'locations' as const,
            locations: result.locations.map(location => ({
              uri: location.uri,
              range: {
                start: { line: location.range.start.line, character: location.range.start.character },
                end: { line: location.range.end.line, character: location.range.end.character },
              },
            })),
            resolvedWorkspaceUri: result.resolvedWorkspaceUri,
          }
        case 'hover':
          return {
            kind: 'hover' as const,
            hover: result.hover === null
              ? null
              : {
                contents: result.hover.contents,
                ...result.hover.range === undefined
                  ? {}
                  : {
                    range: {
                      start: { line: result.hover.range.start.line, character: result.hover.range.start.character },
                      end: { line: result.hover.range.end.line, character: result.hover.range.end.character },
                    },
                  },
              },
          }
        case 'documentSymbols':
          return {
            kind: 'documentSymbols' as const,
            symbols: result.symbols.map(symbol => ({
              name: symbol.name,
              kind: symbol.kind,
              range: {
                start: { line: symbol.range.start.line, character: symbol.range.start.character },
                end: { line: symbol.range.end.line, character: symbol.range.end.character },
              },
              selectionRange: {
                start: { line: symbol.selectionRange.start.line, character: symbol.selectionRange.start.character },
                end: { line: symbol.selectionRange.end.line, character: symbol.selectionRange.end.character },
              },
              depth: symbol.depth,
              ...(symbol.detail === undefined ? {} : { detail: symbol.detail }),
            })),
            resolvedWorkspaceUri: result.resolvedWorkspaceUri,
          }
        case 'codeActions':
          return {
            kind: 'codeActions' as const,
            actions: result.actions.map(action => ({
              title: action.title,
              ...(action.kind === undefined ? {} : { kind: action.kind }),
              ...(action.isPreferred === undefined ? {} : { isPreferred: action.isPreferred }),
              diagnostics: action.diagnostics.map(diagnostic => ({
                range: {
                  start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
                  end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
                },
                ...(diagnostic.severity === undefined ? {} : { severity: diagnostic.severity }),
                ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
                message: diagnostic.message,
              })),
            })),
            resolvedWorkspaceUri: result.resolvedWorkspaceUri,
          }
        case 'rename':
          return {
            kind: 'rename' as const,
            files: result.files.map(file => ({
              uri: file.uri,
              edits: file.edits.map(edit => ({
                range: {
                  start: { line: edit.range.start.line, character: edit.range.start.character },
                  end: { line: edit.range.end.line, character: edit.range.end.character },
                },
                newText: edit.newText,
              })),
            })),
            resolvedWorkspaceUri: result.resolvedWorkspaceUri,
          }
        case 'diagnostics':
          return {
            kind: 'diagnostics' as const,
            diagnostics: result.diagnostics.map(diagnostic => ({
              range: {
                start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
                end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
              },
              ...(diagnostic.severity === undefined ? {} : { severity: diagnostic.severity }),
              ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
              message: diagnostic.message,
            })),
            resolvedWorkspaceUri: result.resolvedWorkspaceUri,
          }
        /* v8 ignore next -- exhaustive over the closed LspQueryResult union; unreachable. */
        default:
          return assertNever(result, 'tool-lsp result')
      }
    },
    presentCall: presentLspCall,
  }))
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-lsp: ${name} must be a positive integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-lsp: ${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
