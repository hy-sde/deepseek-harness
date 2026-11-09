/**
 * Anonymous HTTP(S) `WebFetchProvider` plugin. It contributes to the
 * `ctx.web` registry without owning the service. When the host `browser`
 * service is mounted and `browserEscalation` is on, a response whose bot
 * protection answered is re-rendered through the browser once before the
 * blocked result is returned.
 *
 * @module @deepseek-ai/dsh-web-fetch-http
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { BROWSER_ESCALATION_TIMEOUT_MS, HttpFetchProvider } from './provider.ts'
import type { BrowserPageRenderer, HttpFetchEscalation, HttpFetchLimits } from './provider.ts'

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

export {
  BROWSER_ESCALATION_TIMEOUT_MS,
  LOCAL_FETCH_PROVIDER_ID,
  HttpFetchProvider,
} from './provider.ts'
export type { BrowserPageRenderer, HttpFetchEscalation, HttpFetchLimits } from './provider.ts'

/** Default `User-Agent`: an explicit product agent, never a browser disguise. */
export const DEFAULT_USER_AGENT = 'deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-http'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config: the provider's transport and size limits plus its `User-Agent` (all defaulted). */
export interface Config {
  /** Maximum response body size in bytes. */
  maxResponseBytes?: number
  /** Maximum decoded body length in characters. */
  maxBodyChars?: number
  /** Default fetch timeout in milliseconds, within Node's timer range. */
  timeoutMs?: number
  /** Maximum number of same-origin redirect hops to follow. */
  maxRedirects?: number
  /** `User-Agent` header sent on every request. */
  userAgent?: string
  /**
   * Re-render bot-protection-blocked responses through the host browser once
   * (needs the `browser` service mounted; without it, blocked results are
   * returned as-is).
   */
  browserEscalation?: boolean
}

export const Config: z<Config> = z.object({
  maxResponseBytes: z.number().default(5_000_000),
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(30_000),
  maxRedirects: z.number().default(5),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  browserEscalation: z.boolean().default(true),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** A resource limit (byte/char/length/timeout cap) must be a positive finite number. */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-http: ${name} must be a positive finite number`)
  }
}

/** Node coerces larger timer delays to 1 ms, so reject them at configuration time. */
function assertTimeoutMs(value: number): void {
  assertPositiveFinite('timeoutMs', value)
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-http: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
}

/** The redirect hop cap must be a non-negative integer (0 follows no redirects). */
function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`web-fetch-http: ${name} must be a non-negative integer`)
  }
}

/**
 * Browser escalation is optional: when the host `browser` service is mounted
 * (base bundle), a blocked fetch can re-render the URL through a real browser
 * via `fetchPageHtml`. Without it, blocked results are returned as-is. Resolved
 * at `apply` time — the base bundle mounts `browser` before this provider.
 */
function resolveBrowserRenderer(ctx: Context): BrowserPageRenderer | undefined {
  let browser: unknown
  try {
    browser = ctx.get('browser')
  } catch {
    return undefined
  }
  if (browser === null || browser === undefined) return undefined
  const service = browser as { fetchPageHtml?: BrowserPageRenderer }
  if (typeof service.fetchPageHtml !== 'function') return undefined
  const fetchPageHtml = service.fetchPageHtml
  return (url, options) => fetchPageHtml(url, options)
}

/** Register the local HTTP(S) fetch provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertTimeoutMs(resolved.timeoutMs)
  assertNonNegativeInteger('maxRedirects', resolved.maxRedirects)
  const limits: HttpFetchLimits = {
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxRedirects: resolved.maxRedirects,
    userAgent: resolved.userAgent,
  }
  let escalation: HttpFetchEscalation | undefined
  if (resolved.browserEscalation) {
    const render = resolveBrowserRenderer(ctx)
    if (render !== undefined) escalation = { render, timeoutMs: BROWSER_ESCALATION_TIMEOUT_MS }
  }
  ctx.web.registerFetchProvider(new HttpFetchProvider(limits, escalation))
}
