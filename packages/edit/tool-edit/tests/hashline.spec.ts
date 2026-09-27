import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { computeFileHash } from '@deepseek-ai/dsh-hashline'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolEdit from '@deepseek-ai/dsh-tool-edit'

const contexts: Context[] = []
const roots: string[] = []
let callNumber = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function agent(ctx: Context, cwd: string): Agent {
  const id = SessionId(`tool-edit-hashline-${callNumber}`)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, [], { version: 4, id, createdAt: 0, cwd, isSeeded: false })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: createInboxStub(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function call(ctx: Context, owner: Agent, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`tool-edit-hashline-${++callNumber}`),
    name: 'edit',
    arguments: args,
    agent: owner,
  })
}

async function setup(config: ToolEdit.Config = {}, options: { lsp?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-hashline-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  if (options.lsp !== undefined) ctx.provide('lsp', options.lsp as never)
  const fiber = await ctx.plugin(ToolEdit, config)
  return { ctx, root, fiber, owner: agent(ctx, root) }
}

describe('tool-edit (hashline mode)', () => {
  it('replaces an anchored line range and persists the new snapshot', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'greet.py')
    const before = 'def greet(name):\n    print(f"Hi, {name}")\ngreet("world")\n'
    await writeFile(sample, before)

    const tag = computeFileHash(before)
    const input = [
      `[${sample}#${tag}]`,
      'PUT 1.=2:',
      '+def greet(name):',
      '+    print(f"Hello, {name}")',
      '',
    ].join('\n')

    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('def greet(name):\n    print(f"Hello, {name}")\ngreet("world")\n')
  })

  it('inserts rows before a line with the gap syntax', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'list.txt')
    const before = 'one\ntwo\nthree\n'
    await writeFile(sample, before)

    const tag = computeFileHash(before)
    const input = [
      `[${sample}#${tag}]`,
      'PUT <2:',
      '+inserted',
      '',
    ].join('\n')

    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('one\ninserted\ntwo\nthree\n')
  })

  it('rejects a stale tag without touching the file', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'stale.txt')
    const before = 'line one\nline two\n'
    await writeFile(sample, before)

    // A tag that hashes a DIFFERENT (stale) text must fail the anchor check.
    const staleTag = computeFileHash('completely different\n')
    const input = `[${sample}#${staleTag}]\nPUT 1.=2:\n+replacement\nline\n`

    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(true)
    expect(await readFile(sample, 'utf8')).toBe(before)
  })
})

describe('tool-edit (hashline) × tool-fs read × fs-observation-policy', () => {
  /** Full composition the GUI mounts: real backend + policy + read tool + rich editor. */
  async function fullStack() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-firsttry-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(FsPolicy)
    // read/write only from tool-fs; the literal `edit` slot is owned by tool-edit.
    await ctx.plugin(ToolFs, { enableEdit: false })
    const fiber = await ctx.plugin(ToolEdit)
    return { ctx, root, fiber, owner: agent(ctx, root) }
  }

  async function run(ctx: Context, owner: Agent, name: string, args: unknown) {
    return ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`tool-edit-firsttry-${++callNumber}`),
      name,
      arguments: args,
      agent: owner,
    })
  }

  function modelText(result: { content: { type: string; text?: string }[] }): string {
    return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
  }

  it('the read tool supplies the [path#tag] header and the edit lands on the first attempt', async () => {
    const { ctx, root, owner } = await fullStack()
    const sample = join(root, 'greet.py')
    const before = 'def greet(name):\n    print(f"Hi, {name}")\ngreet("world")\n'
    await writeFile(sample, before)

    // One read: the model must be able to copy the anchor out of the output.
    const readResult = await run(ctx, owner, 'read', { file_path: 'greet.py' })
    expect(readResult.isError).toBe(false)
    const output = modelText(readResult)
    const tag = computeFileHash(before)
    expect(output).toContain(`[${sample}#${tag}]`)

    // First edit attempt, tag copied verbatim from the read: no rejection,
    // no extra read round-trip — this is the omp "edit landed on first try"
    // contract that the observation policy must not break.
    const input = [
      `[${sample}#${tag}]`,
      'PUT 1.=2:',
      '+def greet(name):',
      '+    print(f"Hello, {name}")',
      '',
    ].join('\n')
    const editResult = await run(ctx, owner, 'edit', { input })
    expect(editResult.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('def greet(name):\n    print(f"Hello, {name}")\ngreet("world")\n')
  })

  it('a blind hashline edit lands in one call: the executor self-observes under the policy', async () => {
    const { ctx, root, owner } = await fullStack()
    const sample = join(root, 'blind.txt')
    const before = 'alpha\nbeta\n'
    await writeFile(sample, before)

    // No read tool call at all. The prepare-time read by the hashline executor
    // itself records the presence observation, so the guarded write passes
    // with the version CAS intact — omp self-contained semantics.
    const tag = computeFileHash(before)
    const input = `[${sample}#${tag}]\nPUT 1.=1:\n+ALPHA\n`
    const result = await run(ctx, owner, 'edit', { input })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('ALPHA\nbeta\n')
  })
})

describe('tool-edit (hashline mode) × edit-result line provenance', () => {
  /** Full composition with seen-line enforcement: real backend + policy + read tool + rich editor. */
  async function provenanceStack() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-provenance-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(FsPolicy)
    // read/write only from tool-fs; the literal `edit` slot is owned by tool-edit.
    await ctx.plugin(ToolFs, { enableEdit: false })
    const fiber = await ctx.plugin(ToolEdit, { enforceSeenLines: true })
    return { ctx, root, fiber, owner: agent(ctx, root) }
  }

  async function run(ctx: Context, owner: Agent, name: string, args: unknown) {
    return ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`tool-edit-provenance-${++callNumber}`),
      name,
      arguments: args,
      agent: owner,
    })
  }

  function modelText(result: { content: { type: string; text?: string }[] }): string {
    return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
  }

  /** Hashline header `[path#TAG]` tag from a rendered read/edit result. */
  function tagFrom(text: string): string | undefined {
    return /\[[^\]#]+#([0-9A-F]{4})\]/.exec(text)?.[1]
  }

  it('registers displayed edit-result rows as post-edit snapshot provenance: rejects hidden lines, accepts displayed lines', async () => {
    const { ctx, root, owner } = await provenanceStack()
    const sample = join(root, 'a.txt')
    const source = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\n'
    // Post-edit content: `NEWLINE` inserted after line 2 (13 lines).
    const edited = 'line1\nline2\nNEWLINE\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\n'
    await writeFile(sample, source)

    // Partial read: only lines 1-2 are displayed (and recorded as seen) under
    // the minted tag — the projection the upstream test starts from. The tag
    // hashes the WHOLE file, so follow-up edits anchor against the full text.
    const readResult = await run(ctx, owner, 'read', { file_path: 'a.txt', offset: 1, limit: 2 })
    expect(readResult.isError).toBe(false)
    const originalTag = tagFrom(modelText(readResult))
    expect(originalTag).toBe(computeFileHash(source))

    // First edit anchors the seen line 2 (PUT >2 = insert after). The rendered
    // rows are `1:line1`, `2:line2`, `3:NEWLINE` — row 3 was NEVER displayed by
    // the read, so registering it as seen provenance on the post-edit tag is
    // the fix under test (omp cea3caf71f). Without it the follow-up edit at
    // line 3 would be rejected as anchored on a never-displayed line.
    const first = await run(ctx, owner, 'edit', {
      input: `[${sample}#${originalTag}]\nPUT >2:\n+NEWLINE\n`,
    })
    expect(first.isError).toBe(false)
    const firstText = modelText(first)
    expect(firstText).toContain('3:NEWLINE')
    const editedTag = tagFrom(firstText)
    expect(editedTag).toBe(computeFileHash(edited))

    // (a) A line the edit result did NOT display stays rejected under the
    // post-edit tag: line 13 (the tail) was hidden under the rendered rows.
    const hidden = await run(ctx, owner, 'edit', {
      input: `[${sample}#${editedTag}]\nPUT 13.=13:\n+LINE13\n`,
    })
    expect(hidden.isError).toBe(true)
    expect(modelText(hidden)).toContain('lines 13')

    // (b) A line the edit result DID display is accepted under the same tag:
    // line 3 is anchorable because the edit result rendered it as `3:NEWLINE`
    // and registered it as seen provenance on the post-edit snapshot.
    const seen = await run(ctx, owner, 'edit', {
      input: `[${sample}#${editedTag}]\nPUT 3.=3:\n+LINE3\n`,
    })
    expect(seen.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe(
      'line1\nline2\nLINE3\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\n',
    )
  })
})
describe('tool-edit (hashline mode) × LSP writethrough', () => {
  it('persists the formatter output and reports the persisted bytes as the snapshot text', async () => {
    const { ctx, root, owner } = await setup(
      { formatOnWrite: true },
      {
        lsp: {
          format: async (request: { text: string }) => ({ formattedText: `# formatted\n${request.text}` }),
          collectDiagnostics: async () => ({ diagnostics: [] }),
        },
      },
    )
    const sample = join(root, 'list.txt')
    const before = 'one\ntwo\nthree\n'
    await writeFile(sample, before)

    const tag = computeFileHash(before)
    const input = [
      `[${sample}#${tag}]`,
      'PUT <2:',
      '+inserted',
      '',
    ].join('\n')

    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(false)
    // `WriteResult.text` is the formatted bytes, so the patcher's recorded
    // snapshot hashes the same content that now exists on disk.
    expect(await readFile(sample, 'utf8')).toBe('# formatted\none\ninserted\ntwo\nthree\n')
  })
})
