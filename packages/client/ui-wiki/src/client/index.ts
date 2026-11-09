/**
 * Wiki surfaces plugin, browser half: mounts two additive seats — the
 * sidebar-panel-strip Wiki entry (`sidebar.panellist`) and the docked
 * main-column panel (`main` keyed slot, rendered when the Wiki strip entry
 * is selected). The panel binds the wire face to the shared store when the
 * connection is up and re-binds on connection resets. Binding is wire-lazy:
 * no `listPages` call happens at page load — the page list loads when the
 * panel first mounts, so GUI startup never pays the graph CLI cost.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots), the Client
// Remote assembly (ctx.remote) that mounts the generated `wiki` namespace,
// and the layout shell's SlotMap declaration (main).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the sidebar slot declarations (sidebar.panellist) and the
// MainPanelId brand re-export.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { WikiClient } from './api.ts'
import { wikiStore } from './store.ts'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { WikiPanel } from './WikiPanel.tsx'
import { WikiPanelIcon } from './WikiPanelIcon.tsx'
import { de, en, es, fr, ja, pt, ru, zh, type WikiKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Wiki sidebar strip entry and main panel copy. */
    'wiki': WikiKey
  }
}

/** The wiki panel's main-slot key; must match the strip entry id. */
const PANEL_ID = 'wiki' as MainPanelId

export const inject = ['slots', 'locale', 'remote', 'remote.wiki']

/**
 * Client plugin body: register the strip icon beside Plugins and Automation
 * tasks and the docked panel onto the main column.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('wiki', { zh, en, ja, es, fr, de, ru, pt }), 'ui-wiki: panel dictionaries')
  const bind = (): void => {
    const wiki = (ctx.get('remote') as ClientRemote).wiki
    void wikiStore.bind(new WikiClient(wiki))
  }
  ctx.on('connection/reset', bind)
  if (ctx.get('remote')) bind()

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: () => ctx.locale.bind('wiki')('panel.label'),
    locale: 'wiki',
  }, WikiPanelIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: 'wiki',
  }, WikiPanel))
}
