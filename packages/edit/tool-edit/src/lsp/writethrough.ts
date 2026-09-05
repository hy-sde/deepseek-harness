/**
 * Thin port of oh-my-pi's `createLspWritethrough` (lsp/writethrough.ts +
 * diagnostic formatting from lsp/utils.ts) onto the harness LSP seam
 * (`@deepseek-ai/dsh-lsp`), which exposes `query`, `format` and
 * `collectDiagnostics`. The original's batch machinery is preserved only in
 * essence: a batch id plux a flush flag merging deferred diagnostics across
 * writes within one tool call via an in-memory ledger per writethrough
 * session (keyed by the callback identity via a WeakMap), mirroring the
 * batch argument surface.
 *
 * Note on the seam interface: the original called `lsp.format` /
 * `lsp.collectDiagnostics` on its own LSP client; the harness seam provides
 * `format`/`collectDiagnostics` directly on the {@link LspService}, guarded at
 * runtime so an older seam degrades to pass-through.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import type { LspDiagnostic, LspService } from '@deepseek-ai/dsh-lsp'
import type { ResolvedConfig } from '../session.ts'

/** Diagnostics payload attached to an edit result. */
export interface EditDiagnosticsResult {
  summary: string
  messages: readonly LspDiagnostic[]
}

/** Cap on surfaced diagnostic messages (from the original's limit). */
const DIAGNOSTIC_MESSAGE_LIMIT = 50

/** Truncate a message list to {@link DIAGNOSTIC_MESSAGE_LIMIT}. */
export function limitDiagnosticMessages(messages: readonly LspDiagnostic[]): readonly LspDiagnostic[] {
  return messages.length <= DIAGNOSTIC_MESSAGE_LIMIT ? messages : messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT)
}

/**
 * Summarize diagnostics into a severity-count summary line (ported from
 * `summarizeDiagnosticMessages` / `formatDiagnosticsSummary`).
 */
export function summarizeDiagnostics(diagnostics: readonly LspDiagnostic[]): string {
  const counts = { error: 0, warning: 0, info: 0, hint: 0 }
  for (const diagnostic of diagnostics) {
    switch (diagnostic.severity) {
      case 1:
        counts.error++
        break
      case 2:
        counts.warning++
        break
      case 3:
        counts.info++
        break
      case 4:
        counts.hint++
        break
      default:
        break
    }
  }
  const parts: string[] = []
  if (counts.error > 0) parts.push(`${counts.error} error(s)`)
  if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`)
  if (counts.info > 0) parts.push(`${counts.info} info(s)`)
  if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`)
  return parts.length > 0 ? parts.join(', ') : 'no issues'
}

/** Format one diagnostic as `line:col [severity] source(message)`. */
export function formatDiagnosticMessage(diagnostic: LspDiagnostic): string {
  const severity = diagnostic.severity === 1 ? 'error'
    : diagnostic.severity === 2 ? 'warning'
      : diagnostic.severity === 3 ? 'info'
        : diagnostic.severity === 4 ? 'hint'
          : 'unknown'
  const source = diagnostic.source ? `[${diagnostic.source}] ` : ''
  const message = diagnostic.message.trim()
  const line = diagnostic.range.start.line + 1
  const col = diagnostic.range.start.character + 1
  return `${line}:${col} [${severity}] ${source}${message}`
}

/** Optional per-batch metadata merged across writes within one tool call. */
export interface WritethroughBatch {
  id: string
  flush: boolean
}

/**
 * The write-through callback used by every edit mode: format-on-write via the
 * LSP seam, then optional diagnostics. `signal` aborts the LSP calls; `batch`
 * merges deferred diagnostics within a tool call. Never throws on LSP
 * failure — formatting/diagnostics degrade to pass-through.
 */
export type WritethroughCallback = (
  dst: string,
  content: string,
  signal?: AbortSignal,
  batch?: WritethroughBatch,
) => Promise<EditDiagnosticsResult | undefined>

/** Deduplicate diagnostics that differ only by version (same line/col/message). */
function deduplicateDiagnostics(diagnostics: readonly LspDiagnostic[]): readonly LspDiagnostic[] {
  const seen = new Set<string>()
  const kept: LspDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.range.start.line}:${diagnostic.range.start.character}|${diagnostic.severity ?? 0}|${diagnostic.message}`
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(diagnostic)
  }
  return kept
}

/** Serialize the diagnostics payload into the model-facing result text. */
export function renderDiagnosticsSummary(result: EditDiagnosticsResult | undefined): string {
  if (!result) return ''
  const messageLines = result.messages.map(formatDiagnosticMessage)
  const body = messageLines.length > 0 ? messageLines.join('\n') : ''
  return [result.summary, body].filter(part => part.length > 0).join('\n')
}

/** Build a DiagnosticsResult from the seam response plus dedupe/config. */
function toDiagnosticsResult(
  diagnostics: readonly LspDiagnostic[],
  deduplicate: boolean,
): EditDiagnosticsResult {
  const messages = limitDiagnosticMessages(deduplicate ? deduplicateDiagnostics(diagnostics) : diagnostics)
  return { summary: summarizeDiagnostics(messages), messages }
}

/**
 * Build the writethrough callback for one edit tool call.
 *
 * The harness LSP seam's `format`/`collectDiagnostics` accept `signal`, so the
 * batch-shaped surface of the original is adapted to a per-callback ledger:
 * each distinct callback (per session) tracks its own version counter and
 * pending batch diagnostics keyed by batch id.
 */
export function createWritethrough(options: { lsp: LspService | undefined; cwd: string; config: ResolvedConfig }): WritethroughCallback {
  const { lsp, cwd, config } = options
  const versions = new Map<string, number>()
  const batches = new Map<string, EditDiagnosticsResult>()

  return async (dst, content, signal, batch): Promise<EditDiagnosticsResult | undefined> => {
    let text = content
    try {
      if (config.formatOnWrite && lsp !== undefined) {
        const formatting = await lsp.format({
          filePath: dst,
          workspaceRoot: cwd,
          text,
          formattingOptions: { tabSize: 2, insertSpaces: true },
        }, signal)
        // formattedText is null when the server has no formatting edits.
        if (formatting.formattedText !== null) {
          text = formatting.formattedText
        }
      }
    } catch {
      // format unavailable/failed → keep authored content
    }

    let diagnostics: EditDiagnosticsResult | undefined
    if (config.diagnosticsOnEdit && lsp !== undefined) {
      try {
        const version = (versions.get(dst) ?? 0) + 1
        versions.set(dst, version)
        const collected = await lsp.collectDiagnostics({
          filePath: dst,
          workspaceRoot: cwd,
          text,
          version,
        }, signal)
        if (collected.diagnostics.length > 0) {
          diagnostics = toDiagnosticsResult(collected.diagnostics, config.diagnosticsDeduplicate)
        }
      } catch {
        // diagnostics unavailable → no diagnostics payload
      }
    }

    // Batch semantics in essence: a non-flushing batch defers its diagnostics;
    // a flushing batch merges them and releases the ledger slot.
    if (batch) {
      const prior = batches.get(batch.id)
      const merged =
        prior !== undefined && diagnostics !== undefined
          ? {
            summary: summarizeDiagnostics([...prior.messages, ...diagnostics.messages]),
            messages: limitDiagnosticMessages([...prior.messages, ...diagnostics.messages]),
          }
          : prior ?? diagnostics
      if (!batch.flush) {
        if (merged !== undefined) batches.set(batch.id, merged)
        return merged
      }
      batches.delete(batch.id)
      return merged
    }
    return diagnostics
  }
}
