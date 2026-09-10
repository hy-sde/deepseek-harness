/**
 * Archive-aware `read` routing: `archive.ext`, `archive.ext:dir`, and
 * `archive.ext:dir/file.txt` serve member listings / text through the ported
 * `fs-archive` engine; non-archive paths fall through to the regular text read.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsPathInfo, FsTarget, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { encodeArchive } from '@deepseek-ai/dsh-fs-archive'

const testToolSignal = new AbortController().signal
const ENCODER = new TextEncoder()

/** A fake provider whose values are typed byte arrays (binary-capable). */
class ByteFs extends FileSystem {
  files = new Map<string, Uint8Array>()
  dirs = new Set<string>()

  override async resolve(path: string): Promise<FsTarget> {
    return { targetKey: FsTargetKey(`key:${path}`), displayPath: `/abs/${path}` }
  }
  override processPath(target: FsTarget): string { return String(target.targetKey) }
  override fileUrl(target: FsTarget): string { return `file://${target.targetKey}` }
  override contains(): boolean { return true }
  override async stat(target: FsTarget): Promise<FsInfo | undefined> {
    const key = String(target.targetKey)
    const bytes = this.files.get(key)
    if (bytes !== undefined) return { version: FsVersion('v1'), type: 'file', size: bytes.byteLength }
    if (this.dirs.has(key)) return { version: FsVersion('v1'), type: 'directory' }
    return undefined
  }
  override async lstat(_path: string): Promise<FsPathInfo | undefined> { return undefined }
  override async readText(target: FsTarget): Promise<string> {
    return new TextDecoder().decode(this.files.get(String(target.targetKey)) ?? new Uint8Array())
  }
  override async streamText(target: FsTarget): Promise<AsyncIterable<string>> {
    const content = await this.readText(target)
    return (async function* () { yield content })()
  }
  override async readBytes(target: FsTarget, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const bytes = this.files.get(String(target.targetKey))
    if (bytes === undefined) return new Uint8Array()
    if (bytes.byteLength > maxBytes) {
      throw new FsError(`too large: ${target.displayPath}`, 'FS_TOO_LARGE')
    }
    return bytes
  }
  override async readByteRange(target: FsTarget, range: { offset: number; length: number }, _signal?: AbortSignal): Promise<Uint8Array> {
    const bytes = this.files.get(String(target.targetKey))
    if (bytes === undefined) return new Uint8Array()
    return bytes.subarray(range.offset, range.offset + range.length)
  }
  override async listDir(_target: FsTarget): Promise<FsDirEntry[]> { return [] }
  override async writeText(target: FsTarget, content: string): Promise<FsWriteOutcome> {
    const before = this.files.get(String(target.targetKey)) ?? null
    this.files.set(String(target.targetKey), ENCODER.encode(content))
    return {
      operation: before !== null ? 'update' : 'create',
      version: FsVersion('v2'),
      before: before !== null ? new TextDecoder().decode(before) : null,
      after: content,
    }
  }
  override async editText(
    target: FsTarget,
    edit: { oldString: string; newString: string },
  ): Promise<{ version: FsVersion; before: string; after: string }> {
    const content = new TextDecoder().decode(this.files.get(String(target.targetKey)) ?? new Uint8Array())
    const after = content.split(edit.oldString).join(edit.newString)
    this.files.set(String(target.targetKey), ENCODER.encode(after))
    return { version: FsVersion('v3'), before: content, after }
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ByteFs)
  await ctx.plugin(ToolFs)
  const fs = ctx.fs as ByteFs
  return { ctx, fs }
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
  })
}

function readResult(ctx: Context, path: string): Promise<{ value: ReadValue }> {
  return call(ctx, 'read', { file_path: path }) as Promise<never>
}

interface ReadValue {
  path: string
  offset: number
  lines: { number: number; text: string }[]
  totalLines: number
}

/** A small zip with a top-level text member, a directory, and a binary member. */
async function fixtureZip(): Promise<Uint8Array> {
  return encodeArchive('zip', [
    ['hello.txt', ENCODER.encode('hello archive\nsecond line\n')],
    ['notes/guide.md', ENCODER.encode('# Guide\nteaser\n')],
    ['notes/data.bin', new Uint8Array([0x00, 0x42, 0xff, 0x00])],
  ])
}

describe('read archive routing', () => {
  it('lists the archive root for a bare archive path', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:fixture.zip', await fixtureZip())
    const { value: result } = await readResult(ctx, 'fixture.zip')
    const text = result.lines.map(l => l.text).join('\n')
    expect(text).toContain('hello.txt')
    expect(text).toContain('notes/')
  })

  it('lists an inner directory by archive:dir path', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:fixture.zip', await fixtureZip())
    const { value: result } = await readResult(ctx, 'fixture.zip:notes')
    const text = result.lines.map(l => l.text).join('\n')
    expect(text).toContain('guide.md')
    expect(text).toContain('data.bin')
  })

  it('reads a text member by archive:path', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:fixture.zip', await fixtureZip())
    const { value: result } = await readResult(ctx, 'fixture.zip:hello.txt')
    expect(result.totalLines).toBe(2)
    expect(result.lines[0]?.text).toContain('hello archive')
  })

  it('reports binary members without decoding them', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:fixture.zip', await fixtureZip())
    const { value: result } = await readResult(ctx, 'fixture.zip:notes/data.bin')
    expect(result.totalLines).toBe(1)
    expect(result.lines[0]?.text).toContain('Cannot read binary')
  })

  it('falls through to the regular read for non-archive paths', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:report.txt', ENCODER.encode('plain text\n'))
    const { value: result } = await readResult(ctx, 'report.txt')
    expect(result.totalLines).toBe(1)
    expect(result.lines[0]?.text).toContain('plain text')
  })

  it('throws a not-found error for a missing member inside an existing archive', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:fixture.zip', await fixtureZip())
    const result = await readResult(ctx, 'fixture.zip:nope.txt')
    expect(result).toMatchObject({ isError: true })
  })
})
