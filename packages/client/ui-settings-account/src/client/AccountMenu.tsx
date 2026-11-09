/** Sidebar settings launcher and menu. */
import { useRef, useState } from 'react'
import { Menu, IconEllipsisOutlineMedium, IconSettingsOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './AccountMenu.module.css'

/** Settings launcher composed by the settings shell. */
export type AccountMenuProps = PropsRuntime<'settings.launcher'> & PropsLocale<'settings.account'>

/** @param props - sidebar geometry and settings navigation. @returns account launcher menu. */
export function AccountMenu({ wide, settingsShortcut, openSettings, t }: AccountMenuProps) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  return <div className={css.root}>
    <Menu open={open} side="top" portal autoFocus className={css.anchor}
      anchor={<button ref={trigger} type="button" className={css.trigger} data-collapsed={!wide} aria-label={t('menu')}
        aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <IconEllipsisOutlineMedium size={14} />
        {wide && <span className={css.label}>{t('more')}</span>}
      </button>}
      items={[{ id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} />,
        ...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut }) }]}
      onClose={() => { setOpen(false) }}
      onSelect={() => { setOpen(false); trigger.current?.focus(); openSettings() }} />
  </div>
}
