/**
 * Shared anonymous HTML fetch used by the credential-free engines. Delegates
 * transport to the shared `httpFetchPage` in `@deepseek-ai/dsh-web` with a
 * reject-before-contact redirect policy (the web-package AGENTS.md rule).
 * @module @deepseek-ai/dsh-web-search-public/engines/http
 */

import { httpFetchPage } from '@deepseek-ai/dsh-web'

/** Upper bound for one engine page. Search result pages stay far below this; the cap only stops a runaway response. */
export const ENGINE_PAGE_MAX_BYTES = 10 * 1024 * 1024

export interface FetchHtmlOptions {
  url: string
  method?: 'GET' | 'POST'
  /** Form-encoded request body (POST only). */
  body?: string
  /** Extra headers merged over the base set. */
  headers?: Readonly<Record<string, string>>
  userAgent: string
  signal?: AbortSignal | undefined
}

/**
 * Fetch and return the response body text. Redirects are rejected before any
 * `Location` target is contacted (the web-package AGENTS.md rule); a non-2xx
 * response fails. Errors carry a short human-readable message for the chain's
 * failure aggregate.
 */
export async function fetchHtml(options: FetchHtmlOptions): Promise<string> {
  const headers: Record<string, string> = {
    'user-agent': options.userAgent,
    accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
    'accept-language': 'en-US,en;q=0.8',
    ...options.headers,
  }
  if (options.method === 'POST' && options.body !== undefined && !('content-type' in headers)) {
    headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
  }
  const page = await httpFetchPage({
    url: options.url,
    ...(options.method !== undefined ? { method: options.method } : {}),
    ...(options.body !== undefined ? { body: options.body } : {}),
    headers,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    redirect: { mode: 'reject' },
    maxBytes: ENGINE_PAGE_MAX_BYTES,
  })
  if (page.status < 200 || page.status >= 300) throw new Error(`HTTP ${page.status}`)
  return new TextDecoder('utf-8').decode(page.bytes)
}
