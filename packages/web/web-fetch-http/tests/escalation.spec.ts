import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { HttpFetchProvider, type BrowserPageRenderer, type HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let base: string
let handler: Handler

beforeEach(async () => {
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('default') }
  server = createServer((req, res) => { handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => { resolve() }))
})

const limits: HttpFetchLimits = {
  maxResponseBytes: 5_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  userAgent: 'test-agent/1.0',
}

function challengeFormHandler(): void {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<form method="post"><input type="hidden" name="js_challenge" value="1"></form>')
  }
}

const BLOCKED = {
  kind: 'blocked',
  protection: 'JavaScript challenge',
  detail: 'a live js_challenge form field on a small interstitial page',
}

describe('HttpFetchProvider browser escalation', () => {
  it('re-renders a blocked challenge through the browser and returns the rendered page', async () => {
    challengeFormHandler()
    const seenUrls: string[] = []
    const render: BrowserPageRenderer = (url) => {
      seenUrls.push(url)
      return Promise.resolve({ html: '<p>rendered page</p>', status: 200, url: `${base}/rendered` })
    }
    const provider = new HttpFetchProvider(limits, { render, timeoutMs: 1_000 })
    await expect(provider.fetch({ url: `${base}/` })).resolves.toEqual({
      url: `${base}/rendered`,
      statusCode: 200,
      body: { kind: 'html', content: '<p>rendered page</p>' },
      truncated: false,
    })
    expect(seenUrls).toEqual([`${base}/`])
  })

  it('escalates a non-2xx blocked wall page as well', async () => {
    handler = (_req, res) => { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<script>window._cf_chl_opt = {}</script>') }
    const render: BrowserPageRenderer = () => Promise.resolve({ html: '<p>through the wall</p>', status: 200, url: `${base}/rendered` })
    const provider = new HttpFetchProvider(limits, { render, timeoutMs: 1_000 })
    await expect(provider.fetch({ url: `${base}/` })).resolves.toMatchObject({
      statusCode: 200,
      body: { kind: 'html', content: '<p>through the wall</p>' },
    })
  })

  it('falls back to the blocked result when the rendered page is still a challenge', async () => {
    challengeFormHandler()
    const render: BrowserPageRenderer = () => Promise.resolve({
      html: '<form><input type="hidden" name="js_challenge" value="1"></form>',
      status: 200,
      url: `${base}/rendered`,
    })
    const provider = new HttpFetchProvider(limits, { render, timeoutMs: 1_000 })
    await expect(provider.fetch({ url: `${base}/` })).resolves.toEqual({
      url: `${base}/`,
      statusCode: 200,
      body: BLOCKED,
      truncated: false,
    })
  })

  it('falls back to the blocked result when the browser render fails', async () => {
    challengeFormHandler()
    const render: BrowserPageRenderer = () => Promise.reject(new Error('browser navigation failed'))
    const provider = new HttpFetchProvider(limits, { render, timeoutMs: 1_000 })
    await expect(provider.fetch({ url: `${base}/` })).resolves.toEqual({
      url: `${base}/`,
      statusCode: 200,
      body: BLOCKED,
      truncated: false,
    })
  })

  it('falls back to the blocked result when the escalation deadline fires', async () => {
    challengeFormHandler()
    const render: BrowserPageRenderer = () => new Promise(() => { /* never settles */ })
    const provider = new HttpFetchProvider(limits, { render, timeoutMs: 50 })
    await expect(provider.fetch({ url: `${base}/` })).resolves.toEqual({
      url: `${base}/`,
      statusCode: 200,
      body: BLOCKED,
      truncated: false,
    })
  })

  it('propagates WEB_ABORTED when the caller aborts during escalation', async () => {
    challengeFormHandler()
    const render: BrowserPageRenderer = () => new Promise(() => { /* never settles */ })
    const provider = new HttpFetchProvider(limits, { render, timeoutMs: 5_000 })
    const controller = new AbortController()
    const promise = provider.fetch({ url: `${base}/` }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    await expect(promise).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('propagates WEB_FETCH_TIMEOUT when the fetch deadline fires during escalation', async () => {
    challengeFormHandler()
    const render: BrowserPageRenderer = () => new Promise(() => { /* never settles */ })
    const provider = new HttpFetchProvider({ ...limits, timeoutMs: 80 }, { render, timeoutMs: 5_000 })
    await expect(provider.fetch({ url: `${base}/` }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TIMEOUT' }))
  })

  it('returns the blocked result as-is without an escalation renderer', async () => {
    challengeFormHandler()
    const provider = new HttpFetchProvider(limits)
    await expect(provider.fetch({ url: `${base}/` })).resolves.toEqual({
      url: `${base}/`,
      statusCode: 200,
      body: BLOCKED,
      truncated: false,
    })
  })

  it('caps the rendered html at maxBodyChars and reports truncation', async () => {
    challengeFormHandler()
    const rendered = `<p>${'x'.repeat(300)}</p>`
    const render: BrowserPageRenderer = () => Promise.resolve({ html: rendered, status: 200, url: `${base}/rendered` })
    const provider = new HttpFetchProvider({ ...limits, maxBodyChars: 100 }, { render, timeoutMs: 1_000 })
    await expect(provider.fetch({ url: `${base}/` })).resolves.toEqual({
      url: `${base}/rendered`,
      statusCode: 200,
      body: { kind: 'html', content: rendered.slice(0, 100) },
      truncated: true,
    })
  })
})
