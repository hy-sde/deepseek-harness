/**
 * Countdown timer browser half: registers the sidebar-footer cell into the
 * `sidebar.footer.action` list slot, so the clock sits right beside the
 * Settings seat at the sidebar foot. All timer state lives in the module
 * store (`./timer.ts`); this file only mounts the seat.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { CountdownCell } from './CountdownCell.tsx'
import { en, zh, type CountdownKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Countdown timer cell copy. */
    'countdown': CountdownKey
  }
}


/** Required services: the slot system only (timer state lives in the store). */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the countdown cell beside Settings. Waits on
 * the sidebar declaration through `slots.inject`, because the sidebar shell
 * registers its children table in a later effect phase.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('countdown', { zh, en }), 'ui-countdown: sidebar timer dictionaries')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'countdown',
    order: 100,
    label: 'Countdown',
    locale: 'countdown',
  }, CountdownCell))
}
