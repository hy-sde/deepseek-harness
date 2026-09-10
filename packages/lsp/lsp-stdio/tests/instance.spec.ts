import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { LspInstance, readHostSource } from '@deepseek-ai/dsh-lsp-stdio'
import { encodeMessage } from '@deepseek-ai/dsh-lsp-stdio'
import type { ConnectionWriter } from '@deepseek-ai/dsh-lsp-stdio/src/connection.ts'
import type { InstanceSpec } from '@deepseek-ai/dsh-lsp-stdio/src/instance.ts'
import type { LspProviderQuery, LspQueryResult } from '@deepseek-ai/dsh-lsp'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { spawnSubprocess } from '@deepseek-ai/dsh-subprocess-local/src/spawn.ts'

const fixtureServer = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))

let root: string
let ws: string
let ctx: Context
let fs: LocalFileSystem
let live: LspInstance[] = []

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'lsp-inst-')))
  ws = join(root, 'ws')
  await mkdir(ws)
  await writeFile(join(ws, 'a.ts'), 'const x = 1\n')
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root })
  fs = ctx.fs as LocalFileSystem
})

afterEach(async () => {
  for (const instance of live) await instance.dispose()
  live = []
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function makeInstance(
  env: Record<string, string> = {},
  overrides: Partial<InstanceSpec> = {},
  writer?: ConnectionWriter,
): LspInstance {
  const instance = new LspInstance({
    command: process.execPath,
    args: [fixtureServer],
    cwd: ws,
    workspaceUri: pathToFileURL(ws).href,
    env: { ...scrubbedParentEnv(), ...env },
    configuration: { setting: 42 },
    initializationOptions: { init: true },
    maxMessageBytes: 16_000_000,
    maxStderrBytes: 100_000,
    shutdownTimeoutMs: 200,
    killGraceMs: 200,
    diagnosticsTimeoutMs: 400,
    projectAware: false,
    projectDiagnosticsWaitMs: 1000,
    ...overrides,
  }, spawnSubprocess, writer)
  live.push(instance)
  return instance
}

function query(operation: LspProviderQuery['operation'] = 'goToDefinition'): LspProviderQuery {
  return { operation, filePath: 'a.ts', position: { line: 0, character: 6 }, workspaceRoot: ws, languageId: 'typescript' }
}

/** Run a query against an instance, reading the source first the way the provider does. */
async function run(instance: LspInstance, operation: LspProviderQuery['operation'] = 'goToDefinition', signal?: AbortSignal): Promise<LspQueryResult> {
  const workspace = {
    target: await fs.resolve(ws),
    canonicalPath: ws,
    fileUrl: pathToFileURL(ws).href,
  }
  const source = await readHostSource(fs, 'a.ts', workspace, 4_000_000)
  return instance.query(query(operation), source, signal)
}

/** Build an instance whose "server" is an inline node script (for teardown-escalation control). */
function scriptInstance(script: string, overrides: Partial<InstanceSpec> = {}): LspInstance {
  const instance = new LspInstance({
    command: process.execPath,
    args: ['-e', script],
    cwd: ws,
    workspaceUri: pathToFileURL(ws).href,
    env: scrubbedParentEnv(),
    configuration: null,
    initializationOptions: null,
    maxMessageBytes: 16_000_000,
    maxStderrBytes: 100_000,
    shutdownTimeoutMs: 150,
    killGraceMs: 150,
    diagnosticsTimeoutMs: 400,
    projectAware: false,
    projectDiagnosticsWaitMs: 1000,
    ...overrides,
  }, spawnSubprocess)
  live.push(instance)
  return instance
}

/** An inline server that answers initialize + definition and echoes a location. */
const RESPONDING_SERVER =
  'let b=Buffer.alloc(0);'
  + 'const fr=(o)=>{const x=Buffer.from(JSON.stringify({jsonrpc:"2.0",...o}));return Buffer.concat([Buffer.from(`Content-Length: ${x.length}\\r\\n\\r\\n`),x]);};'
  + 'process.stdin.on("data",c=>{b=Buffer.concat([b,c]);for(;;){const s=b.indexOf("\\r\\n\\r\\n");if(s<0)break;const len=Number(/(\\d+)/.exec(b.toString("ascii",0,s))[1]);if(b.length<s+4+len)break;const m=JSON.parse(b.toString("utf8",s+4,s+4+len));b=b.subarray(s+4+len);'
  + 'if(m.method==="initialize")process.stdout.write(fr({id:m.id,result:{capabilities:{positionEncoding:"utf-16",textDocumentSync:1,definitionProvider:true}}}));'
  + 'else if(m.method==="textDocument/definition")process.stdout.write(fr({id:m.id,result:null}));'
  + '}});'

const locJson = () => JSON.stringify({ uri: pathToFileURL(join(ws, 'a.ts')).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } })

/** An inline server that rejects the initialize handshake with a JSON-RPC error (no recovery). */
const FAILED_HANDSHAKE_SERVER =
  'let b=Buffer.alloc(0);'
  + 'const fr=(o)=>{const x=Buffer.from(JSON.stringify({jsonrpc:"2.0",...o}));return Buffer.concat([Buffer.from(`Content-Length: ${x.length}\\r\\n\\r\\n`),x]);};'
  + 'process.stdin.on("data",c=>{b=Buffer.concat([b,c]);for(;;){const s=b.indexOf("\\r\\n\\r\\n");if(s<0)break;const len=Number(/(\\d+)/.exec(b.toString("ascii",0,s))[1]);if(b.length<s+4+len)break;const m=JSON.parse(b.toString("utf8",s+4,s+4+len));b=b.subarray(s+4+len);'
  + 'if(m.method==="initialize")process.stdout.write(fr({id:m.id,error:{code:-32000,message:"initialize exploded"}}));'
  + '}});'

describe('LspInstance server-request handling', () => {
  it('answers workspace/configuration with the static config per item', async () => {
    const instance = makeInstance({ LSP_FAKE_ON_OPEN: 'configuration', LSP_FAKE_DEF: locJson() })
    // The query drives didOpen, which makes the fake emit workspace/configuration; a healthy answer
    // keeps the query working.
    await expect(run(instance, 'goToDefinition')).resolves.toMatchObject({ kind: 'locations' })
  })

  it('accepts a lifecycle client/registerCapability request', async () => {
    const instance = makeInstance({ LSP_FAKE_ON_OPEN: 'lifecycle', LSP_FAKE_DEF: 'null' })
    await expect(run(instance, 'goToDefinition')).resolves.toEqual({ kind: 'locations', locations: [], resolvedWorkspaceUri: pathToFileURL(ws).href })
  })

  it('rejects a workspace/applyEdit request but keeps serving', async () => {
    const instance = makeInstance({ LSP_FAKE_ON_OPEN: 'applyEdit', LSP_FAKE_DEF: 'null' })
    await expect(run(instance, 'goToDefinition')).resolves.toEqual({ kind: 'locations', locations: [], resolvedWorkspaceUri: pathToFileURL(ws).href })
  })

  it('rejects an unknown server request but keeps serving', async () => {
    const instance = makeInstance({ LSP_FAKE_ON_OPEN: 'unknown', LSP_FAKE_DEF: 'null' })
    await expect(run(instance, 'goToDefinition')).resolves.toEqual({ kind: 'locations', locations: [], resolvedWorkspaceUri: pathToFileURL(ws).href })
  })
})

describe('LspInstance query and abort', () => {
  it('sends includeDeclaration for references', async () => {
    const instance = makeInstance({ LSP_FAKE_REFS: JSON.stringify([JSON.parse(locJson())]) })
    await expect(run(instance, 'findReferences')).resolves.toMatchObject({ kind: 'locations' })
  })

  it('rejects a query aborted before it starts', async () => {
    const instance = makeInstance({ LSP_FAKE_DEF: 'null' })
    const controller = new AbortController()
    controller.abort(new Error('pre-abort'))
    await expect(run(instance, 'goToDefinition', controller.signal)).rejects.toThrow(/pre-abort/)
  })

  it('cancels an in-flight request on abort and rejects', async () => {
    const instance = makeInstance({ LSP_FAKE_HANG: '1' })
    const controller = new AbortController()
    // Warm the instance first so the abort lands during the hanging request, not during startup.
    const pending = run(instance, 'goToDefinition', controller.signal)
    await new Promise<void>(resolve => setTimeout(resolve, 300))
    controller.abort(new Error('mid-flight'))
    await expect(pending).rejects.toThrow(/mid-flight/)
  })

  it('terminates the instance when the server ignores $/cancelRequest past the grace', async () => {
    // The hang server never honors cancellation, so after the bounded grace the instance must be torn
    // down (its process closed) rather than left with an active request.
    const instance = makeInstance({ LSP_FAKE_HANG: '1' }, { killGraceMs: 100 })
    const controller = new AbortController()
    const pending = run(instance, 'goToDefinition', controller.signal)
    await new Promise<void>(resolve => setTimeout(resolve, 300))
    controller.abort(new Error('mid-flight'))
    await expect(pending).rejects.toThrow(/mid-flight/)
    expect(instance.dead).toBe(true)
  })

  it('resolves the cancel grace when the server honors $/cancelRequest', async () => {
    // A server that answers $/cancelRequest by settling the pending request lets the grace race
    // resolve via the request rather than the timeout, so the instance is NOT force-terminated.
    const script = 'let b=Buffer.alloc(0),reqId=null;'
      + 'const fr=(o)=>{const x=Buffer.from(JSON.stringify({jsonrpc:"2.0",...o}));return Buffer.concat([Buffer.from(`Content-Length: ${x.length}\\r\\n\\r\\n`),x]);};'
      + 'process.stdin.on("data",c=>{b=Buffer.concat([b,c]);for(;;){const s=b.indexOf("\\r\\n\\r\\n");if(s<0)break;const len=Number(/(\\d+)/.exec(b.toString("ascii",0,s))[1]);if(b.length<s+4+len)break;const m=JSON.parse(b.toString("utf8",s+4,s+4+len));b=b.subarray(s+4+len);'
      + 'if(m.method==="initialize")process.stdout.write(fr({id:m.id,result:{capabilities:{positionEncoding:"utf-16",textDocumentSync:1,definitionProvider:true}}}));'
      + 'else if(m.method==="textDocument/definition")reqId=m.id;'
      + 'else if(m.method==="$/cancelRequest"&&reqId!==null)process.stdout.write(fr({id:reqId,error:{code:-32800,message:"request cancelled"}}));'
      + 'else if(m.method==="shutdown")process.stdout.write(fr({id:m.id,result:null}));'
      + 'else if(m.method==="exit")process.exit(0);'
      + '}});'
    const instance = scriptInstance(script, { killGraceMs: 2_000 })
    const controller = new AbortController()
    const pending = run(instance, 'goToDefinition', controller.signal)
    await new Promise<void>(resolve => setTimeout(resolve, 300))
    controller.abort(new Error('mid-flight'))
    await expect(pending).rejects.toThrow(/mid-flight/)
    // The server acknowledged cancellation within grace, so the instance was not force-killed.
    expect(instance.dead).toBe(false)
    await instance.dispose()
  })

  it('observes abort while awaiting a slow initialize handshake', async () => {
    // A server that answers nothing (not even initialize) leaves `ready` pending; an abort must be
    // observed during that wait instead of hanging the tool-timeout signal.
    const instance = scriptInstance('setInterval(()=>{},1000)', { killGraceMs: 100 })
    const controller = new AbortController()
    const pending = run(instance, 'goToDefinition', controller.signal)
    await new Promise<void>(resolve => setTimeout(resolve, 150))
    controller.abort(new Error('handshake-abort'))
    await expect(pending).rejects.toThrow(/handshake-abort/)
    await instance.dispose()
  })

  it('terminates when abort interrupts a backpressured didOpen write', async () => {
    // The fixture consumes initialized, then stops reading. A document larger than the stdio pipe
    // keeps didOpen's write callback pending until cancellation forces bounded process teardown.
    await writeFile(join(ws, 'a.ts'), 'x'.repeat(2_000_000))
    const marker = join(root, 'initialized.log')
    const instance = makeInstance({
      LSP_FAKE_INITIALIZED_MARKER: marker,
      LSP_FAKE_PAUSE_STDIN_AFTER_INITIALIZED: '1',
    }, {
      shutdownTimeoutMs: 100,
      killGraceMs: 100,
    })
    const controller = new AbortController()
    const pending = run(instance, 'goToDefinition', controller.signal)
    await waitForFile(marker)
    // Let the client enter the large didOpen write after the fixture has paused stdin.
    await new Promise<void>(resolve => setTimeout(resolve, 100))
    controller.abort(new Error('didOpen-abort'))
    await expect(pending).rejects.toThrow(/didOpen-abort/)
    expect(instance.dead).toBe(true)
  })

  it('terminates when stdin fails during the didOpen write', async () => {
    const instance = makeInstance({}, {
      shutdownTimeoutMs: 100,
      killGraceMs: 100,
    }, failingWriter('textDocument/didOpen'))
    await expect(run(instance, 'goToDefinition')).rejects.toThrow()
    expect(instance.dead).toBe(true)
  })

  it('awaits process exit before rejecting a request write failure', async () => {
    const instance = makeInstance({}, {
      shutdownTimeoutMs: 100,
      killGraceMs: 100,
    }, failingWriter('textDocument/definition'))
    await expect(run(instance, 'goToDefinition')).rejects.toThrow(/fixture textDocument\/definition failure/)
  })

  it('rejects when the server lacks the operation capability', async () => {
    const instance = makeInstance({ LSP_FAKE_CAPS: JSON.stringify({ definitionProvider: false }), LSP_FAKE_DEF: 'null' })
    await expect(run(instance, 'goToDefinition')).rejects.toThrow(/does not support goToDefinition/)
  })

  it('propagates a server error response even when a signal is supplied (not an abort)', async () => {
    // A live signal is passed, but the request fails for a server reason; the catch must rethrow
    // without treating it as an abort.
    const instance = makeInstance({ LSP_FAKE_ERROR: '1' })
    const controller = new AbortController()
    await expect(run(instance, 'goToDefinition', controller.signal)).rejects.toThrow(/server refused/)
  })

  it('keeps a settled result but awaits teardown when didClose cannot be written', async () => {
    const instance = makeInstance({
      LSP_FAKE_DEF: 'null',
    }, { shutdownTimeoutMs: 100, killGraceMs: 100 }, failingWriter('textDocument/didClose'))
    await expect(run(instance, 'goToDefinition')).resolves.toEqual({
      kind: 'locations',
      locations: [],
      resolvedWorkspaceUri: pathToFileURL(ws).href,
    })
    expect(instance.dead).toBe(true)
  })
})

describe('LspInstance disposal', () => {
  it('lets a server finish protocol exit before signal escalation', async () => {
    const marker = join(root, 'graceful-exit.log')
    const instance = makeInstance({
      LSP_FAKE_DEF: 'null',
      LSP_FAKE_EXIT_DELAY_MS: '75',
      LSP_FAKE_EXIT_MARKER: marker,
    }, { shutdownTimeoutMs: 500 })
    await run(instance, 'goToDefinition')
    await instance.dispose()
    expect(await readFile(marker, 'utf8')).toBe('EXIT\nCLEAN\n')
  })

  it('is idempotent — a second dispose awaits close without error', async () => {
    const instance = makeInstance({ LSP_FAKE_DEF: 'null' })
    await run(instance, 'goToDefinition')
    await instance.dispose()
    await expect(instance.dispose()).resolves.toBeUndefined()
  })

  it('rejects a query after disposal', async () => {
    const instance = makeInstance({ LSP_FAKE_DEF: 'null' })
    await run(instance, 'goToDefinition')
    await instance.dispose()
    await expect(run(instance, 'goToDefinition')).rejects.toThrow(expect.objectContaining({ code: 'LSP_DISPOSED' }))
  })

  it('reports dead after the process closes', async () => {
    const instance = makeInstance({ LSP_FAKE_DEF: 'null' })
    await run(instance, 'goToDefinition')
    await instance.dispose()
    expect(instance.dead).toBe(true)
  })

  it('escalates to SIGKILL when the server ignores shutdown and SIGTERM', async () => {
    // Server answers initialize, ignores shutdown, and traps SIGTERM so only SIGKILL stops it.
    const script = RESPONDING_SERVER + 'process.on("SIGTERM",()=>{});'
    const instance = scriptInstance(script, { shutdownTimeoutMs: 100, killGraceMs: 100 })
    await run(instance, 'goToDefinition')
    await expect(instance.dispose()).resolves.toBeUndefined()
  })

  it('awaits a surviving process-tree helper on every concurrent dispose', async () => {
    const marker = join(root, 'helper.pid')
    const helper = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'
    const script = 'const{spawn}=require("node:child_process");const{writeFileSync}=require("node:fs");'
      + `const helper=spawn(process.execPath,["-e",${JSON.stringify(helper)}],{stdio:"ignore"});`
      + `writeFileSync(${JSON.stringify(marker)},String(helper.pid));`
      + RESPONDING_SERVER
    const instance = scriptInstance(script, { shutdownTimeoutMs: 100, killGraceMs: 100 })
    await run(instance, 'goToDefinition')
    const helperPid = Number(await readFile(marker, 'utf8'))
    try {
      const first = instance.dispose()
      await instance.dispose()
      expect(processAlive(helperPid)).toBe(false)
      await first
    } finally {
      if (processAlive(helperPid)) process.kill(helperPid, 'SIGKILL')
      await waitForProcessExit(helperPid)
    }
  })

  it('carries a non-Error abort reason as a generic aborted error', async () => {
    const instance = makeInstance({ LSP_FAKE_HANG: '1' })
    const controller = new AbortController()
    const pending = run(instance, 'goToDefinition', controller.signal)
    await new Promise<void>(resolve => setTimeout(resolve, 200))
    controller.abort('a string reason, not an Error')
    await expect(pending).rejects.toThrow(/aborted/)
  })
})

describe('LspInstance write path', () => {
  it('formats the caller text from a textDocument/formatting result', async () => {
    const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 11 } }, newText: 'const z = 1' }
    const instance = makeInstance({ LSP_FAKE_FORMAT_EDITS: JSON.stringify([edit]) })
    await expect(instance.format({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n' }, pathToFileURL(join(ws, 'a.ts')).href, 'typescript'))
      .resolves.toEqual({ formattedText: 'const z = 1\n' })
  })

  it('returns null when the server lacks documentFormattingProvider', async () => {
    const instance = makeInstance({ LSP_FAKE_CAPS: JSON.stringify({ documentFormattingProvider: false }) })
    await expect(instance.format({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n' }, pathToFileURL(join(ws, 'a.ts')).href, 'typescript'))
      .resolves.toEqual({ formattedText: null })
  })

  it('rejects when the server lacks transient open', async () => {
    const instance = makeInstance({ LSP_FAKE_SYNC: '0' })
    await expect(instance.format({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n' }, pathToFileURL(join(ws, 'a.ts')).href, 'typescript'))
      .rejects.toThrow(/transient textDocument\/didOpen/)
  })

  it('rejects a format after disposal', async () => {
    const instance = makeInstance({ LSP_FAKE_FORMAT_EDITS: 'null' })
    await instance.dispose()
    await expect(instance.format({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n' }, pathToFileURL(join(ws, 'a.ts')).href, 'typescript'))
      .rejects.toThrow(expect.objectContaining({ code: 'LSP_DISPOSED' }))
  })

  it('tears down when the formatting request write fails', async () => {
    const instance = makeInstance({}, {
      shutdownTimeoutMs: 100,
      killGraceMs: 100,
    }, failingWriter('textDocument/formatting'))
    await expect(instance.format({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n' }, pathToFileURL(join(ws, 'a.ts')).href, 'typescript'))
      .rejects.toThrow()
    expect(instance.dead).toBe(true)
  })

  it('keeps a settled format result but tears down when didClose cannot be written', async () => {
    const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 11 } }, newText: 'const z = 1' }
    const instance = makeInstance({ LSP_FAKE_FORMAT_EDITS: JSON.stringify([edit]) }, {
      shutdownTimeoutMs: 100,
      killGraceMs: 100,
    }, failingWriter('textDocument/didClose'))
    await expect(instance.format({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n' }, pathToFileURL(join(ws, 'a.ts')).href, 'typescript'))
      .resolves.toEqual({ formattedText: 'const z = 1\n' })
    expect(instance.dead).toBe(true)
  })

  it('collects diagnostics published for the opened document at the opened version', async () => {
    const plan = {
      uri: pathToFileURL(join(ws, 'a.ts')).href,
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: 'parse error' }],
      version: 'open',
    }
    const instance = makeInstance({ LSP_FAKE_PUBLISH_DIAGNOSTICS: JSON.stringify(plan) })
    await expect(instance.collectDiagnostics(
      { filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 4 },
      pathToFileURL(join(ws, 'a.ts')).href,
      'typescript',
    )).resolves.toEqual({
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: 'parse error' }],
    })
  })

  it('returns empty diagnostics when the server never publishes', async () => {
    const instance = makeInstance({})
    await expect(instance.collectDiagnostics(
      { filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 2 },
      pathToFileURL(join(ws, 'a.ts')).href,
      'typescript',
    )).resolves.toEqual({ diagnostics: [] })
  })

  it('read path: a non-project-aware server that never publishes still reports empty (clean)', async () => {
    const instance = makeInstance({})
    const workspace = {
      target: await fs.resolve(ws),
      canonicalPath: ws,
      fileUrl: pathToFileURL(ws).href,
    }
    const source = await readHostSource(fs, 'a.ts', workspace, 4_000_000)
    await expect(instance.diagnostics(query('diagnostics'), source)).resolves.toEqual({
      kind: 'diagnostics',
      diagnostics: [],
      resolvedWorkspaceUri: pathToFileURL(ws).href,
    })
  })

  it('read path: a project-aware server that never publishes times out into an error, never a clean report', async () => {
    const instance = makeInstance({}, { projectAware: true, projectDiagnosticsWaitMs: 400 })
    const workspace = {
      target: await fs.resolve(ws),
      canonicalPath: ws,
      fileUrl: pathToFileURL(ws).href,
    }
    const source = await readHostSource(fs, 'a.ts', workspace, 4_000_000)
    await expect(instance.diagnostics(query('diagnostics'), source)).rejects.toThrow(
      expect.objectContaining({ code: 'LSP_DIAGNOSTICS_TIMEOUT' }),
    )
  })

  it('read path: a project-aware server gets the extended wait budget for on-demand analysis', async () => {
    const plan = {
      uri: pathToFileURL(join(ws, 'a.ts')).href,
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: 'slow analysis' }],
      version: 'open',
    }
    // The base write-path budget is 400ms; an on-demand first pass taking 700ms would be reported
    // clean under it. The project-aware read path waits up to projectDiagnosticsWaitMs instead.
    const instance = makeInstance(
      { LSP_FAKE_PUBLISH_DIAGNOSTICS: JSON.stringify(plan), LSP_FAKE_PUBLISH_DELAY_MS: '700' },
      { projectAware: true, projectDiagnosticsWaitMs: 2000 },
    )
    const workspace = {
      target: await fs.resolve(ws),
      canonicalPath: ws,
      fileUrl: pathToFileURL(ws).href,
    }
    const source = await readHostSource(fs, 'a.ts', workspace, 4_000_000)
    const result = await instance.diagnostics(query('diagnostics'), source)
    if (result.kind !== 'diagnostics') {
      throw new Error(`expected diagnostics result, got ${result.kind}`)
    }
    expect(result.diagnostics).toEqual([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: 'slow analysis' },
    ])
  })

  it('tears down when the collect didOpen write fails', async () => {
    const instance = makeInstance({}, {
      shutdownTimeoutMs: 100,
      killGraceMs: 100,
    }, failingWriter('textDocument/didOpen'))
    await expect(instance.collectDiagnostics(
      { filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 2 },
      pathToFileURL(join(ws, 'a.ts')).href,
      'typescript',
    )).rejects.toThrow()
    expect(instance.dead).toBe(true)
  })

  it('rejects collectDiagnostics after disposal', async () => {
    const instance = makeInstance({})
    await instance.dispose()
    await expect(instance.collectDiagnostics(
      { filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 2 },
      pathToFileURL(join(ws, 'a.ts')).href,
      'typescript',
    )).rejects.toThrow(expect.objectContaining({ code: 'LSP_DISPOSED' }))
  })

  it('tears down when the format didOpen write fails', async () => {
    const instance = makeInstance({}, {
      shutdownTimeoutMs: 100,
      killGraceMs: 100,
    }, failingWriter('textDocument/didOpen'))
    await expect(instance.format({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n' }, pathToFileURL(join(ws, 'a.ts')).href, 'typescript'))
      .rejects.toThrow()
    expect(instance.dead).toBe(true)
  })

  it('rejects collectDiagnostics when the server lacks transient open', async () => {
    const instance = makeInstance({ LSP_FAKE_SYNC: '0' })
    await expect(instance.collectDiagnostics(
      { filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 2 },
      pathToFileURL(join(ws, 'a.ts')).href,
      'typescript',
    )).rejects.toThrow(/transient textDocument\/didOpen/)
  })

  it('aborts the collect publish wait on caller cancellation', async () => {
    // An ample budget keeps the deadline from elapsing first; the open marker proves the lifecycle
    // has reached the publish wait before the caller aborts, so the abort must classify as a
    // rejection rather than degrade into an empty snapshot.
    const marker = join(root, 'collect-open.log')
    const instance = makeInstance({ LSP_FAKE_OPEN_MARKER: marker }, { diagnosticsTimeoutMs: 3000 })
    const controller = new AbortController()
    const pending = instance.collectDiagnostics(
      { filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n', version: 2 },
      pathToFileURL(join(ws, 'a.ts')).href,
      'typescript',
      controller.signal,
    )
    await waitForFile(marker)
    controller.abort(new Error('caller cancelled'))
    await expect(pending).rejects.toThrow(/caller cancelled/)
  })

  it('tears down when the initialize handshake fails during format', async () => {
    const instance = scriptInstance(FAILED_HANDSHAKE_SERVER, { shutdownTimeoutMs: 100, killGraceMs: 100 })
    await expect(instance.format({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n' }, pathToFileURL(join(ws, 'a.ts')).href, 'typescript'))
      .rejects.toThrow(/initialize exploded/)
    expect(instance.dead).toBe(true)
  })

  it('does not re-tear-down an already-dead instance when the handshake fails', async () => {
    // An immediate-exit "server" fails the handshake with the connection already dead: the instance
    // must not attempt a second teardown, only propagate the failure.
    const instance = scriptInstance('process.exit(1)', { shutdownTimeoutMs: 100, killGraceMs: 100 })
    await expect(instance.format({ filePath: 'a.ts', workspaceRoot: ws, text: 'const x = 1\n' }, pathToFileURL(join(ws, 'a.ts')).href, 'typescript'))
      .rejects.toThrow()
    expect(instance.dead).toBe(true)
  })
})

/** Probe a pid without changing its state. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
  if (process.platform !== 'linux') return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/, 1)[0]
    return !/^[ZXx]$/.test(state ?? '')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Wait until a process can no longer execute so temporary-workspace cleanup cannot race handle release. */
async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (processAlive(pid)) {
    if (Date.now() - started > timeoutMs) throw new Error(`process ${pid} did not exit`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

/** Write normally except for one method whose callback receives a deterministic transport error. */
function failingWriter(method: string): ConnectionWriter {
  return (stdin, message, done) => {
    if ((message as { method?: unknown }).method === method) {
      queueMicrotask(() => { done(new Error(`fixture ${method} failure`)) })
      return
    }
    stdin.write(encodeMessage(message), done)
  }
}

/** Wait until a fixture marker exists, bounded so a broken handshake cannot hang the test. */
async function waitForFile(path: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  for (;;) {
    try {
      await readFile(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (Date.now() - started > timeoutMs) throw new Error('waitForFile timed out')
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}
