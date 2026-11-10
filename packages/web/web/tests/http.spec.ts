import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { httpFetchPage, WebError } from '@deepseek-ai/dsh-web'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let base: string
let handler: Handler
const hits: string[] = []

beforeEach(async () => {
  hits.length = 0
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('default') }
  server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => { resolve() }))
})

function text(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

describe('httpFetchPage', () => {
  it('returns the final response page', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>hi</p>') }
    const page = await httpFetchPage({ url: `${base}/a`, redirect: { mode: 'reject' } })
    expect(page.status).toBe(200)
    expect(page.finalUrl).toBe(`${base}/a`)
    expect(text(page.bytes)).toBe('<p>hi</p>')
    expect(page.headers.get('content-type')).toBe('text/html')
    expect(page.truncatedByBytes).toBe(false)
  })

  it('rejects a declared content length over maxBytes without reading the body', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-length': '11' }); res.end('huge body!!') }
    await expect(httpFetchPage({ url: `${base}/a`, redirect: { mode: 'reject' }, maxBytes: 5 }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_FETCH_TOO_LARGE', message: 'response exceeds the maximum of 5 bytes' }))
  })

  it('truncates a stream that runs past maxBytes and reports it', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abcdefgh') }
    const page = await httpFetchPage({ url: `${base}/a`, redirect: { mode: 'reject' }, maxBytes: 3 })
    expect(text(page.bytes)).toBe('abc')
    expect(page.truncatedByBytes).toBe(true)
  })

  it('does not report truncation at the exact cap', async () => {
    handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('abc') }
    const page = await httpFetchPage({ url: `${base}/a`, redirect: { mode: 'reject' }, maxBytes: 3 })
    expect(text(page.bytes)).toBe('abc')
    expect(page.truncatedByBytes).toBe(false)
  })

  it('fails with WEB_REDIRECT_BLOCKED on a redirect response and never contacts the target', async () => {
    handler = (_req, res) => { res.writeHead(302, { location: '/b' }); res.end() }
    await expect(httpFetchPage({ url: `${base}/a`, redirect: { mode: 'reject' } }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED', message: 'redirect response refused by policy' }))
    expect(hits).toEqual(['GET /a'])
  })

  it('follows same-origin redirect hops to the final URL', async () => {
    handler = (req, res) => {
      if (req.url === '/a') { res.writeHead(302, { location: '/b' }); res.end() } else if (req.url === '/b') { res.writeHead(302, { location: '/c' }); res.end() } else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('landed') }
    }
    const page = await httpFetchPage({
      url: `${base}/a`,
      redirect: { mode: 'same-origin', maxRedirects: 5 },
    })
    expect(page.finalUrl).toBe(`${base}/c`)
    expect(text(page.bytes)).toBe('landed')
    expect(hits).toEqual(['GET /a', 'GET /b', 'GET /c'])
  })

  it('fails with WEB_REDIRECT_BLOCKED after exhausting the budget', async () => {
    handler = (req, res) => {
      if (req.url === '/1') { res.writeHead(302, { location: '/2' }); res.end() } else if (req.url === '/2') { res.writeHead(302, { location: '/3' }); res.end() } else { res.writeHead(302, { location: '/4' }); res.end() }
    }
    await expect(httpFetchPage({ url: `${base}/1`, redirect: { mode: 'same-origin', maxRedirects: 2 } }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED', message: 'exceeded the maximum of 2 redirects' }))
    expect(hits).toEqual(['GET /1', 'GET /2', 'GET /3'])
  })

  it('fails on a redirect response without a Location header', async () => {
    handler = (_req, res) => { res.writeHead(302); res.end() }
    await expect(httpFetchPage({ url: `${base}/a`, redirect: { mode: 'same-origin', maxRedirects: 5 } }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'redirect response (HTTP 302) without a Location header' }))
  })

  it('fails on an unresolvable Location', async () => {
    handler = (_req, res) => { res.writeHead(302, { location: 'http://' }); res.end() }
    await expect(httpFetchPage({ url: `${base}/a`, redirect: { mode: 'same-origin', maxRedirects: 5 } }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'invalid redirect Location "http://"' }))
  })

  it('refuses cross-origin redirects without contacting the other origin', async () => {
    handler = (_req, res) => { res.writeHead(302, { location: 'http://example.invalid/elsewhere' }); res.end() }
    await expect(httpFetchPage({ url: `${base}/a`, redirect: { mode: 'same-origin', maxRedirects: 5 } }))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_REDIRECT_BLOCKED',
        message: 'cross-origin redirect to http://example.invalid is not followed automatically; retry against that URL directly',
      }))
    expect(hits).toEqual(['GET /a'])
  })

  it('lets validateTarget refuse a target before it is contacted', async () => {
    handler = (_req, res) => { res.writeHead(302, { location: 'ftp://127.0.0.1/x' }); res.end() }
    await expect(httpFetchPage({
      url: `${base}/a`,
      redirect: {
        mode: 'same-origin',
        maxRedirects: 5,
        validateTarget: (target) => {
          if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new WebError(`unsupported URL scheme "${target.protocol.slice(0, -1)}"`, 'WEB_INVALID_URL')
          return target
        },
      },
    })).rejects.toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
    expect(hits).toEqual(['GET /a'])
  })

  it('reject mode throws on a redirect and never contacts the Location target', async () => {
    handler = (req, res) => {
      if (req.url === '/a') { res.writeHead(302, { location: '/b' }); res.end() } else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('reached') }
    }
    await expect(httpFetchPage({ url: `${base}/a`, redirect: { mode: 'reject' } })).rejects.toThrow()
    expect(hits).toEqual(['GET /a'])
  })

  it('forwards method, body, and headers', async () => {
    let seenBody = ''
    handler = (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        seenBody = Buffer.concat(chunks).toString()
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(req.headers['x-probe'])
      })
    }
    const page = await httpFetchPage({
      url: `${base}/a`,
      method: 'POST',
      body: 'q=1',
      headers: { 'x-probe': 'probe-value' },
      redirect: { mode: 'reject' },
    })
    expect(seenBody).toBe('q=1')
    expect(text(page.bytes)).toBe('probe-value')
  })

  it('downgrades a POST answered 301/302/303 to a bodyless GET on the redirected hop', async () => {
    const seen: { body: string; contentType: string | undefined }[] = []
    handler = (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        seen.push({ body: Buffer.concat(chunks).toString(), contentType: req.headers['content-type'] })
        if (seen.length === 1) {
          res.writeHead(302, { location: '/landing' })
          res.end()
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('landing')
        }
      })
    }
    const page = await httpFetchPage({
      url: `${base}/form`,
      method: 'POST',
      body: 'q=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: { mode: 'same-origin', maxRedirects: 3 },
    })
    expect(page.finalUrl).toBe(`${base}/landing`)
    expect(text(page.bytes)).toBe('landing')
    expect(hits).toEqual(['POST /form', 'GET /landing'])
    expect(seen).toEqual([
      { body: 'q=1', contentType: 'application/x-www-form-urlencoded' },
      { body: '', contentType: undefined },
    ])
  })

  it('keeps a POST verbatim across a 307 redirect', async () => {
    const seen: { body: string; contentType: string | undefined }[] = []
    handler = (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        seen.push({ body: Buffer.concat(chunks).toString(), contentType: req.headers['content-type'] })
        if (seen.length === 1) {
          res.writeHead(307, { location: '/landing' })
          res.end()
        } else {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('landing')
        }
      })
    }
    const page = await httpFetchPage({
      url: `${base}/form`,
      method: 'POST',
      body: 'q=1',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      redirect: { mode: 'same-origin', maxRedirects: 3 },
    })
    expect(page.finalUrl).toBe(`${base}/landing`)
    expect(text(page.bytes)).toBe('landing')
    expect(hits).toEqual(['POST /form', 'POST /landing'])
    expect(seen).toEqual([
      { body: 'q=1', contentType: 'application/x-www-form-urlencoded' },
      { body: 'q=1', contentType: 'application/x-www-form-urlencoded' },
    ])
  })

  it('returns the raw bytes without scanning for challenges', async () => {
    handler = (_req, res) => { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<script>window._cf_chl_opt</script>') }
    const page = await httpFetchPage({ url: `${base}/a`, redirect: { mode: 'reject' } })
    expect(page.status).toBe(403)
    expect(text(page.bytes)).toContain('_cf_chl_opt')
  })
})
