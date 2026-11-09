/** Sidebar settings launcher registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { AccountMenu } from './AccountMenu.tsx'
import { en, ja, es, fr, de, ru, pt, zh, type AccountKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.account': AccountKey }
}

/** Services required by the launcher. */
export const inject = ['slots', 'locale']
/** Register the sidebar settings launcher. @param ctx - client plugin context. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('settings.account', { en, zh, ja, es, fr, de, ru, pt }), 'launcher: dictionaries')
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher', locale: 'settings.account', inject: () => ({}),
  }, AccountMenu))
}
