/**
 * First-turn project-memory injection: a `systemPrompt.section` whose text is
 * evaluated per assembly and returns the calling session's project memory
 * (`memory_summary.md` + `learned.md`) as a markdown block, or '' when the
 * project has none.
 *
 * The section text must be produced synchronously (the system-prompt
 * registrations are sync), so this module reads the two small files with
 * `readFileSync` — the same source the `ctx.memory` service reads, resolved
 * to the identical default root. The reads are OS-cache-cheap and bounded by
 * `injectionMaxChars`.
 * @module @deepseek-ai/dsh-tool-memory/prompt
 */

import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  BANK_FILE,
  LEARNED_FILE,
  MAX_INJECTED_BANK_ENTRIES,
  SUMMARY_FILE,
  displayRoot,
  formatBankRows,
  neutralizeLearnedText,
  parseBankText,
  projectRootOf,
  renderSummariesBlock,
  resolveMemoryRoot,
} from '@deepseek-ai/dsh-memory'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

/** Plugin configuration for prompt injection. */
export interface MemoryPromptConfig {
  /** Memory root; must match the `ctx.memory` row's root. Defaults to `<harness home>/memories`. */
  root?: string
  /** Combined char budget for summary + lessons injection (default 16000). */
  injectionMaxChars?: number
  /** Disable prompt injection entirely (default false). */
  enabled?: boolean
}

const SECTION_NAME = 'memory:project'
const SECTION_ORDER = 150

/** The section's static rules, rendered above the dynamic block. */
const RULES = [
  'Memory is project-scoped long-term memory the agent curates itself. Durable heuristics, process context, user preferences, and project decisions belong here; current repo files, runtime output, and user instructions are factual state in the transcript.',
  'Memory disagrees with the repo or user instruction → memory is stale: prefer the repo, and update memory with memory_edit / retain / learn so later sessions do not repeat the mistake.',
  'Confidence requires repository verification; memory alone is never sufficient proof of current repo state.',
].join('\n')

/** Truncate head-tail like omp (approx 4 chars/token) with an explicit marker. */
function truncateApprox(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  return `${text.slice(0, head)}\n\n...[truncated]...\n\n${text.slice(-tail)}`
}

/** Synchronously read the project memory block ('' when absent). */
export function readProjectMemoryBlock(root: string, maxChars: number): string {
  let summary = ''
  let learned = ''
  let bank: string[] | undefined
  try {
    summary = readFileSync(`${root}/${SUMMARY_FILE}`, 'utf8').trim()
  } catch {
    // Missing summary is normal until a consolidation pass writes one.
  }
  try {
    learned = neutralizeLearnedText(readFileSync(`${root}/${LEARNED_FILE}`, 'utf8')).trim()
  } catch {
    // Missing lessons are normal for a fresh project.
  }
  try {
    const rows = parseBankText(readFileSync(`${root}/${BANK_FILE}`, 'utf8'))
    const bullets = formatBankRows(rows, MAX_INJECTED_BANK_ENTRIES)
    bank = bullets
  } catch {
    // Missing bank is normal for a fresh project.
  }
  if (!summary && !learned && (bank?.length ?? 0) === 0) return ''

  const parts: { summary?: string; learned?: string; bank?: string[] } = {}
  if (summary.length > 0) parts.summary = summary
  if (learned.length > 0) parts.learned = learned
  if (bank !== undefined && bank.length > 0) parts.bank = bank
  const rawBlock = renderSummariesBlock(parts)
  return truncateApprox(rawBlock, Math.max(1, maxChars))
}

/** Extract the calling session's project cwd from an assembly context. */
export function cwdFromAssemblyContext(context: { agent?: unknown }): string | undefined {
  const agent = context.agent as { session?: { header?: { cwd?: string } } } | undefined
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && isAbsolute(cwd) ? cwd : undefined
}

/** Build the `memory:project` prompt section for one plugin instance. */
export function buildMemoryPromptSection(config: MemoryPromptConfig): PromptSection {
  const memoryRoot = config.root ? resolveMemoryRoot({ root: config.root }) : resolveMemoryRoot()
  const maxChars = config.injectionMaxChars ?? 16_000
  const enabled = config.enabled ?? true
  return {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      if (!enabled) return ''
      const cwd = cwdFromAssemblyContext(context)
      if (!cwd) return ''
      const root = projectRootOf(memoryRoot, cwd)
      const block = readProjectMemoryBlock(root, maxChars)
      if (!block) return ''
      return `# Project memory\nRoot: ${displayRoot(root)}\n${RULES}\n\n${block}`
    },
  }
}
