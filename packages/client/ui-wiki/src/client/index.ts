/**
 * Wiki surfaces plugin, browser half: mounts two additive seats — the
 * sidebar-foot toggle (`sidebar.footer.action`) and the frame-wide floating
 * drawer (`shell.overlay`, rendered by the layout shell's overlay layer). The
 * drawer binds the wire face to the shared store when the connection is up
 * and re-binds on connection resets.
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { WikiClient } from './api.ts'
import { wikiStore } from './store.ts'
import { WikiDrawer } from './WikiDrawer.tsx'
import { WikiToggle } from './WikiToggle.tsx'

/** Required services: the slot system and the connection handle (wire face). */
export const inject = ['slots', 'connection']

/**
 * Client plugin body: register the toggle beside Settings and the floating
 * drawer onto the shell overlay layer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const bind = (): void => {
    const connection = ctx.get('connection') as ConnectionHandle
    void wikiStore.bind(new WikiClient(connection.api.wiki))
  }
  ctx.on('connection/reset', bind)
  if (ctx.get('connection')) bind()

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'wiki',
    order: 90,
    label: 'Wiki',
  }, WikiToggle))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'wiki-drawer',
    order: 10,
    label: 'Wiki drawer',
  }, WikiDrawer))
}
