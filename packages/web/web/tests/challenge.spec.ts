import { describe, expect, it } from 'vitest'
import { CHALLENGE_PAGE_MAX_CHARS, scanChallengePage } from '@deepseek-ai/dsh-web'

const html = '<!doctype html><html><body>hello</body></html>'

function scan(status: number, body: string, options: { cfMitigated?: string | null; contentType?: string | null } = {}) {
  return scanChallengePage({
    status,
    body,
    ...(options.cfMitigated !== undefined ? { cfMitigated: options.cfMitigated } : {}),
    ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
  })
}

describe('scanChallengePage', () => {
  it('returns undefined for a clean 2xx page', () => {
    expect(scan(200, html)).toBeUndefined()
  })

  it('names Cloudflare from the cf-mitigated header on a 2xx response', () => {
    expect(scan(200, html, { cfMitigated: 'challenge', contentType: 'text/html' })).toEqual({
      protection: 'Cloudflare',
      source: 'cf-mitigated-header',
    })
  })

  it('matches the cf-mitigated header value case-insensitively', () => {
    expect(scan(200, html, { cfMitigated: 'CHALLENGE', contentType: 'text/html' })?.protection).toBe('Cloudflare')
  })

  it('ignores a non-challenge cf-mitigated value', () => {
    expect(scan(200, html, { cfMitigated: 'managed', contentType: 'text/html' })).toBeUndefined()
  })

  it('detects a live js_challenge form on a small 2xx page', () => {
    const page = '<form><input type="hidden" name="js_challenge" value="1"></form>'
    expect(scan(200, page, { contentType: 'text/html' })).toEqual({ protection: 'JavaScript challenge', source: 'challenge-form' })
  })

  it('decodes entity-encoded form names', () => {
    expect(scan(200, '<input name="&#106;s_challenge">', { contentType: 'text/html' })).toEqual({ protection: 'JavaScript challenge', source: 'challenge-form' })
    expect(scan(200, '<input name="&#x6a;s_challenge">', { contentType: 'text/html' })).toEqual({ protection: 'JavaScript challenge', source: 'challenge-form' })
  })

  it('does not count a form inside a comment', () => {
    expect(scan(200, '<!-- <input name="js_challenge"> -->', { contentType: 'text/html' })).toBeUndefined()
  })

  it('does not count a form inside script/style raw text', () => {
    expect(scan(200, '<script>const x = "<input name=\'js_challenge\'>"</script>', { contentType: 'text/html' })).toBeUndefined()
    expect(scan(200, '<style>[name="js_challenge"] { color: red }</style>', { contentType: 'text/html' })).toBeUndefined()
  })

  it('does not count a form inside a template', () => {
    expect(scan(200, '<template><input name="js_challenge"></template>', { contentType: 'text/html' })).toBeUndefined()
  })

  it('does not treat data-name as the name attribute', () => {
    expect(scan(200, '<input data-name="js_challenge">', { contentType: 'text/html' })).toBeUndefined()
  })

  it('applies the interstitial size gate to the form check', () => {
    const big = `<div>${'x'.repeat(CHALLENGE_PAGE_MAX_CHARS)}</div><input name="js_challenge">`
    expect(big.length).toBeGreaterThan(CHALLENGE_PAGE_MAX_CHARS)
    expect(scan(200, big, { contentType: 'text/html' })).toBeUndefined()
  })

  it('keeps the form check under the size gate exact-boundary behavior', () => {
    const exact = `${'x'.repeat(CHALLENGE_PAGE_MAX_CHARS - '<input name="js_challenge">'.length)}<input name="js_challenge">`
    expect(exact.length).toBe(CHALLENGE_PAGE_MAX_CHARS)
    expect(scan(200, exact, { contentType: 'text/html' })).toEqual({ protection: 'JavaScript challenge', source: 'challenge-form' })
  })

  it('never names body markers on a 2xx response (anti-false-positive rule)', () => {
    expect(scan(200, html + ' _cf_chl_opt px-captcha captcha-delivery.com', { contentType: 'text/html' })).toBeUndefined()
  })

  it('names body markers on non-2xx responses in omp order', () => {
    expect(scan(403, 'window._cf_chl_opt = {}', { contentType: 'text/html' })).toEqual({ protection: 'Cloudflare', source: 'page-marker' })
    expect(scan(403, 'iframe src="https://captcha-delivery.com"', { contentType: 'text/html' })).toEqual({ protection: 'DataDome', source: 'page-marker' })
    expect(scan(429, '<div id="px-captcha">', { contentType: 'text/html' })).toEqual({ protection: 'PerimeterX', source: 'page-marker' })
    expect(scan(403, 'blocked by network security', { contentType: 'text/html' })).toEqual({ protection: 'network security block', source: 'page-marker' })
  })

  it('prefers the first marker when several appear', () => {
    expect(scan(403, 'px-captcha captcha-delivery.com _cf_chl_opt', { contentType: 'text/html' })?.protection).toBe('Cloudflare')
  })

  it('lets the challenge form outrank body markers on a non-2xx response', () => {
    expect(scan(403, '<input name="js_challenge"> _cf_chl_opt', { contentType: 'text/html' })).toEqual({ protection: 'JavaScript challenge', source: 'challenge-form' })
  })

  it('returns undefined for a non-2xx page without markers', () => {
    expect(scan(403, html, { contentType: 'text/html' })).toBeUndefined()
  })

  it('only scans html content types', () => {
    expect(scan(403, '_cf_chl_opt', { contentType: 'application/json' })).toBeUndefined()
    expect(scan(403, '_cf_chl_opt', { contentType: null })).toBeUndefined()
    expect(scan(403, '_cf_chl_opt', { contentType: 'text/html; charset=utf-8' })?.protection).toBe('Cloudflare')
  })

  it('treats 3xx statuses as non-2xx for the marker rule', () => {
    expect(scan(302, '_cf_chl_opt', { contentType: 'text/html' })?.protection).toBe('Cloudflare')
  })
})
