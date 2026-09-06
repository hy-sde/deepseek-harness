import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Lsp from '@deepseek-ai/dsh-lsp'
import type { LspQueryResult } from '@deepseek-ai/dsh-lsp'
import * as LspLocal from '@deepseek-ai/dsh-lsp-stdio'
import {
  findWorkspaceTypeScript,
  selectTypeScriptServer,
  typescriptPackageDir,
  typescriptSpeaksLsp,
} from '../src/typescript.ts'

/** A TypeScript install fixture: package.json + bin/tsc, optional lib/tsserver.js. */
async function writeTypeScriptPackage(packageDir: string, opts: { tsserver: boolean }): Promise<void> {
  await mkdir(join(packageDir, 'bin'), { recursive: true })
  await writeFile(join(packageDir, 'package.json'), '{"name":"typescript","version":"7.0.0"}\n')
  await writeFile(join(packageDir, 'bin', 'tsc'), '')
  if (opts.tsserver) {
    await mkdir(join(packageDir, 'lib'), { recursive: true })
    await writeFile(join(packageDir, 'lib', 'tsserver.js'), '')
  }
}

/** Spawn inputs standing in for the preset's `npx typescript-language-server` wrapper. */
const WRAPPER = { command: '/usr/bin/npx', args: ['--yes', 'typescript-language-server@5.0.0', '--stdio'] }
/** The switch standing in for `typescriptNative: { command: 'tsc' }`. */
const NATIVE = { command: 'tsc' }

describe('TypeScript server selection helpers', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'lsp-ts7-')))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('finds a workspace-local TypeScript install by walking up', async () => {
    await writeTypeScriptPackage(join(root, 'node_modules', 'typescript'), { tsserver: false })
    const nested = join(root, 'packages', 'app')
    await mkdir(nested, { recursive: true })
    expect(findWorkspaceTypeScript(nested)).toBe(join(root, 'node_modules', 'typescript'))
  })

  it('returns null when no workspace TypeScript install exists', async () => {
    expect(findWorkspaceTypeScript(root)).toBeNull()
  })

  describe('typescriptPackageDir / typescriptSpeaksLsp', () => {
    it('detects a classic install behind a symlinked node_modules/.bin/tsc', async () => {
      const packageDir = join(root, 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: true })
      await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
      await symlink(join('..', 'typescript', 'bin', 'tsc'), join(root, 'node_modules', '.bin', 'tsc'))
      const launcher = join(root, 'node_modules', '.bin', 'tsc')
      expect(typescriptPackageDir(launcher)).toBe(packageDir)
      expect(typescriptSpeaksLsp(launcher)).toBe(false)
    })

    it('detects a TypeScript 7 package behind a symlinked launcher', async () => {
      const packageDir = join(root, 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: false })
      await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
      await symlink(join('..', 'typescript', 'bin', 'tsc'), join(root, 'node_modules', '.bin', 'tsc'))
      expect(typescriptSpeaksLsp(join(root, 'node_modules', '.bin', 'tsc'))).toBe(true)
    })

    it('detects a global npm layout (<prefix>/lib/node_modules/typescript/bin/tsc)', async () => {
      const packageDir = join(root, 'lib', 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: false })
      const launcher = join(packageDir, 'bin', 'tsc')
      expect(typescriptPackageDir(launcher)).toBe(packageDir)
      expect(typescriptSpeaksLsp(launcher)).toBe(true)
    })

    it('returns null for an unrecognizable launcher layout', async () => {
      const launcher = join(root, 'scratch', 'tsc')
      await mkdir(dirname(launcher), { recursive: true })
      await writeFile(launcher, '')
      expect(typescriptPackageDir(launcher)).toBeNull()
      expect(typescriptSpeaksLsp(launcher)).toBe(false)
    })
  })

  describe('selectTypeScriptServer', () => {
    it('keeps the configured wrapper for a classic workspace install', async () => {
      await writeTypeScriptPackage(join(root, 'node_modules', 'typescript'), { tsserver: true })
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, null)).toEqual({
        command: WRAPPER.command,
        args: WRAPPER.args,
      })
    })

    it('spawns the workspace tsc --lsp for a TypeScript 7 workspace install', async () => {
      const packageDir = join(root, 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: false })
      await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
      await writeFile(join(root, 'node_modules', '.bin', 'tsc'), '')
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, null)).toEqual({
        command: join(root, 'node_modules', '.bin', 'tsc'),
        args: ['--lsp', '--stdio'],
      })
    })

    it('keeps the wrapper when no workspace install exists and nothing resolves on PATH', async () => {
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, null)).toEqual({
        command: WRAPPER.command,
        args: WRAPPER.args,
      })
    })

    it('uses the resolved native launcher for a TypeScript 7 install found on PATH', async () => {
      const packageDir = join(root, 'lib', 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: false })
      const launcher = join(packageDir, 'bin', 'tsc')
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, launcher)).toEqual({
        command: launcher,
        args: ['--lsp', '--stdio'],
      })
    })

    it('keeps the wrapper when the resolved launcher belongs to a classic install', async () => {
      const packageDir = join(root, 'lib', 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: true })
      const launcher = join(packageDir, 'bin', 'tsc')
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, launcher)).toEqual({
        command: WRAPPER.command,
        args: WRAPPER.args,
      })
    })

    it('prefers a classic local install over a TypeScript 7 launcher on PATH', async () => {
      const packageDir = join(root, 'node_modules', 'typescript')
      await writeTypeScriptPackage(packageDir, { tsserver: true })
      const pathTsc = join(root, 'lib', 'node_modules', 'typescript', 'bin', 'tsc')
      await writeTypeScriptPackage(join(root, 'lib', 'node_modules', 'typescript'), { tsserver: false })
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, pathTsc)).toEqual({
        command: WRAPPER.command,
        args: WRAPPER.args,
      })
    })

    it('falls back to the wrapper when a TypeScript 7 package has no spawnable launcher', async () => {
      const packageDir = join(root, 'node_modules', 'typescript')
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, 'package.json'), '{"name":"typescript"}\n')
      expect(selectTypeScriptServer({ ...WRAPPER, typescriptNative: NATIVE }, root, null)).toEqual({
        command: WRAPPER.command,
        args: WRAPPER.args,
      })
    })

    it('passes the configured command through unchanged when the switch is unset', async () => {
      await writeTypeScriptPackage(join(root, 'node_modules', 'typescript'), { tsserver: false })
      expect(selectTypeScriptServer(WRAPPER, root, null)).toEqual({
        command: WRAPPER.command,
        args: WRAPPER.args,
      })
    })
  })
})

// ---------------------------------------------------------------------------
// Provider-level wiring: selection must reach the spawned process per workspace.
// ---------------------------------------------------------------------------

/** A minimal LSP server: answers initialize and returns null for definition. */
const SERVER_SCRIPT = [
  'let b=Buffer.alloc(0);',
  'const fr=(o)=>{const x=Buffer.from(JSON.stringify({jsonrpc:"2.0",...o}));return Buffer.concat([Buffer.from(`Content-Length: ${x.length}\\r\\n\\r\\n`),x]);};',
  'process.stdin.on("data",c=>{b=Buffer.concat([b,c]);for(;;){const s=b.indexOf("\\r\\n\\r\\n");if(s<0)break;const len=Number(/(\\d+)/.exec(b.toString("ascii",0,s))[1]);if(b.length<s+4+len)break;const m=JSON.parse(b.toString("utf8",s+4,s+4+len));b=b.subarray(s+4+len);',
  'if(m.method==="initialize")process.stdout.write(fr({id:m.id,result:{capabilities:{positionEncoding:"utf-16",textDocumentSync:1,definitionProvider:true}}}));',
  'else if(m.method==="textDocument/definition")process.stdout.write(fr({id:m.id,result:null}));',
  '}});',
].join('\n')

describe('typescriptNative per-workspace selection through the provider', () => {
  let root: string
  let ws: string
  let ctx: Context

  const skipOnWindows = (): boolean => process.platform === 'win32'

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lsp-ts7-prov-'))
    ws = join(root, 'ws')
    await mkdir(ws)
    await writeFile(join(ws, 'a.ts'), 'const x = 1\n')
  })

  afterEach(async () => {
    if (ctx) await ctx.fiber.dispose()
    ctx = undefined as unknown as Context
    await rm(root, { recursive: true, force: true })
  })

  /** Boot the stack like provider.spec.ts, with one typescript server entry. */
  async function boot(server: LspLocal.LspLocalServerConfig): Promise<void> {
    ctx = new Context()
    await ctx.plugin(Lsp)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await ctx.plugin(LspLocal, { servers: { typescript: server } })
  }

  async function queryDefinition(): Promise<LspQueryResult> {
    return await ctx.lsp.query({
      operation: 'goToDefinition',
      filePath: 'a.ts',
      position: { line: 0, character: 0 },
      workspaceRoot: ws,
    })
  }

  /** An executable wrapper script that exits immediately (proves it was not selected). */
  async function writeBrokenLauncher(path: string, shebang: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${shebang}\nexit 1\n`)
    await chmod(path, 0o755)
  }

  it('spawns the native tsc --lsp for a TypeScript 7 workspace', async () => {
    if (skipOnWindows()) return
    // The workspace install is TS7 (no lib/tsserver.js); its .bin/tsc is a real LSP server.
    const packageDir = join(ws, 'node_modules', 'typescript')
    const nativeLauncher = join(ws, 'node_modules', '.bin', 'tsc')
    await writeTypeScriptPackage(packageDir, { tsserver: false })
    await mkdir(dirname(nativeLauncher), { recursive: true })
    await writeFile(nativeLauncher, `#!/usr/bin/env node\n${SERVER_SCRIPT}\n`)
    await chmod(nativeLauncher, 0o755)
    // The wrapper would crash if selected; the native launcher must win.
    const brokenWrapper = join(root, 'broken-wrapper.js')
    await writeFile(brokenWrapper, 'process.exit(1)\n')
    await boot({
      command: process.execPath,
      args: [brokenWrapper],
      extensionToLanguage: { '.ts': 'typescript' },
      typescriptNative: { command: nativeLauncher },
    })
    expect((await queryDefinition()).kind).toBe('locations')
  })

  it('keeps the configured wrapper for a classic workspace install', async () => {
    if (skipOnWindows()) return
    await writeTypeScriptPackage(join(ws, 'node_modules', 'typescript'), { tsserver: true })
    // The native launcher would crash if selected.
    const crashTsc = join(root, 'crash-tsc')
    await writeBrokenLauncher(crashTsc, '#!/bin/sh')
    const wrapperServer = join(root, 'wrapper-server.js')
    await writeFile(wrapperServer, SERVER_SCRIPT)
    await boot({
      command: process.execPath,
      args: [wrapperServer],
      extensionToLanguage: { '.ts': 'typescript' },
      typescriptNative: { command: crashTsc },
    })
    expect((await queryDefinition()).kind).toBe('locations')
  })

  it('keeps the configured wrapper when no install exists and the native command is unresolvable', async () => {
    if (skipOnWindows()) return
    const wrapperServer = join(root, 'wrapper-server.js')
    await writeFile(wrapperServer, SERVER_SCRIPT)
    await boot({
      command: process.execPath,
      args: [wrapperServer],
      extensionToLanguage: { '.ts': 'typescript' },
      typescriptNative: { command: join(root, 'no-such-tsc') },
    })
    expect((await queryDefinition()).kind).toBe('locations')
  })

  it('rejects an empty native command at load', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(Lsp)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
      await expect(ctx.plugin(LspLocal, {
        servers: {
          typescript: {
            command: process.execPath,
            args: ['--stdio'],
            extensionToLanguage: { '.ts': 'typescript' },
            typescriptNative: { command: '' },
          },
        },
      })).rejects.toThrow(/typescriptNative\.command must be non-empty/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
