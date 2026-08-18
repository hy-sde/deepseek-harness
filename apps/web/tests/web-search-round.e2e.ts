// Web e2e scenario for the shipped default search composition. A real browser
// drives `web_search`; the model stream is replayed while the real public
// provider searches through a deterministic engine HTML document served at the
// network boundary — one stubbed fetch, no external search traffic.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WEB_SEARCH_MAX_RESULTS } from '@deepseek-ai/dsh-tool-web'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/web-search-round', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./snapshots/web-search-round/session.jsonl', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/web-search-round/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const QUERY = 'DeepSeek Harness snapshot search'
const PROMPT = `Use web_search to search exactly "${QUERY}". Then reply exactly SEARCH_DONE and stop.`

/** The single engine endpoint the scenario exercises through the stubbed network boundary. */
const ENGINE_ENDPOINT = 'https://html.duckduckgo.com/html/'

/**
 * Provider results the double returns, exceeding the shipped `searchMaxResults`
 * so the seam's cap and the card's scroll container are both exercised. Each row
 * carries a title, a snippet, and a date, so 8 kept rows exceed the `.sources`
 * 320px max-height.
 */
const PROVIDER_RESULT_COUNT = 12

/** One provider result's URL, by 1-based provider order. */
function resultUrl(ordinal: number): string {
  return `https://docs.example.test/search/${ordinal}`
}

/** One provider result's title, by 1-based provider order. */
function resultTitle(ordinal: number): string {
  return `Snapshot Search Result ${ordinal}`
}

/** One provider result's citation excerpt, by 1-based provider order. */
function resultSnippet(ordinal: number): string {
  return `Snapshot search excerpt ${ordinal}: the harness replays this source list from a local endpoint.`
}

/** One provider result's `page_age`, by 1-based provider order (July 2026 days 01..12). */
function resultPageAge(ordinal: number): string {
  return `2026-07-${String(ordinal).padStart(2, '0')}`
}

/** The 1-based provider ordinals, in provider order. */
const RESULT_ORDINALS = Array.from({ length: PROVIDER_RESULT_COUNT }, (_value, index) => index + 1)

interface CapturedEngineFetch {
  url: string
  body: string | undefined
}

/** The static result page the stubbed network boundary serves to the engine. */
function engineResultHtml(): string {
  return `<html><body>${RESULT_ORDINALS.map(ordinal => `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(resultUrl(ordinal))}">${resultTitle(ordinal)}</a>
      <div class="result__snippet">${resultSnippet(ordinal)}</div>
      <div class="result__timestamp">${resultPageAge(ordinal)}</div>
    </div>`).join('')}
  </body></html>`
}

/**
 * Stub the global network boundary for the real public provider: the provider
 * runs in this process, so a `fetch` stub scoped to the engine endpoint serves
 * a deterministic result page while every other request passes through to the
 * real fetch. The search therefore keeps the genuine provider code path.
 */
function stubEngineFetch(captured: CapturedEngineFetch[]): void {
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === ENGINE_ENDPOINT) {
      captured.push({ url, body: typeof init?.body === 'string' ? init.body : undefined })
      return new Response(engineResultHtml(), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    }
    return originalFetch(input as RequestInfo | URL, init)
  }))
}

describe('web e2e: shipped default web search', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const engineFetches: CapturedEngineFetch[] = []
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    stubEngineFetch(engineFetches)
    scaffold = await launchWebScaffold({
      publicSearch: { engines: ['duckduckgo'] },
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15 }),
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllGlobals()
    await browser?.close()
    await scaffold?.close()
  })

  it('drives the recorded search to a settled turn (all modes)', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-drive'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
  }, 200_000)

  it.skipIf(MODE === 'record')('uses the real provider and persists the capped structured result', () => {
    // The real public provider made exactly one engine request through the
    // stubbed network boundary: the single configured engine's result page.
    expect(engineFetches).toHaveLength(1)
    expect(engineFetches[0]).toMatchObject({ url: ENGINE_ENDPOINT })
    expect(engineFetches[0]?.body).toContain(`q=${encodeURIComponent(QUERY)}`)

    const searchCall = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/call' }> =>
        event.type === 'tool/call' && event.data.name === 'web_search',
    )
    if (searchCall === undefined) throw new Error('the replayed turn did not call web_search')
    const searchResult = sessionEvents.find(
      (event): event is Extract<SessionEvent, { type: 'tool/result' }> =>
        event.type === 'tool/result' && event.data.message.source.callId === searchCall.data.callId,
    )
    if (searchResult === undefined) throw new Error('web_search produced no durable result')
    const content = searchResult.data.message.content[0]
    expect(content.isError).toBe(false)
    const rendered = content.content.filter(block => block.type === 'text').map(block => block.text).join('')
    // The seam caps the provider's list at the shipped searchMaxResults before
    // the tool renders it, so the kept prefix is model-visible and the dropped
    // suffix is not.
    for (const ordinal of RESULT_ORDINALS.slice(0, WEB_SEARCH_MAX_RESULTS)) {
      expect(rendered).toContain(`[${resultTitle(ordinal)}](${resultUrl(ordinal)})`)
    }
    for (const ordinal of RESULT_ORDINALS.slice(WEB_SEARCH_MAX_RESULTS)) {
      expect(rendered).not.toContain(resultUrl(ordinal))
    }
    expect(rendered).toContain(
      `(Showing the first ${WEB_SEARCH_MAX_RESULTS} sources. Refine the query for more.)`,
    )
    expect(searchResult.data.meta).toMatchObject({
      sources: RESULT_ORDINALS.slice(0, WEB_SEARCH_MAX_RESULTS).map(ordinal => ({
        url: resultUrl(ordinal),
        title: resultTitle(ordinal),
        snippet: resultSnippet(ordinal),
        publishedAt: resultPageAge(ordinal),
      })),
      truncated: true,
    })
  })

  it.skipIf(MODE === 'record')('matches the settled search card aria golden', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-aria'))
    await expect.poll(() => page.getByText('SEARCH_DONE', { exact: true }).count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1)
    await page.locator('[data-tool="web_search"]').waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
  })

  it.skipIf(MODE === 'record')('scrolls the capped source list inside the fixed-height container', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-sources-scroll'))
    const row = page.locator('[data-tool="web_search"] [data-expandable]').first()
    await row.click()
    await expect.poll(() => row.getAttribute('aria-expanded'), { timeout: 5_000 }).toBe('true')

    const card = page.locator('[data-web="search"]')
    const sources = card.locator('ol')
    await sources.waitFor({ timeout: 10_000 })
    // The card draws exactly the sources the model saw: the seam's cap, not the
    // provider's list length.
    expect(await sources.locator('li').count()).toBe(WEB_SEARCH_MAX_RESULTS)
    // The list is complete in the DOM, so the card carries no expand control.
    expect(await card.locator('button').count()).toBe(0)
    expect(await card.getByText('来源列表已截断').isVisible()).toBe(true)

    const geometry = await sources.evaluate((element) => {
      const computed = getComputedStyle(element)
      return {
        maxHeight: computed.maxHeight,
        overflowY: computed.overflowY,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }
    })
    expect(geometry.maxHeight).toBe('320px')
    expect(geometry.overflowY).toBe('auto')
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight)
  })

  it.skipIf(MODE === 'record')('reserves marker room a scroll container cannot clip back', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-search-marker-room'))
    // `overflow-y: auto` clips inline-start overflow with no way to scroll it
    // back, and markers are right-aligned to the content edge, so a marker wider
    // than `padding-left` silently loses its leading digits. `searchMaxResults`
    // is an unbounded positive integer, so measure the widest three-digit marker
    // in the list's own font and require the shipped padding to hold it.
    const marker = await page.locator('[data-web="search"] ol').evaluate((element) => {
      const probe = document.createElement('span')
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit'
      probe.textContent = '999. '
      element.append(probe)
      const widest = probe.getBoundingClientRect().width
      probe.remove()
      return { widest, paddingLeft: parseFloat(getComputedStyle(element).paddingLeft) }
    })
    expect(marker.paddingLeft).toBeGreaterThanOrEqual(marker.widest)
  })

  it.skipIf(MODE === 'record')('stayed clean and kept the exact fixture inventory', async () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.jsonl', 'ui.expected.md'])
  })
})
