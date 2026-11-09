// @vitest-environment jsdom
/** The sidebar settings launcher: items, shortcut keycap, and menu behavior. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { AccountMenu, type AccountMenuProps } from '../src/client/AccountMenu.tsx'
// Type-only: pulls the LocaleNamespaceMap augmentation (PropsLocale<'settings.account'>).
import type {} from '../src/client/index.ts'
import { en, ja, zh, type AccountKey } from '../src/client/locales.ts'

afterEach(() => { cleanup() })

const globals = {} as GlobalStandardProps

/** @param copy - dictionary under test. @param overrides - prop patches. @returns launcher props for one copy. */
function propsOf(copy: typeof en | typeof zh | typeof ja, overrides: Partial<AccountMenuProps> = {}): AccountMenuProps {
  return {
    ...globals, wide: true, openSettings: vi.fn(),
    t: key => copy[key as AccountKey], ...overrides,
  } as AccountMenuProps
}

it.each([en, zh, ja])('offers only Settings from the launcher menu', (copy) => {
  const openSettings = vi.fn()
  render(<AccountMenu {...propsOf(copy, { openSettings })} />)
  const trigger = screen.getByRole('button', { name: copy.menu })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(trigger)
  const items = screen.getAllByRole('menuitem')
  expect(items).toHaveLength(1)
  expect(items[0]!.textContent).toBe(copy.settings)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(items[0]!)
  expect(openSettings).toHaveBeenCalledOnce()
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(trigger)
})

it.each([false, true])('labels the trigger by sidebar width (wide: %s)', (wide) => {
  render(<AccountMenu {...propsOf(en, { wide })} />)
  const trigger = screen.getByRole('button', { name: en.menu })
  expect(trigger.dataset.collapsed).toBe(String(!wide))
  expect(trigger.textContent).toBe(wide ? en.more : '')
})

it('shows the settings shortcut as a keycap', () => {
  render(<AccountMenu {...propsOf(en, { settingsShortcut: { keys: ['⌘', ','] } })} />)
  fireEvent.click(screen.getByRole('button', { name: en.menu }))
  expect(screen.getByRole('menuitem', { name: en.settings }).textContent).toContain('⌘')
})

it('omits the shortcut keycap when none is configured', () => {
  render(<AccountMenu {...propsOf(en)} />)
  fireEvent.click(screen.getByRole('button', { name: en.menu }))
  expect(screen.getByRole('menuitem', { name: en.settings }).textContent).toBe(en.settings)
})

it('dismisses on Escape without opening settings', () => {
  const openSettings = vi.fn()
  render(<AccountMenu {...propsOf(en, { openSettings })} />)
  fireEvent.click(screen.getByRole('button', { name: en.menu }))
  expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menuitem')).toBeNull()
  expect(openSettings).not.toHaveBeenCalled()
})
