/**
 * Write-path coverage for the seam + generic stdio provider: document formatting (format-on-write)
 * and diagnostics collection (diagnostics-on-write), both against the scriptable fixture server.
 * These tests pin the public `ctx.lsp.format` / `ctx.lsp.collectDiagnostics` behavior end to end —
 * the transient open lifecycle, the formatting request options, and the version-fresh publish wait.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, realpath, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Lsp from '@deepseek-ai/dsh-lsp'
import * as LspLocal from '@deepseek-ai/dsh-lsp-stdio'
import type { LspLocalServerConfig } from '@deepseek-ai/dsh-lsp-stdio'
import type { LspProvider } from '@deepseek-ai/dsh-lsp'

const fixtureServer = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))

let root: string
let ws: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'lsp-write-')))
  ws = join(root, 'ws')
  await mkdir(ws)
  await writeFile(join(ws, 'a.ts'), 'unused on-disk content\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** One fake stdio server entry with optional behavior and host-bound overrides. */
function fakeServer(fakeEnv: Record<string, string> = {}, overrides: Partial<LspLocalServerConfig> = {}): LspLocalServerConfig {
  return {
    command: process.execPath,
    args: [fixtureServer],
    env: { ...fakeEnv },
    extensionToLanguage: { '.ts': 'typescript' },
    shutdownTimeoutMs: 200,
    killGraceMs: 200,
    diagnosticsTimeoutMs: 200,
    ...overrides,
  }
}

/** Mount the real seam + lsp-stdio plugin driving one fake server. */
async function mount(fakeEnv: Record<string, string> = {}, overrides: Partial<LspLocalServerConfig> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Lsp)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  await ctx.plugin(LspLocal, {
    servers: { fake: fakeServer(fakeEnv, overrides) },
  })
  return ctx
}

describe('ctx.lsp.format (format-on-write)', () => {
  it('returns the formatted text when the server scripts edits', async () => {
    const edits = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 11 } }, newText: 'const z = 1' }]
    const ctx = await mount({ LSP_FAKE_FORMAT_EDITS: JSON.stringify(edits) })
    const result = await ctx.lsp.format({
      filePath: 'a.ts',
      workspaceRoot: ws,
      text: 'const x = 1\n',
    })
    expect(result).toEqual({ formattedText: 'const z = 1\n' })
    await ctx.fiber.dispose()
  })

  it('returns null when the server lacks documentFormattingProvider (scripted capability)', async () => {
    const ctx = await mount({
      LSP_FAKE_CAPS: JSON.stringify({ documentFormattingProvider: false }),
      LSP_FAKE_FORMAT_EDITS: JSON.stringify([]),
    })
    const result = await ctx.lsp.format({
      filePath: 'a.ts',
      workspaceRoot: ws,
      text: 'const x = 1\n',
    })
    // A write path must degrade gracefully: no formatting provider means "no formatting happened",
    // not an error that would interrupt a write-through.
    expect(result).toEqual({ formattedText: null })
    await ctx.fiber.dispose()
  })

  it('returns null when the server answers with no edits', async () => {
    const ctx = await mount({ LSP_FAKE_FORMAT_EDITS: 'null' })
    const result = await ctx.lsp.format({
      filePath: 'a.ts',
      workspaceRoot: ws,
      text: 'const x = 1\n',
    })
    expect(result).toEqual({ formattedText: null })
    await ctx.fiber.dispose()
  })

  it('sends the caller text verbatim and defaults the formatting options', async () => {
    const marker = join(root, 'format-options.log')
    const openMarker = join(root, 'format-open.log')
    const ctx = await mount({
      LSP_FAKE_FORMAT_EDITS: 'null',
      LSP_FAKE_FORMAT_MARKER: marker,
      LSP_FAKE_OPEN_MARKER: openMarker,
    })
    await ctx.lsp.format({ filePath: 'a.ts', workspaceRoot: ws, text: 'caller text\n' })
    // The transient document carried the caller's authoritative content, not the on-disk bytes.
    const opened = await readFile(openMarker, 'utf8')
    expect(opened).toBe('"caller text\\n"\n')
    // Options default to tabSize 2, insertSpaces true when absent.
    const options = JSON.parse((await readFile(marker, 'utf8')).trim()) as { tabSize: number; insertSpaces: boolean }
    expect(options).toEqual({ tabSize: 2, insertSpaces: true })
    await ctx.fiber.dispose()
  })

  it('forwards explicit formatting options', async () => {
    const marker = join(root, 'format-options.log')
    const ctx = await mount({ LSP_FAKE_FORMAT_EDITS: 'null', LSP_FAKE_FORMAT_MARKER: marker })
    await ctx.lsp.format({
      filePath: 'a.ts',
      workspaceRoot: ws,
      text: 'const x = 1\n',
      formattingOptions: { tabSize: 4, insertSpaces: false },
    })
    const options = JSON.parse((await readFile(marker, 'utf8')).trim()) as { tabSize: number; insertSpaces: boolean }
    expect(options).toEqual({ tabSize: 4, insertSpaces: false })
    await ctx.fiber.dispose()
  })

  it('replaces a crashed transport once and retries format', async () => {
    // The server exits on every didOpen; the provider must replace the dead child once and retry
    // (which also crashes), then surface the failure instead of hanging.
    const ctx = await mount({ LSP_FAKE_CRASH_ON_OPEN: '1', LSP_FAKE_FORMAT_EDITS: 'null' }, { shutdownTimeoutMs: 100, killGraceMs: 100 })
    await expect(ctx.lsp.format({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n' })).rejects.toThrow()
    await ctx.fiber.dispose()
  })
})

describe('ctx.lsp.collectDiagnostics (diagnostics-on-write)', () => {
  function emit(version: 'open' | number | 'none', diagnostics: readonly unknown[]): Record<string, string> {
    const plan: Record<string, unknown> = { uri: pathToFileURL(join(ws, 'a.ts')).href, diagnostics }
    if (version !== 'none') plan.version = version
    return { LSP_FAKE_PUBLISH_DIAGNOSTICS: JSON.stringify(plan), LSP_FAKE_PUBLISH_DELAY_MS: '50' }
  }

  it('returns scripted diagnostics for the opened uri and version', async () => {
    const diagnostics = [
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 1, message: 'arg is never read', source: 'ts' },
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, message: 'unused variable' },
    ]
    const ctx = await mount(emit('open', diagnostics))
    const result = await ctx.lsp.collectDiagnostics({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 5 })
    // Sorted by range (start line, start char, end line, end char).
    expect(result).toEqual({
      diagnostics: [
        { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, message: 'unused variable' },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 1, source: 'ts', message: 'arg is never read' },
      ],
    })
    await ctx.fiber.dispose()
  })

  it('ignores a version-mismatch publish (stale snapshot) and returns empty', async () => {
    const diagnostics = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, message: 'stale' }]
    const ctx = await mount(emit(999, diagnostics))
    const result = await ctx.lsp.collectDiagnostics({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 5 })
    // The publish carries an unrelated version; it must be dropped and the wait must time out into
    // an empty result rather than crash.
    expect(result).toEqual({ diagnostics: [] })
    await ctx.fiber.dispose()
  })

  it('accepts a legacy publish with no version field', async () => {
    const diagnostics = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, message: 'legacy' }]
    const ctx = await mount(emit('none', diagnostics))
    const result = await ctx.lsp.collectDiagnostics({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 5 })
    expect(result).toEqual({ diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, message: 'legacy' }] })
    await ctx.fiber.dispose()
  })

  it('returns empty on an absent publish (server has no diagnostics provider) without crashing', async () => {
    const ctx = await mount({})
    const result = await ctx.lsp.collectDiagnostics({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 2 })
    expect(result).toEqual({ diagnostics: [] })
    await ctx.fiber.dispose()
  })

  it('ignores a publish for a different uri', async () => {
    // `forUri` triggers when a.ts opens; the emitted publish carries other.ts's uri, so the
    // collector's uri filter drops it and the wait times out into empty.
    const plan = {
      forUri: pathToFileURL(join(ws, 'a.ts')).href,
      uri: pathToFileURL(join(ws, 'other.ts')).href,
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, message: 'other file' }],
      version: 'open',
    }
    const ctx = await mount({ LSP_FAKE_PUBLISH_DIAGNOSTICS: JSON.stringify(plan), LSP_FAKE_PUBLISH_DELAY_MS: '50' })
    const result = await ctx.lsp.collectDiagnostics({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 1 })
    expect(result).toEqual({ diagnostics: [] })
    await ctx.fiber.dispose()
  })

  it('rejects a write path when the workspace root cannot be resolved', async () => {
    const ctx = await mount({})
    const outside = join(root, 'missing')
    await expect(ctx.lsp.format({ filePath: 'a.ts', workspaceRoot: outside, text: 'const x = 1\n' }))
      .rejects.toThrow(/not a directory/)
    await expect(ctx.lsp.collectDiagnostics({ filePath: 'a.ts', workspaceRoot: outside, text: 'const x = 1\n', version: 1 }))
      .rejects.toThrow(/not a directory/)
    await ctx.fiber.dispose()
  })

  it('rejects a format with a non-transport provider failure instead of retrying', async () => {
    // LSP_UNSUPPORTED_OPERATION (no transient open) is not a transport failure, so the replace-once
    // policy must not kick in — the error propagates as-is.
    const ctx = await mount({ LSP_FAKE_SYNC: '0' })
    await expect(ctx.lsp.format({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n' }))
      .rejects.toThrow(/transient textDocument\/didOpen/)
    await ctx.fiber.dispose()
  })

  it('rejects a direct provider call for an unmapped extension', async () => {
    // The seam refuses unmapped extensions, so the provider's out-of-contract guard is probed
    // directly through the registered provider.
    const ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    const register = ctx.lsp.registerProvider.bind(ctx.lsp)
    let captured: LspProvider | undefined
    const registrationSpy = vi.spyOn(ctx.lsp, 'registerProvider').mockImplementation((provider) => {
      captured = provider
      return register(provider)
    })
    try {
      await ctx.plugin(LspLocal, { servers: { fake: fakeServer({}) } })
    } finally {
      registrationSpy.mockRestore()
    }
    expect(captured).toBeDefined()
    await expect(captured!.format({ filePath: 'a.py', workspaceRoot: ws, text: 'x = 1\n' }))
      .rejects.toThrow(expect.objectContaining({ code: 'LSP_UNAVAILABLE' }))
    await ctx.fiber.dispose()
  })

  it('serializes with queries through the same instance', async () => {
    const ctx = await mount({ LSP_FAKE_DEF: 'null', LSP_FAKE_FORMAT_EDITS: 'null' })
    await ctx.lsp.query({ operation: 'goToDefinition', filePath: 'a.ts', position: { line: 0, character: 0 }, workspaceRoot: ws })
    const formatted = await ctx.lsp.format({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n' })
    expect(formatted).toEqual({ formattedText: null })
    const diagnostics = await ctx.lsp.collectDiagnostics({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 1 })
    expect(diagnostics).toEqual({ diagnostics: [] })
    await ctx.fiber.dispose()
  })

  it('tolerates a malformed publish notification (params is not an object)', async () => {
    // A structurally broken publishDiagnostics must be dropped without disrupting the wait, which
    // then times out into empty diagnostics.
    const plan = {
      uri: pathToFileURL(join(ws, 'a.ts')).href,
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, message: 'x' }],
      version: 'open',
    }
    const ctx = await mount({
      LSP_FAKE_PUBLISH_DIAGNOSTICS: JSON.stringify(plan),
      LSP_FAKE_PUBLISH_RAW: '1',
    })
    const result = await ctx.lsp.collectDiagnostics({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 1 })
    expect(result).toEqual({ diagnostics: [] })
    await ctx.fiber.dispose()
  })

  it('degrades to empty diagnostics when the transport dies during the publish wait', async () => {
    // The server exits on the collect's own didOpen, so no publish can ever arrive. The collector
    // must time out into an empty result, not crash: a write path treats "no diagnostics available"
    // the same as an absent publish.
    const ctx = await mount({ LSP_FAKE_CRASH_ON_OPEN: '1' }, { shutdownTimeoutMs: 100, killGraceMs: 100 })
    const result = await ctx.lsp.collectDiagnostics({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 1 })
    expect(result).toEqual({ diagnostics: [] })
    await ctx.fiber.dispose()
  })
})
