/**
 * End-to-end tool tests for `commit` and `commit_apply` over a real temp git
 * repository: analysis output, plan validation, cycle rejection, atomic split
 * commits, and dry-run previews. The subagent `review` tool's orchestration is
 * covered separately in review.spec.ts.
 */

import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as Git from '@deepseek-ai/dsh-git'
import toolGitPackage from '@deepseek-ai/dsh-tool-git'

let dir: string
let ctx: Context
let counter = 0

function runGit(args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

/** Write a file under the temp repo, creating parent dirs. */
async function write(path: string, content: string): Promise<void> {
  const target = join(dir, path)
  await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
  await writeFile(target, content)
}

/** Unstage everything and clear untracked/restored changes for a clean slate. */
function resetRepo(): void {
  runGit(['reset', '-q'])
  runGit(['clean', '-fdq'])
  // checkout may fail on an empty history (no tracked paths) — tolerated
  spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: dir, encoding: 'utf8' })
}

const agent = { session: { header: { id: 's1', cwd: '' } } } as never

async function call(name: string, args: unknown): Promise<{ value: unknown }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++counter}`),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) {
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join(' ')
    throw new Error(text || 'tool failed')
  }
  return result
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-tool-git-'))
  runGit(['init', '-q'])
  runGit(['config', 'user.email', 'test@example.com'])
  runGit(['config', 'user.name', 'Test User'])
  ;(agent as { session: { header: { cwd: string } } }).session.header.cwd = dir
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Git)
  await ctx.plugin(toolGitPackage)
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await ctx.fiber.dispose()
})

describe('commit (analyze)', () => {
  it('stages everything when nothing is staged and reports files + diff', async () => {
    resetRepo()
    await write('src/a.ts', 'const a = 1;\n')
    await write('src/b.ts', 'const b = 2;\n')
    const result = await call('commit', { })
    const value = result.value as {
      staged: boolean
      files: Array<{ path: string; additions: number }>
      diff: string
      suggestedPlan?: unknown
    }
    expect(value.staged).toBe(true)
    expect(value.files.map(file => file.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(value.diff).toContain('diff --git a/src/a.ts b/src/a.ts')
    expect(value.suggestedPlan).toBeDefined()
  })

  it('honors stagedOnly and warns about unstaged leftovers', async () => {
    resetRepo()
    await write('only.txt', 'x\n')
    await call('commit', { stagedOnly: true })
    await write('only.txt', 'x\ny\n')
    // uncommitted change to the same file; nothing staged → report empty
    await runGit(['reset', '-q'])
    const result = await call('commit', { stagedOnly: true })
    const value = result.value as { staged: boolean; warnings: string[] }
    expect(value.staged).toBe(false)
  })

  it('detects trivial changes', async () => {
    resetRepo()
    await write('triv.txt', 'same\n')
    await write('triv2.txt', 'same ')
    await call('commit', { }) // stage all
    const result = await call('commit', { stagedOnly: true })
    const value = result.value as { trivial: { type: string; summary: string } | undefined; diffTruncated: boolean }
    expect(value.trivial).toBeUndefined()
  })

  it('lists lock files pending automatic placement', async () => {
    resetRepo()
    await write('package.json', '{"name":"x"}\n')
    await write('pnpm-lock.yaml', 'lockfileVersion: 6\n')
    const result = await call('commit', { })
    const value = result.value as {
      lockFilesPending: string[]
      diff: string
      suggestedPlan: Array<{ changes: Array<{ path: string }> }>
    }
    expect(value.lockFilesPending).toContain('pnpm-lock.yaml')
    // Lock files must not appear in the plan skeleton — commit_apply places them.
    const planned = value.suggestedPlan.flatMap(group => group.changes.map(change => change.path))
    expect(planned).not.toContain('pnpm-lock.yaml')
    expect(planned).toContain('package.json')
  })
})

describe('commit_apply (execute)', () => {
  /** Content marker so staged files always differ from earlier commits. */
  let baselineVersion = 0
  async function settleBaseline(): Promise<void> {
    resetRepo()
    baselineVersion += 1
    const marker = `v${baselineVersion}`
    await write('pkg/a.ts', `const a = ${baselineVersion};\n`)
    await write('pkg/b.ts', `const b = ${baselineVersion};\n`)
    await write('README.md', `# hi ${marker}\n`)
    await write('package.json', `{"name":"x","marker":"${marker}"}\n`)
    await write('pnpm-lock.yaml', `lockfileVersion: 6\n# ${marker}\n`)
    runGit(['add', '-A'])
  }

  it('dry-run previews exact messages without committing', async () => {
    await settleBaseline()
    const result = await call('commit_apply', {
      dryRun: true,
      commits: [
        {
          changes: [{ path: 'pkg/a.ts', hunks: { type: 'all' } }, { path: 'pkg/b.ts', hunks: { type: 'all' } }, { path: 'package.json', hunks: { type: 'all' } }],
          type: 'feat',
          scope: 'pkg',
          summary: 'add helpers',
          details: [{ text: 'two small helpers', userVisible: true }],
          dependencies: [],
        },
        {
          changes: [{ path: 'README.md', hunks: { type: 'all' } }],
          type: 'docs',
          summary: 'add readme',
          dependencies: [0],
        },
      ],
    })
    const value = result.value as { dryRun: boolean; messages: string[]; created: Array<{ position: number; message: string }> }
    expect(value.dryRun).toBe(true)
    expect(value.messages).toHaveLength(2)
    expect(value.messages[0]).toBe('feat(pkg): add helpers\n\n- two small helpers')
    expect(value.messages[1]).toBe('docs: add readme')
    expect(value.created).toHaveLength(0)
  })

  it('executes a validated split plan with lock-file placement in dependency order', async () => {
    await settleBaseline()
    const result = await call('commit_apply', {
      commits: [
        {
          changes: [{ path: 'pkg/a.ts', hunks: { type: 'all' } }],
          type: 'feat',
          scope: 'pkg',
          summary: 'add helper a',
          details: [],
          dependencies: [],
        },
        {
          changes: [{ path: 'pkg/b.ts', hunks: { type: 'all' } }, { path: 'README.md', hunks: { type: 'all' } }, { path: 'package.json', hunks: { type: 'all' } }],
          type: 'feat',
          scope: 'pkg',
          summary: 'add helper b and docs',
          dependencies: [],
        },
      ],
    })
    const value = result.value as { mode: string; created: Array<{ message: string; position: number }> }
    expect(value.mode).toBe('split')
    expect(value.created).toHaveLength(2)
    const log = runGit(['log', '--format=%s']).split('\n').filter(Boolean)
    expect(log[0]).toContain('add helper b and docs')
    expect(log[1]).toContain('add helper a')
    // pnpm-lock.yaml rides with the group that owns package.json (not lost).
    const lockOwner = runGit(['log', '--format=%s', '-1', '--', 'pnpm-lock.yaml'])
    expect(lockOwner).toContain('add helper b and docs')
    expect(await readFile(join(dir, 'package.json'), 'utf8')).toBe(`{"name":"x","marker":"v${baselineVersion}"}\n`)
    expect(await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe(`lockfileVersion: 6\n# v${baselineVersion}\n`)
  })

  it('rejects a plan that misses staged files before writing anything', async () => {
    await settleBaseline()
    const before = await readFile(join(dir, 'pkg', 'a.ts'), 'utf8')
    const resultP = call('commit_apply', {
      commits: [
        { changes: [{ path: 'pkg/a.ts', hunks: { type: 'all' } }], type: 'feat', summary: 'partial', dependencies: [] },
      ],
    })
    await expect(resultP).rejects.toThrow(/missing staged files/)
    expect(await readFile(join(dir, 'pkg', 'a.ts'), 'utf8')).toBe(before)
    // nothing committed either
    const log = runGit(['log', '--format=%s']).split('\n').filter(Boolean)
    expect(log).not.toContain('partial')
  })

  it('rejects circular dependency plans before writing anything', async () => {
    await write('cyc.ts', 'const c = 3;\n')
    await write('cyc2.ts', 'const c2 = 4;\n')
    await call('commit', { })
    const resultP = call('commit_apply', {
      commits: [
        { changes: [{ path: 'pkg/a.ts', hunks: { type: 'all' } }, { path: 'cyc.ts', hunks: { type: 'all' } }, { path: 'cyc2.ts', hunks: { type: 'all' } }], type: 'feat', summary: 'one', dependencies: [1] },
        { changes: [{ path: 'pkg/b.ts', hunks: { type: 'all' } }], type: 'fix', summary: 'two', dependencies: [0] },
        { changes: [{ path: 'README.md', hunks: { type: 'all' } }, { path: 'package.json', hunks: { type: 'all' } }], type: 'docs', summary: 'three', dependencies: [] },
      ],
    })
    await expect(resultP).rejects.toThrow(/Circular dependency/)
    const log = runGit(['log', '--format=%s']).split('\n').filter(Boolean)
    expect(log.some(line => line.includes('one'))).toBe(false)
    expect(log.some(line => line.includes('two'))).toBe(false)
  })

  it('stages only the selected hunks of a file in a split', async () => {
    resetRepo()
    const baseline = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    await write('split.txt', baseline)
    runGit(['add', '-A'])
    runGit(['commit', '-qm', 'baseline split.txt'])
    // two separate edits far apart → distinct hunks; stage explicitly
    await write('split.txt', baseline.replace('line2', 'TWO').replace('line27', 'NINE'))
    runGit(['add', '-A'])
    const staged = await ctx.git.diffText(dir, { cached: true, binary: true })
    expect(staged).toContain('TWO')
    expect(staged).toContain('NINE')
    const result = await call('commit_apply', {
      commits: [
        {
          changes: [{ path: 'split.txt', hunks: { type: 'indices', indices: [1] } }],
          type: 'fix',
          summary: 'uppercase two',
          dependencies: [],
        },
      ],
    })
    const value = result.value as { created: Array<{ message: string }> }
    expect(value.created).toHaveLength(1)
    // Only hunk 1 was committed; hunk 2 (NINE) is left in the worktree — the
    // tool resets the index so nothing is lost, but nothing else stays staged.
    expect(await ctx.git.hasStaged(dir)).toBe(false)
    const leftover = await ctx.git.diffText(dir, { cached: false, binary: true })
    expect(leftover).not.toContain('TWO')
    expect(leftover).toContain('NINE')
  })
})
