/**
 * Detection of bot-protection walls in fetched HTML responses. One scan answers
 * "which protection answered this response" for both the fetch lane
 * (`web-fetch-http`) and the search lane (`web-search-public`), so escalation
 * and rendering decisions share one vocabulary.
 *
 * The challenge-form check is a size-gated text approximation, not a parse: this
 * package has no HTML parser (its only runtime dependency is `schemastery`).
 * Comments, raw-text bodies, and `<template>` bodies are stripped before
 * matching `<input>` tags, which removes the common false positives of a form
 * field quoted in a comment, script, style, or template, but a tag-shaped string
 * inside another tag's attribute value would still count. Real interstitials
 * are machine-generated and do not do that.
 * @module @deepseek-ai/dsh-web/challenge
 */

/** Body length (characters) up to which the challenge-form check runs. */
export const CHALLENGE_PAGE_MAX_CHARS = 64 * 1024

/** How a challenged response was identified. */
export type ChallengeSource =
  | 'cf-mitigated-header'
  | 'challenge-form'
  | 'page-marker'

/** One identified bot-protection wall. */
export interface ChallengeVerdict {
  /** Protection name as shown to the model, e.g. `Cloudflare` or `DataDome`. */
  readonly protection: string
  /** The response evidence that identified the page. */
  readonly source: ChallengeSource
}

/** The parts of an HTTP response the scan reads. */
export interface ChallengePageInput {
  /** HTTP status code of the response carrying `body`. */
  readonly status: number
  /** Decoded body text; decoding and byte caps are the caller's concern. */
  readonly body: string
  /** Value of the `cf-mitigated` response header, when present. */
  readonly cfMitigated?: string | null
  /** Raw `Content-Type` header value; only HTML media types are scanned. */
  readonly contentType?: string | null
}

/** Vendor body markers, trusted only on non-2xx responses, checked in this order. */
const PAGE_MARKERS = [
  { text: '_cf_chl_opt', protection: 'Cloudflare' },
  { text: 'captcha-delivery.com', protection: 'DataDome' },
  { text: 'px-captcha', protection: 'PerimeterX' },
  { text: 'blocked by network security', protection: 'network security block' },
] as const

/**
 * Name the bot protection whose wall or challenge page this HTML response is,
 * or `undefined` when the response looks like an ordinary page.
 *
 * Anti-false-positive rule: on a 2xx response only the `cf-mitigated: challenge`
 * header and a live challenge form may name a protection, because vendor
 * markers also appear in ordinary articles that quote or embed them; markers
 * are trusted only on non-2xx responses. The form check is additionally
 * size-gated — a challenge interstitial carries no content (well under this
 * package's {@link CHALLENGE_PAGE_MAX_CHARS} gate), so a larger page is a real
 * document, not a wall.
 *
 * @param input - the response status, decoded body, and the two headers read.
 * @returns the verdict, or `undefined` when the page is not a protection wall.
 */
export function scanChallengePage(input: ChallengePageInput): ChallengeVerdict | undefined {
  if (input.contentType?.toLowerCase().includes('html') !== true) return undefined
  if (input.cfMitigated?.toLowerCase() === 'challenge') {
    return { protection: 'Cloudflare', source: 'cf-mitigated-header' }
  }
  if (hasChallengeForm(input.body)) return { protection: 'JavaScript challenge', source: 'challenge-form' }
  if (input.status >= 200 && input.status < 300) return undefined
  for (const marker of PAGE_MARKERS) {
    if (input.body.includes(marker.text)) {
      return { protection: marker.protection, source: 'page-marker' }
    }
  }
  return undefined
}

/** The form field name a challenge interstitial submits. */
const CHALLENGE_FORM_VALUE = 'js_challenge'

/** Opening `<input …>` tags; a truncated tag without `>` does not match. */
const INPUT_TAG_RE = /<input\b[^>]*>/gi

/** The `name` attribute of an input tag: double-quoted, single-quoted, or bare. The
 *  leading whitespace requirement rejects look-alikes such as `data-name`. */
const INPUT_NAME_RE = /(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>/]+))/i

const COMMENT_RE = /<!--[\s\S]*?-->/g
const TEMPLATE_RE = /<template\b[^>]*>[\s\S]*?<\/template\s*>/gi
const RAW_TEXT_RE = /<(script|style|noscript|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
const ENTITY_RE = /&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  'amp': '&',
  'lt': '<',
  'gt': '>',
  'quot': '"',
  'apos': "'",
}

/**
 * Whether `body` contains a live `<input name="js_challenge">` form field.
 * Runs only up to {@link CHALLENGE_PAGE_MAX_CHARS}; strips comments, template
 * bodies, and raw-text bodies first; and compares the entity-decoded attribute
 * value, so a quoted-in-comment or quoted-in-script field does not count.
 */
function hasChallengeForm(body: string): boolean {
  if (body.length > CHALLENGE_PAGE_MAX_CHARS) return false
  const stripped = body.replace(COMMENT_RE, '').replace(TEMPLATE_RE, '').replace(RAW_TEXT_RE, '')
  for (const tag of stripped.matchAll(INPUT_TAG_RE)) {
    const name = INPUT_NAME_RE.exec(tag[0])
    if (name !== null && decodeEntities(name[1] ?? name[2] ?? name[3] ?? '') === CHALLENGE_FORM_VALUE) {
      return true
    }
  }
  return false
}

/** Decode the numeric and named character references the attribute check needs. */
function decodeEntities(value: string): string {
  return value.replace(ENTITY_RE, (_match: string, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16))
    if (decimal !== undefined) return fromCodePoint(Number.parseInt(decimal, 10))
    return NAMED_ENTITIES[named ?? ''] ?? _match
  })
}

/** The character a code point denotes, or `''` for a value outside Unicode range. */
function fromCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ''
}
