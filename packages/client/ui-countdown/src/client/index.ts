/**
 * Countdown timer browser half: registers the sidebar-footer cell into the
 * `sidebar.footer.action` list slot, so the clock sits right beside the
 * Settings seat at the sidebar foot. All timer state lives in the module
 * store (`./timer.ts`); this file only mounts the seat.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { CountdownCell } from './CountdownCell.tsx'

/** Required services: the slot system only (timer state lives in the store). */
export const inject = ['slots']

/**
 * Client plugin body: register the countdown cell beside Settings.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'countdown',
    order: 100,
    label: 'Countdown',
  }, CountdownCell))
}
