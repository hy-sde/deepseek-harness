/**
 * Model-facing agentsview CLI tool (`agentsview`: session `list`/`get`,
 * `health`, `stats`, `usage`, `sessionUsage`, `search`, `recallQuery`,
 * `recallBrief`, `exportSessions`) over the installed `agentsview` CLI, plus an
 * `agentsview:tools` system-prompt section. Agent-plane: this package mounts as
 * a preset or patch row and registers no service of its own.
 * @module @deepseek-ai/dsh-tool-agentsview
 */

import { Context } from '@deepseek-ai/cordis'
import { applyAgentsviewTools } from './agentsview.ts'
import type { AgentsviewToolConfig } from './agentsview.ts'
import { buildAgentsviewPromptSection } from './prompt.ts'

/** Plugin configuration (camera over the CLI invocation). */
export interface Config extends AgentsviewToolConfig {}

export { buildAgentsviewPromptSection } from './prompt.ts'
export {
  applyAgentsviewTools,
  AgentsviewCliError,
  renderPayload,
  buildAgentsviewArgv,
  parseAgentsviewJson,
  buildAgentsviewEnv,
  AGENTSVIEW_ACTIONS,
} from './agentsview.ts'
export type {
  AgentsviewToolConfig,
  AgentsviewAction,
  AgentsviewArgs,
  AgentsviewToolValue,
} from './agentsview.ts'
export { checkAgentsviewCli } from './invariant.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-agentsview'

/** Services consumed by this plugin (tools + systemPrompt from the agent bundle). */
export const inject = ['tools', 'systemPrompt']

/**
 * Register the agentsview CLI tool and the `agentsview:tools` prompt section.
 * @param ctx - the agent-plane plugin context (injects `tools`, `systemPrompt`).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  applyAgentsviewTools(ctx, config)
  ctx.systemPrompt.section(buildAgentsviewPromptSection())
}

/** Cordis plugin object for `@deepseek-ai/dsh-tool-agentsview`. */
export default { name, inject, apply }
