/**
 * Sidebar footer toggle for the wiki drawer: a compact seat beside Settings.
 * Wide shows a labeled button; the collapsed rail shows a wiki-glyph only.
 * Clicking flips the shared drawer store (index.ts mounts the overlay panel).
 */

import clsx from 'clsx'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { wikiStore } from './store.ts'
import css from './WikiToggle.module.css'

/** Sidebar-footer cell toggling the wiki drawer. */
export function WikiToggle({ wide }: SidebarFooterActionOwnerProps) {
  const open = wikiStore.getState().open
  return (
    <button
      className={clsx(css.toggle, !wide && css.rail, open && css.active)}
      title={open ? 'Close wiki' : 'Open wiki'}
      onClick={() => { wikiStore.toggleOpen() }}
    >
      <span className={css.glyph} aria-hidden>❖</span>
      {wide && <span className={css.label}>Wiki</span>}
    </button>
  )
}
