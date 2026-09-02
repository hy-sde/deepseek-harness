/**
 * Sidebar footer toggle for the wiki drawer: a compact seat beside Settings.
 * Wide shows a labeled button; the collapsed rail shows a wiki-glyph only.
 * Clicking flips the shared drawer store (index.ts mounts the overlay panel).
 */

import clsx from 'clsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { wikiStore } from './store.ts'
import css from './WikiToggle.module.css'

/** Sidebar-footer cell toggling the wiki drawer. */
export type WikiToggleProps =
  SidebarFooterActionOwnerProps
  & PropsLocale<'wiki'>

export function WikiToggle({ wide, t }: WikiToggleProps) {
  const open = wikiStore.getState().open
  return (
    <button
      className={clsx(css.toggle, !wide && css.rail, open && css.active)}
      title={open ? t('toggle.closeWiki') : t('toggle.openWiki')}
      onClick={() => { wikiStore.toggleOpen() }}
    >
      <span className={css.glyph} aria-hidden>❖</span>
      {wide && <span className={css.label}>{t('toggle.label')}</span>}
    </button>
  )
}
