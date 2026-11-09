import { describe, expect, it } from 'vitest'
import { DeepSeekFetchApiProvider, DeepSeekSearchApiProvider } from '@deepseek-ai/dsh-web-deepseek-api'
import type { WebFetchBody } from '@deepseek-ai/dsh-web'

/** Real Search and Fetch API probes; the base names the deployment the key authenticates. */
const apiKey = process.env.DEEPSEEK_API_KEY
const baseURL = process.env.DEEPSEEK_SEARCH_API_TEST_BASE_URL ?? ''
const maybe = apiKey !== undefined && apiKey.length > 0 && baseURL.length > 0 ? describe : describe.skip

/** Narrows a fetch body to its text content; blocked bodies carry no page content. */
function contentOf(body: WebFetchBody): string {
  return body.kind === 'blocked' ? '' : body.content
}

maybe('DeepSeek Search and Fetch real API', () => {
  it('returns citeable sources from the Search API', async () => {
    const provider = new DeepSeekSearchApiProvider(() => ({ apiKey: apiKey!, baseURL, count: 10 }))
    const result = await provider.search({ query: 'DeepSeek', maxResults: 3 }, AbortSignal.timeout(30_000))
    expect(result.sources.length).toBeGreaterThan(0)
    expect(result.sources.length).toBeLessThanOrEqual(3)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 40_000)

  it('returns Markdown from the Fetch API', async () => {
    const provider = new DeepSeekFetchApiProvider(() => ({ apiKey: apiKey!, baseURL }))
    const result = await provider.fetch({ url: 'https://example.com' }, AbortSignal.timeout(30_000))
    expect(result.body.kind).toBe('text')
    expect(contentOf(result.body).length).toBeGreaterThan(0)
    expect(result.statusCode).toBe(200)
  }, 40_000)
})
