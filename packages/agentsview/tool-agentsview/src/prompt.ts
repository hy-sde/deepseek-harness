/**
 * `agentsview:tools` system-prompt section: a compact contract card on the
 * agentsview analytics surface — what the archive is, which actions exist,
 * when the first call may be slow, and what needs extra setup (semantic
 * search, recall extraction).
 * @module @deepseek-ai/dsh-tool-agentsview/prompt
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

const SECTION_NAME = 'agentsview:tools'
const SECTION_ORDER = 132

const TEXT = [
  'Session analytics runs over the `agentsview` tool — one-shot queries against the local agentsview archive that the agentsview CLI maintains directly from the DeepSeek Harness session store (it parses `session.jsonl.zstd` logs itself, so no DSH index is involved and nothing here writes sessions).',
  'Actions: `list` (recent sessions with health grade + outcome), `get` (one session metadata + signals), `health` (grade/outcome list or one session detail), `stats` (windowed workspace analytics), `usage`/`sessionUsage` (token + cost reports), `search` (transcript content: substring|regex|fts|semantic|hybrid), `recallQuery`/`recallBrief` (distilled session knowledge), `exportSessions` (content-free bulk export).',
  'The first call to a fresh archive syncs the session store and can take a while; later calls are local SQLite reads. If the binary is missing, install agentsview (https://agentsview.io/install.sh) or set `config.cliPath`; `config.sessionDirs` overrides where it reads DSH sessions.',
  'Structured actions return JSON; `recallQuery`/`recallBrief` return human text. `search` with `fts` is FTS5; `semantic`/`hybrid` need the vector index built (`agentsview embeddings build`, configured `[vector]`), otherwise fall back to `fts`/`substring`.',
].join('\n')

/**
 * Build the agentsview-tools prompt section.
 * @param config - configuration; `enabled: false` disables the section.
 * @returns the {@link PromptSection} to register.
 */
export function buildAgentsviewPromptSection(config: { enabled?: boolean } = {}): PromptSection {
  return {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: config.enabled === false ? '' : TEXT,
  }
}
