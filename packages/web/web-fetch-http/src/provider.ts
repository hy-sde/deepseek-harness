/**
 * Bounded HTTP(S) retrieval for `ctx.web`: validates URLs, follows only same-origin redirects,
 * enforces time and size limits, classifies and decodes text, and leaves presentation to
 * `@deepseek-ai/dsh-tool-web`. Requests carry no browser cookies
 * or ambient credentials.
 *
 * A response whose bot protection answered instead of the page (see
 * `scanChallengePage` in `@deepseek-ai/dsh-web`) becomes a `blocked` body, and —
 * when a browser escalation is configured — the provider re-renders the URL
 * through the host browser before giving up.
 * @module @deepseek-ai/dsh-web-fetch-http/provider
 */

import { httpFetchPage, scanChallengePage, WebError } from '@deepseek-ai/dsh-web'
import type { ChallengeSource, HttpFetchedPage, WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { classifyContentType, decoderForCharset, parseCharset, validateFetchUrl } from './policy.ts'

/** Resolved provider limits (the plugin's schemastery Config supplies defaults). */
export interface HttpFetchLimits {
  /** Maximum response body size in bytes (read is aborted past this). */
  maxResponseBytes: number
  /** Maximum decoded body length in characters (truncated past this). */
  maxBodyChars: number
  /** Default fetch timeout in milliseconds. */
  timeoutMs: number
  /** Maximum number of (same-origin) redirect hops to follow. */
  maxRedirects: number
  /** `User-Agent` header sent on every request. */
  userAgent: string
}

/**
 * Options the provider passes to a browser renderer. Only the cancellation
 * signal flows through: the escalation deadline lives on the provider side.
 */
export interface BrowserRenderOptions {
  /** Cancellation signal for the render. */
  readonly signal?: AbortSignal
}

/**
 * Render one URL through a real browser, duck-typed from the host `browser`
 * service's `fetchPageHtml` (the same seam the public search engines use).
 */
export type BrowserPageRenderer = (url: string, options?: BrowserRenderOptions) => Promise<{ html: string; status: number; url: string }>

/**
 * Browser escalation for a blocked fetch: when bot protection answers a plain
 * HTTP(S) fetch, the provider re-renders the URL through the host browser once.
 */
export interface HttpFetchEscalation {
  /** The duck-typed browser page renderer. */
  readonly render: BrowserPageRenderer
  /** Deadline for one escalation render, in milliseconds. */
  readonly timeoutMs: number
}

/** Default escalation deadline; matches the browser service's own page timeout. */
export const BROWSER_ESCALATION_TIMEOUT_MS = 30_000

/** Why a response was classified as bot protection, as model-facing evidence text. */
const BLOCKED_DETAIL: Record<ChallengeSource, string> = {
  'cf-mitigated-header': 'the cf-mitigated: challenge response header',
  'challenge-form': 'a live js_challenge form field on a small interstitial page',
  'page-marker': 'a bot-wall marker in the response body',
}

/** Stable id this provider registers under. */
export const LOCAL_FETCH_PROVIDER_ID = 'http'

/** The anonymous HTTP(S) fetch provider. */
export class HttpFetchProvider implements WebFetchProvider {
  readonly id = LOCAL_FETCH_PROVIDER_ID

  /**
   * @param limits - resolved transport and response limits.
   * @param escalation - browser escalation for blocked responses; omitted =
   *   a blocked body is returned as-is.
   */
  constructor(
    private readonly limits: HttpFetchLimits,
    private readonly escalation?: HttpFetchEscalation,
  ) {}

  /** No credentials to check — an anonymous fetcher is always usable. */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')

    // One signal stops both the request and body read. The deadline's TimeoutReason later
    // distinguishes this provider's timeout from caller or outer-deadline cancellation.
    using d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    const page = await this.followAndRead(request.url, d.signal)
    const result = this.readBody(page)
    if (result.body.kind !== 'blocked') return result
    if (this.escalation === undefined) return result
    return await this.escalateViaBrowser(request.url, result, d.signal)
  }

  /** Fetch the page through the shared transport, then translate transport failures. */
  private async followAndRead(initialUrl: string, signal: AbortSignal): Promise<HttpFetchedPage> {
    // Pre-validate like a direct request: the transport requires a parseable URL
    // and would surface policy violations as raw TypeErrors instead of WebErrors.
    validateFetchUrl(initialUrl)
    try {
      return await httpFetchPage({
        url: initialUrl,
        headers: {
          'user-agent': this.limits.userAgent,
          'accept': 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
        },
        signal,
        redirect: { mode: 'same-origin', maxRedirects: this.limits.maxRedirects, validateTarget: target => validateFetchUrl(target.toString()) },
        maxBytes: this.limits.maxResponseBytes,
      })
    } catch (error: unknown) {
      if (error instanceof WebError) throw error
      throw translateAbortOrNetwork(error, signal)
    }
  }

  /** Decode the fetched bytes, classify the body, and detect bot-protection responses. */
  private readBody(page: HttpFetchedPage): WebFetchResult {
    const contentType = page.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }

    const decoder = decoderForCharset(parseCharset(contentType))
    let decoded: string
    try {
      // Only a real byte-cap truncation permits an incomplete UTF-8 suffix.
      decoded = decoder.decode(page.bytes, { stream: decoder.fatal && page.truncatedByBytes })
    } catch (error: unknown) {
      throw new WebError(
        'response body is not valid UTF-8 for the malformed charset declaration',
        'WEB_UNSUPPORTED_CONTENT_TYPE',
        { cause: error },
      )
    }
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded

    // Bot-protection scan runs on the full decoded body before the char cap:
    // wall markers near the end of a long page still identify the protection.
    const verdict = scanChallengePage({
      status: page.status,
      body: decoded,
      cfMitigated: page.headers.get('cf-mitigated'),
      contentType,
    })
    const body: WebFetchBody = verdict !== undefined
      ? { kind: 'blocked', protection: verdict.protection, detail: BLOCKED_DETAIL[verdict.source] }
      : kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

    return {
      url: page.finalUrl,
      statusCode: page.status,
      body,
      truncated: page.truncatedByBytes || truncatedByChars,
    }
  }

  /**
   * Re-render a blocked URL through the host browser once. Any escalation
   * failure — navigation error, escalation deadline, renderer rejection — falls
   * back to the blocked result so the protection verdict is never masked; only
   * caller cancellation and this provider's own fetch deadline fail the call.
   */
  private async escalateViaBrowser(requestUrl: string, blocked: WebFetchResult, signal: AbortSignal): Promise<WebFetchResult> {
    const escalation = this.escalation
    if (escalation === undefined) return blocked
    using e = deadline(signal, escalation.timeoutMs, 'WEB_FETCH_ESCALATION_TIMEOUT')
    try {
      const rendered = await raceAbort(escalation.render(requestUrl, { signal: e.signal }), e.signal)
      // The rendered page must itself be a real page: a browser that lands on
      // another challenge did not get through either.
      const verdict = scanChallengePage({ status: rendered.status, body: rendered.html, contentType: 'text/html' })
      if (verdict !== undefined) return blocked
      const truncatedByChars = rendered.html.length > this.limits.maxBodyChars
      const content = truncatedByChars ? rendered.html.slice(0, this.limits.maxBodyChars) : rendered.html
      return {
        url: rendered.url,
        statusCode: rendered.status,
        body: { kind: 'html', content },
        truncated: truncatedByChars,
      }
    } catch (error: unknown) {
      // Inspect the fetch deadline's signal, not the escalation deadline's: an
      // escalation timeout falls back to the blocked result, while a caller
      // cancel or a fired fetch deadline fails the call.
      if (signal.aborted) throw translateAbortOrNetwork(error, signal)
      return blocked
    }
  }
}

/**
 * Settle with `promise` unless `signal` aborts first, then reject with the
 * abort reason. The provider owns its deadlines: a renderer that ignores its
 * signal must not hang the fetch past the escalation budget.
 */
async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted')) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Translate a thrown fetch/stream error into a `WebError`, classified by the
 * deadline signal rather than the thrown value (which differs by phase: the
 * request-phase `fetch` rejects with the abort reason, while the read-phase
 * reader surfaces a bare `AbortError`). `timeoutOf(signal, 'WEB_FETCH_TIMEOUT')`
 * recovering OUR reason means our timeout fired (`WEB_FETCH_TIMEOUT`); any other
 * abort — an upstream cancel, or a foreign/outer deadline's timeout under
 * nesting — is `WEB_ABORTED`; a throw with the signal NOT aborted is a
 * transport/network failure (`WEB_PROVIDER_ERROR`).
 */
function translateAbortOrNetwork(error: unknown, signal: AbortSignal): WebError {
  const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
