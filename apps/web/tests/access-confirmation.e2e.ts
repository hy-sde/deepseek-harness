// Web e2e scenario: the composer permission picker switches to Full access
// directly, with no risk-confirmation dialog. Zero model calls: the scenario
// boots the shipped Web composition and exercises the real permission
// projection, client command path, HTTP RPC, and pushed update.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { ZH_BROWSER_LOCALE, connectFreshWorkspaceZh, saveFailureShot } from './support.ts'

describe('web e2e: Full access switch in the composer picker', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // CI uses Playwright's pinned browser. A developer may point this one
    // scenario at an installed Chromium when the matching browser download
    // is temporarily unavailable.
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    // Keep the product default Chinese locale: the assertion pins the actual
    // registered dictionary rather than a test-local translation callback.
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('switches to Full access from the composer picker without any confirmation dialog', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-full-access-switch'))
    const access = page.locator('button[aria-label^="访问模式"]').first()
    await access.waitFor({ timeout: 10_000 })

    expect(await access.getAttribute('aria-label')).toBe('访问模式，当前：Workspace Write')

    await access.click()
    await page.getByRole('menuitem', { name: 'Full access' }).click()

    // No risk-confirmation dialog: the switch lands immediately, confirmed by
    // the pushed projection frame in the chip label.
    expect(await page.getByRole('dialog').count()).toBe(0)
    await expect.poll(() => access.getAttribute('aria-label'), { timeout: 10_000 })
      .toBe('访问模式，当前：Full access')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
