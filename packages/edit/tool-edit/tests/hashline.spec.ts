import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { computeFileHash, getSessionSnapshotStore, InMemorySnapshotStore, Patch, type PatchSection } from '@deepseek-ai/dsh-hashline'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolEdit from '@deepseek-ai/dsh-tool-edit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { computeHashlineSectionDiff } from '../src/hashline/diff.ts'
import { carriedSeenLines } from '../src/hashline/execute.ts'
import type { FileReader } from '../src/session.ts'

const contexts: Context[] = []
const roots: string[] = []
let callNumber = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function agent(ctx: Context, cwd: string): Agent {
  const id = SessionId(`tool-edit-hashline-${callNumber}`)
  const scope = ctx.plugin(() => { })
  const session = Session.create(id, [], { version: 4, id, createdAt: 0, cwd, isSeeded: false })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: createInboxStub(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => { },
    followup: () => { },
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => { },
    cancel() { },
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

  it('names the origin file when a tag was minted for another file in this session', async () => {
    const { ctx, root, owner } = await setup()
    // Mint a real tag for origin.txt through an edit; the store then holds
    // origin.txt under its post-edit hash.
    const origin = join(root, 'origin.txt')
    const originBefore = 'origin line one\norigin line two\n'
    await writeFile(origin, originBefore)
    const originEdit = await call(ctx, owner, {
      input: `[${origin}#${computeFileHash(originBefore)}]\nPUT 1.=1:\n+origin line one (edited)\n`,
    })
    expect(originEdit.isError).toBe(false)

    const sample = join(root, 'sample.txt')
    const before = 'line one\nline two\n'
    await writeFile(sample, before)
    // Reuse origin.txt's post-edit tag on sample.txt: a tag this session
    // really issued, just for another file — the rejection names it.
    const foreignTag = computeFileHash('origin line one (edited)\norigin line two\n')
    const input = `[${sample}#${foreignTag}]\nPUT 1.=1:\n+replacement\n`

    const result = await call(ctx, owner, { input })
    expect(result.isError).toBe(true)
    const modelText = result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
    expect(modelText).toContain(`was issued in this session for ${origin}`)
    expect(await readFile(sample, 'utf8')).toBe(before)
  })

  it('replies with the current tag when the input carries only a header (no ops)', async () => {
    const { ctx, root, owner } = await setup()
    const sample = join(root, 'only-header.txt')
    const before = 'line one\nline two\n'
    await writeFile(sample, before)

    // Header with zero ops under it: the reply names the file's current
    // tag so the model re-issues the ops under it (oh-my-pi 6dec51c4dd).
    const result = await call(ctx, owner, { input: `[${sample}]\n` })
    expect(result.isError).toBe(true)
    const modelText = result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
    expect(modelText).toContain('no ops follow the header')
    expect(modelText).toContain(`#${computeFileHash(before)}`)
    expect(await readFile(sample, 'utf8')).toBe(before)
  })

  it('points at the write tool when a header-only input names a missing file', async () => {
    const { ctx, root, owner } = await setup()

    const result = await call(ctx, owner, { input: `[${join(root, 'ghost.txt')}]\n` })
    expect(result.isError).toBe(true)
    const modelText = result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
    expect(modelText).toContain('File not found')
    expect(modelText).toContain('Use the write tool to create new files')
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
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: root })
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
    const canonicalSample = await realpath(sample)
    expect(output).toContain(`[${canonicalSample}#${tag}]`)

    // First edit attempt, tag copied verbatim from the read: no rejection,
    // no extra read round-trip — this is the omp "edit landed on first try"
    // contract that the observation policy must not break.
    const input = [
      `[${canonicalSample}#${tag}]`,
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

describe('tool-edit (hashline mode) × edit-result seen-line registration', () => {
  /** Full composition with seen-line enforcement: real backend + policy + read tool + rich editor. */
  async function seenLineStack() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-seenlines-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: root })
    await ctx.plugin(FsPolicy)
    // read/write only from tool-fs; the literal `edit` slot is owned by tool-edit.
    await ctx.plugin(ToolFs, { enableEdit: false })
    const fiber = await ctx.plugin(ToolEdit, { enforceSeenLines: true })
    return { ctx, root, fiber, owner: agent(ctx, root) }
  }

  async function run(ctx: Context, owner: Agent, name: string, args: unknown) {
    return ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`tool-edit-seenlines-${++callNumber}`),
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

  it('registers displayed edit-result rows as post-edit snapshot seen lines: rejects hidden lines, accepts displayed lines', async () => {
    const { ctx, root, owner } = await seenLineStack()
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
    // the read, so registering it as a seen line on the post-edit tag is
    // the fix under test (omp's seen-line registration). Without it the follow-up edit at
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
    // and registered it as a seen line on the post-edit snapshot.
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

describe('tool-edit (hashline mode) × default seen-line enforcement', () => {
  /** Default settings (no explicit enforceSeenLines): regression ported from omp's default seen-line enforcement. */
  async function defaultStack() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-seenlines-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: root })
    await ctx.plugin(FsPolicy)
    await ctx.plugin(ToolFs, { enableEdit: false })
    // No config — the flip under test is the DEFAULT.
    const fiber = await ctx.plugin(ToolEdit)
    return { ctx, root, fiber, owner: agent(ctx, root) }
  }

  const DRAW_SOURCE = [
    'def draw(sheet, anchor, alpha, beta):',
    '    add_native_hole_callout(sheet=sheet,',
    '        nested=nested(alpha,',
    '            beta),',
    '        point=model_point_in_view(',
    '            anchor),',
    '        callout_xy=(0.230, 0.258))',
    '',
  ].join('\n')

  function modelText(result: { content: { type: string; text?: string }[] }): string {
    return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
  }

  it('rejects a hunk anchored on a line the read elided (default settings)', async () => {
    const { ctx, root, owner } = await defaultStack()
    const sample = join(root, 'draw.py')
    await writeFile(sample, DRAW_SOURCE)

    // Simulate a ranged read displaying lines 1,2,5,6,7 while eliding 3-4:
    // the same seen-set the harness read tool records for `draw.py:7-7`.
    const store = getSessionSnapshotStore(owner.session)
    const tag = store.record(sample, DRAW_SOURCE, [1, 2, 5, 6, 7])

    const result = await call(ctx, owner, {
      input: `[${sample}#${tag}]\nPUT 4.=4:\n+            beta, gamma),\n`,
    })
    expect(result.isError).toBe(true)
    expect(modelText(result)).toContain('never displayed')
    expect(await readFile(sample, 'utf8')).toBe(DRAW_SOURCE)
  })

  it('applies a hunk anchored on a line the read displayed (default settings)', async () => {
    const { ctx, root, owner } = await defaultStack()
    const sample = join(root, 'draw.py')
    await writeFile(sample, DRAW_SOURCE)

    // Read displayed lines 1,2,5,6,7; line 7 is seen, so its edit applies.
    const store = getSessionSnapshotStore(owner.session)
    const tag = store.record(sample, DRAW_SOURCE, [1, 2, 5, 6, 7])

    const result = await call(ctx, owner, {
      input: `[${sample}#${tag}]\nPUT 7.=7:\n+        callout_xy=(0.240, 0.258))\n`,
    })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe(DRAW_SOURCE.replace('0.230', '0.240'))
  })
})

describe('tool-edit (hashline mode) × column-cut wide lines (upstream #15649)', () => {
  /** Full composition with seen-line enforcement: real backend + policy + read tool + rich editor. */
  async function seenLineStack() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-widelines-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: root })
    await ctx.plugin(FsPolicy)
    await ctx.plugin(ToolFs, { enableEdit: false })
    const fiber = await ctx.plugin(ToolEdit, { enforceSeenLines: true })
    return { ctx, root, fiber, owner: agent(ctx, root) }
  }

  async function run(ctx: Context, owner: Agent, name: string, args: unknown) {
    return ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`tool-edit-widelines-${++callNumber}`),
      name,
      arguments: args,
      agent: owner,
    })
  }

  function modelText(result: { content: { type: string; text?: string }[] }): string {
    return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
  }

  function tagFrom(text: string): string | undefined {
    return /\[[^\]#]+#([0-9A-F]{4})\]/.exec(text)?.[1]
  }

  it('rejects a PUT on a column-cut wide line until a full-width re-read shows it', async () => {
    const { ctx, root, owner } = await seenLineStack()
    const sample = join(root, 'wide.txt')
    const wide = `${'a'.repeat(3000)}TAIL`
    const source = `${wide}\nshort\n`
    await writeFile(sample, source)

    // Default read: line 1 displays truncated at the 2000-char column cap (with
    // its per-line suffix); the tag hashes the whole file.
    const readResult = await run(ctx, owner, 'read', { file_path: 'wide.txt' })
    expect(readResult.isError).toBe(false)
    const originalText = modelText(readResult)
    const originalTag = tagFrom(originalText)
    expect(originalTag).toBe(computeFileHash(source))
    expect(originalText).toContain('(line truncated to 2000 chars)')

    // PUT the truncated prefix: the pre-fix tree applied this and silently
    // dropped the tail beyond the column cap; the guard now rejects it and
    // names the full-width re-read remedy.
    const truncated = 'a'.repeat(2000)
    const rejected = await run(ctx, owner, 'edit', {
      input: `[${sample}#${originalTag}]\nPUT 1.=1:\n+${truncated}\n`,
    })
    expect(rejected.isError).toBe(true)
    expect(modelText(rejected)).toContain('not fully displayed')
    expect(modelText(rejected)).toContain('maxLineLength')
    expect(await readFile(sample, 'utf8')).toBe(source)

    // Retrying the same blind payload keeps rejecting: the tail is still unseen.
    const retry = await run(ctx, owner, 'edit', {
      input: `[${sample}#${originalTag}]\nPUT 1.=1:\n+${truncated}\n`,
    })
    expect(retry.isError).toBe(true)
    expect(await readFile(sample, 'utf8')).toBe(source)

    // Full-width re-read: the wide line displays in full and registers as seen
    // under the reused tag (content unchanged), so the tail-preserving edit applies.
    const reread = await run(ctx, owner, 'read', { file_path: 'wide.txt', maxLineLength: 1_000_000 })
    expect(reread.isError).toBe(false)
    expect(modelText(reread)).toContain('TAIL')
    expect(tagFrom(modelText(reread))).toBe(originalTag)

    const replacement = `b${wide.slice(1)}`
    const applied = await run(ctx, owner, 'edit', {
      input: `[${sample}#${originalTag}]\nPUT 1.=1:\n+${replacement}\n`,
    })
    expect(applied.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe(`${replacement}\nshort\n`)
  })

  it('applies a PUT on a short line from the original wide-line read', async () => {
    const { ctx, root, owner } = await seenLineStack()
    const sample = join(root, 'wide2.txt')
    await writeFile(sample, `${'a'.repeat(3000)}\nshort\n`)

    const readResult = await run(ctx, owner, 'read', { file_path: 'wide2.txt' })
    expect(readResult.isError).toBe(false)
    const tag = tagFrom(modelText(readResult))
    expect(tag).toBeDefined()

    // Line 2 was fully displayed by the first read, so it stays anchorable even
    // though line 1 was column-cut and skipped from seen registration.
    const result = await run(ctx, owner, 'edit', {
      input: `[${sample}#${tag}]\nPUT 2.=2:\n+SHORT\n`,
    })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe(`${'a'.repeat(3000)}\nSHORT\n`)
  })

  it('rejects edits on a read whose every displayed line was column-cut', async () => {
    const { ctx, root, owner } = await seenLineStack()
    const sample = join(root, 'only-wide.txt')
    const source = `${'a'.repeat(3000)}\n`
    await writeFile(sample, source)

    // An all-cut read still records seen-state (a non-anchor sentinel): without
    // it the empty seen set would read as unrestricted and let the edit through.
    const readResult = await run(ctx, owner, 'read', { file_path: 'only-wide.txt' })
    expect(readResult.isError).toBe(false)
    const tag = tagFrom(modelText(readResult))
    expect(tag).toBeDefined()

    const result = await run(ctx, owner, 'edit', {
      input: `[${sample}#${tag}]\nPUT 1.=1:\n+${'a'.repeat(2000)}\n`,
    })
    expect(result.isError).toBe(true)
    expect(modelText(result)).toContain('maxLineLength')
    expect(await readFile(sample, 'utf8')).toBe(source)
  })

  it('applies an edit anchored under an empty seen set (write-minted tag record)', async () => {
    const { ctx, root, owner } = await seenLineStack()
    const sample = join(root, 'fastpath.txt')
    const source = 'one\ntwo\n'
    await writeFile(sample, source)

    // A write-minted tag records seen-state with NO displayed rows: an empty
    // seen set means unrestricted (the write-tag fast path), so any
    // anchor applies without a re-read.
    const store = getSessionSnapshotStore(owner.session)
    const tag = store.record(sample, source, [])

    const result = await run(ctx, owner, 'edit', {
      input: `[${sample}#${tag}]\nPUT 2.=2:\n+TWO\n`,
    })
    expect(result.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('one\nTWO\n')
  })
})

describe('tool-edit (hashline) × diff-preview mismatch origin', () => {
  it('names the tag origin path in the preview mismatch error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-preview-'))
    roots.push(root)
    const snapshots = new InMemorySnapshotStore()
    const origin = join(root, 'origin.txt')
    const originTag = snapshots.record(origin, 'origin line\n')
    const sample = join(root, 'sample.txt')
    const before = 'line one\nline two\n'
    await writeFile(sample, before)
    const reader: FileReader = {
      resolve: async path => ({ targetKey: FsTargetKey(path), displayPath: path }),
      stat: async () => undefined,
      readText: async target => readFile(target.displayPath, 'utf8'),
    }

    // The preview shares the apply-time rejection shape: a tag issued for
    // another file names that file instead of dead-ending.
    const patch = Patch.parse(`[${sample}#${originTag}]\nPUT 1.=1:\n+replacement\n`)
    const result = await computeHashlineSectionDiff(patch.sections[0] as PatchSection, root, snapshots, { reader })

    expect('error' in result && result.error).toContain(`was issued in this session for ${origin}`)
    expect(await readFile(sample, 'utf8')).toBe(before)
  })
})

describe('tool-edit (hashline mode) × carried read seen lines', () => {
  /** Composition with seen-line enforcement, as the GUI mounts it. */
  async function carriedStack() {
    const root = await mkdtemp(join(tmpdir(), 'dsh-tool-edit-carried-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: root })
    await ctx.plugin(FsPolicy)
    await ctx.plugin(ToolFs, { enableEdit: false })
    const fiber = await ctx.plugin(ToolEdit, { enforceSeenLines: true })
    return { ctx, root, fiber, owner: agent(ctx, root) }
  }

  async function run(ctx: Context, owner: Agent, name: string, args: unknown) {
    return ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`tool-edit-carried-${++callNumber}`),
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

  /** 40-line file whose line 35 the read displayed. */
  function fortyLines(): { lines: string[]; source: string } {
    const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`)
    return { lines, source: `${lines.join('\n')}\n` }
  }

  it('keeps a displayed line anchorable across a line-neutral hunk elsewhere in the file', async () => {
    const { ctx, root, owner } = await carriedStack()
    const sample = join(root, 'neutral.txt')
    const { lines, source } = fortyLines()
    await writeFile(sample, source)
    const store = getSessionSnapshotStore(owner.session)
    const tag = store.record(sample, source, lines.map((_, i) => i + 1))

    // Insert above line 35 and cut below it — net-zero, so line 35 keeps
    // its number and content. The rendered result only previews the touched
    // hunks, so without carried seen lines line 35 would go unseen on the
    // post-edit tag and the follow-up edit would bounce.
    const first = await run(ctx, owner, 'edit', {
      input: `[${sample}#${tag}]\nPUT <10:\n+inserted line\nCUT 30\n`,
    })
    expect(first.isError).toBe(false)
    const edited = [...lines.slice(0, 9), 'inserted line', ...lines.slice(9, 29), ...lines.slice(30)]
    const editedTag = tagFrom(modelText(first))
    expect(editedTag).toBe(computeFileHash(`${edited.join('\n')}\n`))

    const followup = await run(ctx, owner, 'edit', {
      input: `[${sample}#${editedTag}]\nPUT 35.=35:\n+line35 (edited)\n`,
    })
    expect(followup.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe(
      `${[...edited.slice(0, 34), 'line35 (edited)', ...edited.slice(35)].join('\n')}\n`,
    )
  })

  it('does not carry a line the edit shifted — its old number names other content', async () => {
    const { ctx, root, owner } = await carriedStack()
    const sample = join(root, 'shifted.txt')
    const { lines, source } = fortyLines()
    await writeFile(sample, source)
    const store = getSessionSnapshotStore(owner.session)
    const tag = store.record(sample, source, lines.map((_, i) => i + 1))

    const first = await run(ctx, owner, 'edit', {
      input: `[${sample}#${tag}]\nPUT <10:\n+inserted line\nCUT 30\n`,
    })
    expect(first.isError).toBe(false)
    const edited = [...lines.slice(0, 9), 'inserted line', ...lines.slice(9, 29), ...lines.slice(30)]
    const editedTag = tagFrom(modelText(first))

    // Old line 16 now sits at 17; number 16 names line15. Carried
    // seen-line tracking covers only unshifted lines, so the stale anchor rejects.
    const stale = await run(ctx, owner, 'edit', {
      input: `[${sample}#${editedTag}]\nPUT 16.=16:\n+line16 (edited)\n`,
    })
    expect(stale.isError).toBe(true)
    expect(await readFile(sample, 'utf8')).toBe(`${edited.join('\n')}\n`)
  })

  it('registers carried lines even when the write drifts from the previewed text', async () => {
    const { ctx, root, owner } = await setup(
      { formatOnWrite: true },
      {
        lsp: {
          // Idempotent, like real formatters: the append happens once, so
          // the follow-up write does not drift again.
          format: async (request: { text: string }) => ({
            formattedText: request.text.endsWith('// trailing comment\n')
              ? request.text
              : `${request.text}// trailing comment\n`,
          }),
          collectDiagnostics: async () => ({ diagnostics: [] }),
        },
      },
    )
    const sample = join(root, 'drift.txt')
    const source = 'line1\nline2\nline3\nline4\nline5\n'
    await writeFile(sample, source)
    const store = getSessionSnapshotStore(owner.session)
    const tag = store.record(sample, source, [1, 2, 3, 4, 5])

    // The formatter appends a line: what lands differs from the previewed
    // `after`, so the rendered rows register nothing — but lines 1, 3-5
    // kept their number and content and carry to the persisted tag.
    const first = await run(ctx, owner, 'edit', { input: `[${sample}#${tag}]\nPUT 2.=2:\n+line2 (edited)\n` })
    expect(first.isError).toBe(false)
    const editedTag = tagFrom(modelText(first))
    expect(editedTag).toBe(computeFileHash('line1\nline2 (edited)\nline3\nline4\nline5\n// trailing comment\n'))

    const followup = await run(ctx, owner, 'edit', {
      input: `[${sample}#${editedTag}]\nPUT 4.=4:\n+line4 (edited)\n`,
    })
    expect(followup.isError).toBe(false)
    expect(await readFile(sample, 'utf8')).toBe('line1\nline2 (edited)\nline3\nline4 (edited)\nline5\n// trailing comment\n')
  })

  it('carries only unshifted runs; a missing prior lets every unshifted line carry', async () => {
    const before = 'a\nb\nc\nd\ne\n'
    // Net-zero hunk at the top: c/d/e keep number and content; the leading
    // run carries too; the changed line does not.
    const after = 'A\nb\nc\nd\ne\n'
    expect(carriedSeenLines(before, after, new Set([1, 2, 5]))).toEqual([2, 5])
    // No prior snapshot (or an unrestricted one): every unshifted line
    // carries, since the edit could anchor anywhere. The rewrite models as
    // remove+add, so the equal run starts at 2; the trailing split artifact
    // rides along, exactly as upstream's split does.
    expect(carriedSeenLines(before, after, undefined)).toEqual([2, 3, 4, 5, 6])
    // Pure shift: nothing keeps its number, nothing carries.
    expect(carriedSeenLines('x\na\nb\nc\nd\ne\n', before, new Set([1, 2, 3, 4, 5]))).toEqual([])
  })
})
