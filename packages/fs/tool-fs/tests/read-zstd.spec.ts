/**
 * Zstd-aware `read` routing: `foo.zst`/`foo.zstd`/`session.jsonl.zstd` files
 * with the zstd magic serve their decoded plaintext (concatenated frames)
 * through the standard read window; non-zstd bytes or non-UTF-8 decoded
 * content fall through to the regular text read.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsDirEntry, FsInfo, FsPathInfo, FsTarget, FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { compressZstdFrame } from '@deepseek-ai/dsh-zstd-frame'

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

function textOf(result: { content?: { type: string; text?: string }[] }): string {
  return (result.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/** A session-style artifact: header + realistic events, two concatenated frames. */
async function framedSession(): Promise<Uint8Array> {
  const header = await compressZstdFrame(
    '{"type":"session","version":0,"id":"s1","createdAt":1700000000000,"cwd":"/workspace"}\n',
  )
  const batch = await compressZstdFrame(
    '{"type":"user/message","seq":0,"time":0,"surfaceOp":"append","data":{"content":[{"type":"text","text":"hello world"}]}}\n'
    + '{"type":"assistant/message","seq":1,"time":1,"surfaceOp":"append","data":{"message":{"role":"assistant","content":[{"type":"text","text":"I will do it"}]}}}\n'
    + '{"type":"tool/call","seq":2,"time":2,"data":{"name":"write","arguments":"{\\"path\\":\\"x\\"}"}}\n'
    + '{"type":"tool/result","seq":3,"time":3,"surfaceOp":"append","data":{"message":{"role":"tool","content":[{"type":"text","text":"written"}]}}}\n'
    + '{"type":"turn/end","seq":4,"time":4,"data":{"reason":{"kind":"error","error":{"message":"oops","code":"UNKNOWN"}}}}\n',
  )
  return Buffer.concat([header, batch])
}

/** A session log where a compaction replaced the early range with a digest. */
async function framedCompactedSession(): Promise<Uint8Array> {
  const header = await compressZstdFrame(
    '{"type":"session","version":0,"id":"s2","createdAt":1700000000000,"cwd":"/workspace"}\n',
  )
  const batch = await compressZstdFrame(
    // original exchange, then a surface replacement shadowing seqs 0-2
    '{"type":"user/message","seq":0,"time":0,"surfaceOp":"append","data":{"content":[{"type":"text","text":"old question"}]}}\n'
    + '{"type":"assistant/message","seq":1,"time":1,"surfaceOp":"append","data":{"message":{"role":"assistant","content":[{"type":"text","text":"old answer"}]}}}\n'
    + '{"type":"tool/result","seq":2,"time":2,"surfaceOp":"append","data":{"message":{"role":"tool","content":[{"type":"text","text":"old result"}]}}}\n'
    + '{"type":"compaction/summary","seq":3,"time":3,"data":{"summary":[{"type":"text","text":"digest of the old exchange"}],"shadowedSeqs":[0,1,2]}}\n'
    + '{"type":"user/message","seq":4,"time":4,"surfaceOp":{"op":"replace","startSeq":0,"endSeq":2},"sourceEventSeqs":[0,3,1,2],"data":{"content":[{"type":"text","text":"digest of the old exchange"}]}}\n'
    + '{"type":"user/message","seq":5,"time":5,"surfaceOp":"append","data":{"content":[{"type":"text","text":"follow-up"}]}}\n'
    + '{"type":"assistant/message","seq":6,"time":6,"surfaceOp":"append","data":{"message":{"role":"assistant","content":[{"type":"text","text":"new answer"}]}}}\n',
  )
  return Buffer.concat([header, batch])
}

/** A single-frame generic `.zst` text file. */
async function singleFrameText(): Promise<Uint8Array> {
  return compressZstdFrame('line one\nline two\nline three\n')
}

describe('read zstd routing', () => {
  it('renders a session-style .jsonl.zstd log as a readable transcript', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:session.jsonl.zstd', await framedSession())
    const { value: result } = await readResult(ctx, 'session.jsonl.zstd')
    expect(result.path).toBe('/abs/session.jsonl')
    const text = result.lines.map(l => l.text).join('\n')
    expect(text).toContain('SESSION s1')
    expect(text).toContain('created 2023-11-14T22:13:20.000Z')
    expect(text).toContain('cwd /workspace')
    expect(text).toContain('# user')
    expect(text).toContain('hello world')
    expect(text).toContain('# assistant')
    expect(text).toContain('I will do it')
    expect(text).toContain('→ written')
    expect(text).toContain('✗ turn ended: error — oops')
    expect(result.lines[0]?.number).toBe(1)
  })

  it('shadows compacted ranges and surfaces the digest in the transcript', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:compacted.jsonl.zstd', await framedCompactedSession())
    const { value: result } = await readResult(ctx, 'compacted.jsonl.zstd')
    const text = result.lines.map(l => l.text).join('\n')
    expect(text).toContain('SESSION s2')
    // the shadowed original exchange is gone from the current surface
    expect(text).not.toContain('old question')
    expect(text).not.toContain('old answer')
    expect(text).not.toContain('old result')
    // the replacement carried the digest onto the surface
    expect(text).toContain('digest of the old exchange')
    expect(text).toContain('follow-up')
    expect(text).toContain('new answer')
    // the log-only compaction digest is rendered as a marker line
    expect(text).toContain('📦 compacted 3 events: digest of the old exchange')
  })

  it('falls back to the decoded JSONL window for a header without parsable events', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:bare.jsonl.zstd', await compressZstdFrame(
      '{"type":"session","version":0,"id":"s3","createdAt":1}\n{"type":"bogus"\n',
    ))
    const { value: result } = await readResult(ctx, 'bare.jsonl.zstd')
    const text = result.lines.map(l => l.text).join('\n')
    expect(text).toContain('"id":"s3"') // raw JSONL window, not a transcript
  })

  it('decodes a generic single-frame .zst and honors offset/limit via the standard window', async () => {
    const { ctx, fs } = await setup()
    // remove debug instrumentation from the spec now
    fs.files.set('key:data.zst', await singleFrameText())
    const { value: result } = await readResult(ctx, 'data.zst')
    expect(result.path).toBe('/abs/data')
    expect(result.totalLines).toBe(3)
    expect(result.lines.map(l => l.text)).toEqual(['line one', 'line two', 'line three'])
  })

  it('falls through to the regular read when the file lacks the zstd magic', async () => {
    const { ctx, fs } = await setup()
    fs.files.set('key:plain.zst', ENCODER.encode('plain text that is not compressed\n'))
    const { value: result } = await readResult(ctx, 'plain.zst')
    // Regular read serves the raw text (the file is valid UTF-8).
    expect(result.totalLines).toBe(1)
    expect(result.lines[0]?.text).toContain('plain text that is not compressed')
  })

  it('falls through to the regular read when there is no file (an errored read result)', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'read', { file_path: 'missing.zst' })
    expect(result.isError).toBe(true)
  })

  it('zstd extension paths are not routed when the file is a directory', async () => {
    const { ctx, fs } = await setup()
    fs.dirs.add('key:dirname.zst')
    const result = await call(ctx, 'read', { file_path: 'dirname.zst' })
    // A directory has no readable text: the regular read path rejects it.
    expect(result.isError).toBe(true)
  })

  it('throws a clear error for a structural corrupt frame stream', async () => {
    const { ctx, fs } = await setup()
    // A complete frame followed by a non-magic trailer breaks the concatenated
    // stream structurally: the scanner rejects the second magic.
    const good = Buffer.from(await compressZstdFrame('{"a":1}\n'))
    fs.files.set('key:corrupt.zstd', Buffer.concat([good, ENCODER.encode('GARBGARB')]))
    const result = await call(ctx, 'read', { file_path: 'corrupt.zstd' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('cannot decode zstd file')
    expect(textOf(result)).toContain('/abs/corrupt.zstd')
  })
})
