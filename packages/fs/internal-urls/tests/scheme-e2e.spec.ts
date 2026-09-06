/**
 * Read-tool-level end-to-end routing for the newly ported schemes: with
 * `ctx.internalUrls` mounted alongside the memory plugin, `read memory://…`
 * resolves a retained entry through the tool pipeline exactly like
 * `conflict://` — no filesystem touch, no new tool code. The harness mirrors
 * `tool-routing.spec.ts` (same fake FS provider, same `ctx.tools.execute`
 * shape).
 */

import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { FileSystem, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsEditOutcome, FsEditRequest, FsInfo, FsPathInfo, FsTarget, FsWriteIntent, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as InternalUrls from '@deepseek-ai/dsh-internal-urls'
import * as Memory from '@deepseek-ai/dsh-memory'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { isAbsolute } from 'node:path'

const testToolSignal = new AbortController().signal
const CWD = '/ws'

/** In-memory fake provider (same shape as tool-routing.spec.ts). */
class FakeFs extends FileSystem {
  files = new Map<string, string>()

  canonical(path: string): string {
    return isAbsolute(path) ? path : join(CWD, path)
  }

  override async resolve(path: string): Promise<FsTarget> {
    const abs = this.canonical(path)
    return { targetKey: FsTargetKey(`abs:${abs}`), displayPath: abs }
  }
  override processPath(target: FsTarget): string {
    return String(target.targetKey).startsWith('abs:') ? String(target.targetKey).slice(4) : String(target.targetKey)
  }
  override fileUrl(target: FsTarget): string { return `file://${target.targetKey}` }
  override contains(parent: FsTarget, child: FsTarget): boolean {
    return String(child.targetKey).startsWith(String(parent.targetKey))
  }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const content = this.files.get(String(target.targetKey))
    if (content === undefined) return undefined
    return { version: FsVersion('v1'), type: 'file', size: content.length }
  }
  override async lstat(path: string): Promise<FsPathInfo | undefined> {
    const content = this.files.get(`abs:${this.canonical(path)}`)
    if (content === undefined) return undefined
    return { version: FsVersion('v1'), type: 'file', size: content.length }
  }
  override async readText(target: FsTarget): Promise<string> {
    return this.files.get(String(target.targetKey)) ?? ''
  }
  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const content = this.files.get(String(target.targetKey)) ?? ''
    return (async function* () { yield content })()
  }
  override async readBytes(target: FsTarget, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const bytes = new TextEncoder().encode(this.files.get(String(target.targetKey)) ?? '')
    if (bytes.length > maxBytes) throw new FsError(`too large: ${target.displayPath}`, 'FS_TOO_LARGE')
    return bytes
  }
  override async listDir(_target: FsTarget): Promise<FsDirEntry[]> {
    return []
  }
  override async writeText(target: FsTarget, content: string, _expected?: FsWriteIntent): Promise<FsWriteOutcome> {
    const before = this.files.get(String(target.targetKey)) ?? null
    this.files.set(String(target.targetKey), content)
    return { operation: before !== null ? 'update' : 'create', version: FsVersion('v2'), before, after: content }
  }
  override async editText(target: FsTarget, edit: FsEditRequest, _expected?: { version: FsVersion }): Promise<FsEditOutcome> {
    const content = this.files.get(String(target.targetKey)) ?? ''
    const after = content.split(edit.oldString).join(edit.newString)
    this.files.set(String(target.targetKey), after)
    return { version: FsVersion('v3'), before: content, after }
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeFs)
  await ctx.plugin(InternalUrls)
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-tool-'))
  await ctx.plugin(Memory, { root })
  await ctx.plugin(ToolFs)
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  return { ctx }
}

let callCounter = 0
const agent = { session: { header: { id: 's1', cwd: CWD } } }

async function read(ctx: Context, filePath: string) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'read',
    arguments: { file_path: filePath },
    agent: agent as never,
  })
}

describe('read tool end-to-end: memory:// through ctx.tools', () => {
  it('reads a retained entry as a virtual file window', async () => {
    const { ctx } = await setup()
    const saved = await ctx.memory.save({ cwd: CWD }, { content: 'the ported fact' })
    const result = await read(ctx, `memory://${saved.id}`)
    expect(result.isError).toBe(false)
    const value = result.value as { path: string; lines: { text: string }[] }
    expect(value.path).toBe(`memory://${saved.id}`)
    expect(value.lines.map(line => line.text).join('\n')).toContain('the ported fact')
    expect(value.lines.map(line => line.text).join('\n')).toContain(`id: ${saved.id}`)
  })

  it('reads memory://root and surfaces a corrective error for a missing id', async () => {
    const { ctx } = await setup()
    await ctx.memory.learn({ cwd: CWD }, { content: 'tool-level lesson' })
    const root = await read(ctx, 'memory://root')
    expect((root.value as { path: string }).path).toBe('memory://root')
    expect((root.value as { lines: { text: string }[] }).lines.map(line => line.text).join('\n')).toContain('tool-level lesson')

    const missing = await read(ctx, 'memory://m_nope')
    expect(missing.isError).toBe(true)
    expect(missing.content.map(block => block.type === 'text' ? block.text : '').join('')).toMatch(/does not exist/)
  })

  it('still routes conflict:// through the same registry alongside memory://', async () => {
    const { ctx } = await setup()
    expect(ctx.internalUrls.schemes()).toContain('conflict')
    expect(ctx.internalUrls.schemes()).toContain('memory')
    const saved = await ctx.memory.save({ cwd: CWD }, { content: 'coexistence' })
    const result = await read(ctx, `memory://${saved.id}`)
    expect(result.isError).toBe(false)
  })
})
