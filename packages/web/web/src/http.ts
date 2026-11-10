/**
 * Shared bounded HTTP(S) transport for the web lane. The fetch provider
 * (`web-fetch-http`) and the search engines' plain fetches
 * (`web-search-public/engines/http`) issue their requests through one function
 * so redirect handling, byte caps, and body reads cannot drift between lanes.
 *
 * Requests go through the runtime's global `fetch`, so the process-wide
 * dispatcher (installed proxy policy) applies. A redirect target that violates
 * the configured {@link HttpRedirectPolicy} is never contacted. Policy
 * violations throw {@link WebError}; transport failures (network error, abort,
 * timeout) propagate raw for each lane to translate into its own taxonomy.
 * @module @deepseek-ai/dsh-web/http
 */

import { WebError } from './types.ts'

/** How the transport answers a redirect response. */
export type HttpRedirectPolicy =
  | {
    /** Reject the redirect response itself; no `Location` target is contacted. */
    readonly mode: 'reject'
  }
  | {
    /**
     * Follow the redirect chain while every target stays on the current origin.
     * A 301/302/303 answer to a POST downgrades the next hop to a bodyless GET;
     * 307/308 keep the request verbatim.
     */
    readonly mode: 'same-origin'
    /** Maximum redirect hops; the next hop past the cap throws `WEB_REDIRECT_BLOCKED`. */
    readonly maxRedirects: number
    /**
     * Validate (and may normalize) each redirect target before it is contacted.
     * Throwing from this hook refuses the redirect; a same-origin violation is
     * checked after this hook regardless.
     */
    readonly validateTarget?: (target: URL) => URL
  }

/** Options for one page fetch. */
export interface HttpFetchPageOptions {
  /** Absolute http(s) URL to request; the caller owns validation. */
  readonly url: string | URL
  /** Request method; default `GET`. */
  readonly method?: 'GET' | 'POST'
  /** Request body (for `POST`). */
  readonly body?: string
  /** Request headers; a 301/302/303 POST downgrade also drops `Content-Type` on later hops. */
  readonly headers?: Readonly<Record<string, string>>
  /** Cancellation signal for the whole request-and-read. */
  readonly signal?: AbortSignal
  /** Redirect handling policy. */
  readonly redirect: HttpRedirectPolicy
  /**
   * Cap the response body at this many bytes. A `Content-Length` over the cap
   * rejects with `WEB_FETCH_TOO_LARGE`; a stream that grows past the cap is cut
   * and reported through {@link HttpFetchedPage.truncatedByBytes}. Omitted =
   * unbounded.
   */
  readonly maxBytes?: number
}

/** One fetched page: final response metadata plus raw body bytes. */
export interface HttpFetchedPage {
  /** Status of the final (non-redirect) response. */
  readonly status: number
  /** Headers of the final response. */
  readonly headers: Headers
  /** URL the final response was served from (the last requested URL). */
  readonly finalUrl: string
  /** Body bytes, cut to `maxBytes` when that cap applied. */
  readonly bytes: Uint8Array
  /** True when the body ran past `maxBytes` and was cut. */
  readonly truncatedByBytes: boolean
}

/**
 * Fetch one page through the shared transport.
 *
 * @param options - the request, its redirect policy, and the optional byte cap.
 * @returns the final response with its raw body bytes.
 * @throws {@link WebError} for a redirect-policy violation or an over-cap
 *   `Content-Length`; transport failures propagate raw.
 */
export async function httpFetchPage(options: HttpFetchPageOptions): Promise<HttpFetchedPage> {
  if (options.redirect.mode === 'reject') {
    // `redirect: 'error'` rejects the fetch itself on a redirect response, so no
    // `Location` target is ever contacted.
    const response = await rawFetch(options.url, hopRequest(options), options.signal, 'error')
    return await readPage(response, response.url, options.maxBytes)
  }

  const maxRedirects = options.redirect.maxRedirects
  const validateTarget = options.redirect.validateTarget
  let currentUrl = options.url instanceof URL ? options.url : new URL(options.url)
  let redirectsFollowed = 0
  let hop = hopRequest(options)

  for (;;) {
    const response = await rawFetch(currentUrl, hop, options.signal, 'manual')
    if (!isRedirectStatus(response.status)) {
      return await readPage(response, currentUrl.toString(), options.maxBytes)
    }
    // Enforce the redirect budget before resolving the next hop.
    if (redirectsFollowed >= maxRedirects) {
      await response.body?.cancel()
      throw new WebError(`exceeded the maximum of ${maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
    }
    const location = response.headers.get('location')
    if (location === null) {
      await response.body?.cancel()
      throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
    }
    let target: URL
    try {
      target = new URL(location, currentUrl)
    } catch (error: unknown) {
      /* v8 ignore next 3 -- resolution against a valid absolute base effectively never throws; defensive guard. */
      await response.body?.cancel()
      throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    try {
      const validated = validateTarget !== undefined ? validateTarget(target) : target
      if (!isSameOrigin(validated, currentUrl)) {
        throw new WebError(
          `cross-origin redirect to ${validated.origin} is not followed automatically; retry against that URL directly`,
          'WEB_REDIRECT_BLOCKED',
        )
      }
      currentUrl = validated
    } catch (error: unknown) {
      await response.body?.cancel()
      throw error
    }
    await response.body?.cancel()
    // A 301/302/303 answer to a POST downgrades the next hop to a bodyless GET
    // (307/308 keep the request verbatim), matching undici's
    // `redirect: 'follow'`; form data is never re-POSTed to the redirect target.
    if ((response.status === 301 || response.status === 302 || response.status === 303) && hop.method === 'POST') {
      const headers = dropHeader(hop.headers, 'content-type')
      hop = { method: 'GET', ...(headers !== undefined ? { headers } : {}) }
    }
    redirectsFollowed++
  }
}

/** Per-hop request fields; a 301/302/303 POST downgrade rewrites them between hops. */
interface HopRequest {
  method: 'GET' | 'POST'
  body?: string
  headers?: Readonly<Record<string, string>>
}

/** Initial request fields derived from the caller's options. */
function hopRequest(options: HttpFetchPageOptions): HopRequest {
  return {
    method: options.method ?? 'GET',
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
  }
}

/** Return the headers without the named one (case-insensitive); `undefined` passes through. */
function dropHeader(headers: Readonly<Record<string, string>> | undefined, name: string): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) return undefined
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) kept[key] = value
  }
  return kept
}

/** Send one request with the transport's fixed shape through the global fetch. */
async function rawFetch(url: string | URL, hop: HopRequest, signal: AbortSignal | undefined, redirect: 'error' | 'manual'): Promise<Response> {
  return await fetch(url, {
    method: hop.method,
    ...(hop.body !== undefined ? { body: hop.body } : {}),
    ...(hop.headers !== undefined ? { headers: hop.headers } : {}),
    ...(signal !== undefined ? { signal } : {}),
    redirect,
  })
}

/** Read the final response body under the byte cap (see {@link HttpFetchPageOptions.maxBytes}). */
async function readPage(response: Response, finalUrl: string, maxBytes: number | undefined): Promise<HttpFetchedPage> {
  const declared = response.headers.get('content-length')
  if (maxBytes !== undefined && declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel()
      throw new WebError(`response exceeds the maximum of ${maxBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
    }
  }

  /* v8 ignore next -- a 2xx Response from fetch always exposes a body stream; the null guard is defensive. */
  if (response.body === null) {
    return { status: response.status, headers: response.headers, finalUrl, bytes: new Uint8Array(0), truncatedByBytes: false }
  }

  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Uint8Array[] = []
  let total = 0
  let truncatedByBytes = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = (maxBytes ?? Number.POSITIVE_INFINITY) - total
      // Only DROPPED bytes count as truncation: a chunk that exactly fills the
      // remaining capacity keeps all its bytes and we read on to observe EOF,
      // so an exactly-at-cap body is not falsely flagged truncated.
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining))
        total += remaining
        truncatedByBytes = true
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed/broken read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a successful read (or after we broke past the cap) is
      // best-effort cleanup; the bytes we need are already collected.
    })
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { status: response.status, headers: response.headers, finalUrl, bytes, truncatedByBytes }
}

/** HTTP redirect status codes that carry a `Location`. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * Two URLs are same-origin when scheme, hostname, and port match. A redirect
 * that crosses origins is refused so each new origin requires a fresh request.
 */
function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}
