/**
 * LogSeq diary and work-log example extension, ported from the oh-my-pi
 * extensions of the same purpose. Mounts the two model tools directly on
 * `ctx.tools`; the `/diary` and `/diary-work` slash commands activate only
 * when a command registry is composed, following the same optional-seam
 * pattern as plan mode. Named exports preserve Loader registration metadata.
 * @module @deepseek-ai/dsh-logseq-example
 */

import { Context } from '@deepseek-ai/cordis'
import { registerDiaryTool, registerDiaryCommand } from './diary.ts'
import { registerWorkTool, registerWorkCommand } from './work.ts'

export { registerDiaryTool, registerDiaryCommand } from './diary.ts'
export { registerWorkTool, registerWorkCommand } from './work.ts'
export { runLogseq, ednString, parseDate } from './logseq.ts'

export const name = 'logseq-example'
export const inject = ['tools']

/**
 * Register the LogSeq tools and slash commands on the given context.
 * @param ctx - registrant context carrying the tool registry.
 */
export function apply(ctx: Context): void {
  registerDiaryTool(ctx)
  registerWorkTool(ctx)
  // The command child activates only when a command registry is composed
  // (headless assemblies that steer agents elsewhere stay unaffected).
  ctx.inject(['commands'], (commandCtx) => {
    registerDiaryCommand(commandCtx)
    registerWorkCommand(commandCtx)
  })
}
