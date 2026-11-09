/** Account-owned sidebar spacing and total control heights. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/AccountMenu.module.css', import.meta.url), 'utf8')

it('keeps the launcher root filling the sidebar without resizing the settings carrier', () => {
  expect(css).toMatch(/\.root\s*\{[^}]*flex: 1;[^}]*min-width: 0;/)
})

it('includes padding and borders in the 32px More row and the 36px collapsed row', () => {
  const trigger = css.match(/\.trigger\s*\{([^}]+)\}/)?.[1]
  expect(trigger).toContain('box-sizing: border-box;')
  expect(trigger).toContain('height: 32px;')
  expect(trigger).toContain('line-height: 20px;')
  expect(css).toMatch(/\.trigger\[data-collapsed='true'\]\s*\{[^}]*width: 36px;[^}]*height: 36px;/)
})

it('carries no signed-out or inset variants anymore', () => {
  expect(css).not.toContain('data-inset')
  expect(css).not.toContain('data-signed-out')
})
