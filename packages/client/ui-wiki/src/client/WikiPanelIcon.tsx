import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './WikiPanelIcon.module.css'

/** Sidebar-panel-strip glyph for the wiki panel. */
export function WikiPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return (
    <span className={css.glyph} style={{ fontSize: size }} aria-hidden="true">❖</span>
  )
}
