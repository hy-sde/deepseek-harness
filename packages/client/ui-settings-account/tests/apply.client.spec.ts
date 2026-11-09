// @vitest-environment jsdom
/** The settings launcher in the shipped client composition, in Desktop and in a plain browser. */
import { afterEach, expect, vi } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { en } from '../src/client/locales.ts'

const it = createClientTest({ roster: webApp })
const SELF = '@deepseek-ai/dsh-client-ui-settings-account'
afterEach(() => { vi.unstubAllGlobals() })

it('registers the launcher unconditionally, without any account stream, in a plain browser and after reload', async ({ start }) => {
  const c = await start()
  for (const reload of [false, true]) {
    if (reload) await c.reload(SELF)
    expect(c.mock.streams.end('account/watch')).toBe(0)
    const entries = c.ctx.slots.entries('settings.launcher')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.locale).toBe('settings.account')
    expect(entries[0]!.component).toBeDefined()
    // No account surfaces remain registered anywhere.
    expect(c.ctx.slots.entries('settings.section').some(entry => entry.options.id === 'account')).toBe(false)
    expect(c.ctx.slots.entries('shell.quota-notice').some(entry => entry.locale === 'settings.account')).toBe(false)
  }
  await c.unload(SELF)
  expect(c.ctx.slots.entries('settings.launcher')).toHaveLength(0)
}, 60_000)

it('registers all launcher dictionaries', async ({ start }) => {
  const c = await start()
  const t = c.ctx.get('locale')!.bind('settings.account') as (key: string) => string
  expect(t('settings')).toBe(en.settings)
  expect(t('menu')).toBe(en.menu)
  expect(t('more')).toBe(en.more)
}, 60_000)
