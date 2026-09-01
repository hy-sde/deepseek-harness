/**
 * Wiki surfaces plugin, browser half: mounts two additive seats — the
 * sidebar-foot toggle (`sidebar.footer.action`) and the frame-wide floating
 * drawer (`shell.overlay`, rendered by the layout shell's overlay layer). The
 * drawer binds the wire face to the shared store when the connection is up
 * and re-binds on connection resets. Binding is wire-lazy: no `listPages`
 * call happens at page load — the page list loads on the drawer's first
 * open, so GUI startup never pays the graph CLI cost.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotRegistry service merge (ctx.slots), the Client
// Remote assembly (ctx.remote) that mounts the generated `wiki` namespace,
// and the layout shell's SlotMap declaration (shell.overlay).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { WikiClient } from './api.ts'
import { wikiStore } from './store.ts'
import { WikiDrawer } from './WikiDrawer.tsx'
import { WikiToggle } from './WikiToggle.tsx'

export const inject = ['slots', 'remote', 'remote.wiki']

/**
 * Client plugin body: register the toggle beside Settings and the floating
 * drawer onto the shell overlay layer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const bind = (): void => {
    const wiki = (ctx.get('remote') as ClientRemote).wiki
    void wikiStore.bind(new WikiClient(wiki))
  }
  ctx.on('connection/reset', bind)
  if (ctx.get('remote')) bind()

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
