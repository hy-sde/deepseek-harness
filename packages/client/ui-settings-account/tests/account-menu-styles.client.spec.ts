/** Account-owned sidebar spacing and total control heights. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/AccountMenu.module.css', import.meta.url), 'utf8')

it('keeps the launcher root filling the sidebar without resizing the settings carrier', () => {
  expect(css).toMatch(/\.root\s*\{[^}]*flex: 1;[^}]*min-width: 0;/)
})

it('keeps the icon-only launcher trigger a centered 36px control', () => {
  const trigger = css.match(/\.trigger\s*\{([^}]+)\}/)?.[1]
  expect(trigger).toContain('box-sizing: border-box;')
  expect(trigger).toContain('width: 36px;')
  expect(trigger).toContain('height: 36px;')
  expect(trigger).toContain('justify-content: center;')
})

it('carries no signed-out or inset variants anymore', () => {
  expect(css).not.toContain('data-inset')
  expect(css).not.toContain('data-signed-out')
})
