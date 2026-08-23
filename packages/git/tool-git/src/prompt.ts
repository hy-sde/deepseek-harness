/**
 * Static system-prompt section for the git tools: a compact contract card for
 * `commit`, `commit_apply`, and `review` so the model uses the split flow
 * correctly and never invents coverage the tools will reject.
 * @module @deepseek-ai/dsh-tool-git/prompt
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

/** Plugin configuration contributed by the prompt section. */
export interface GitPromptConfig {
  /** Disable the prompt section entirely (default false). */
  enabled?: boolean
}

const SECTION_NAME = 'git:tools'
const SECTION_ORDER = 118

const TEXT = [
  'Agentic git (port of omp): `commit` analyzes the staged/working tree and returns ground truth (per-file numstat, bounded diff, lock-file hints, a suggested plan skeleton); `commit_apply` executes a `SplitCommitPlan` you author (types/scopes/summaries/dependencies) with validation — every staged file planned exactly once, lock files placed automatically, hunks validated, dependency order topological, cycles rejected before anything is written; `review` fans out read-only reviewer subagents over worktree/staged/commit-range diffs and returns P0–P3 findings plus a ship/reject verdict.',
  'Flow: `commit` → author the plan → `commit_apply` (dryRun first for exact messages). commit/commit_apply never lose changes: failures unstage rather than drop.',
].join('\n')

/**
 * Build the git-tools prompt section.
 * @param config - section configuration.
 * @returns the {@link PromptSection} to register.
 */
export function buildGitPromptSection(config: GitPromptConfig = {}): PromptSection {
  return {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: config.enabled === false ? '' : TEXT,
  }
}
