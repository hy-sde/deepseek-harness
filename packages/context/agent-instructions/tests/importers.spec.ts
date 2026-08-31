/**
 * Tests for foreign-format instruction importers (G5 port from oh-my-pi):
 * Cursor `.cursor/rules/*.mdc`, Cline `.clinerules`, Copilot
 * `.github/copilot-instructions.md` + `.github/instructions/*.instructions.md`.
 * Discovery normalizes each into the AGENTS.md-compatible chain under its own
 * root-relative scope, and reconciliation tracks edits like any candidate.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { discoverBaselineInstructionFiles, loadBaselineInstructions } from '@deepseek-ai/dsh-agent-instructions'
import { discoverForeignRuleFiles, normalizeForeignContent, parseSimpleFrontmatter } from '../src/importers.ts'

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-instruction-importers-'))
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
}

describe('parseSimpleFrontmatter', () => {
  it('parses flat key-value frontmatter and returns the body', () => {
    const parsed = parseSimpleFrontmatter('---\ndescription: Style guide\nglobs: "**/*.ts"\nalwaysApply: true\n---\nRule body\n')
    expect(parsed).toBeDefined()
    expect(parsed?.frontmatter).toEqual({ description: 'Style guide', globs: '**/*.ts', alwaysApply: true })
    expect(parsed?.body).toBe('Rule body\n')
  })

  it('returns undefined when there is no frontmatter block', () => {
    expect(parseSimpleFrontmatter('plain markdown')).toBeUndefined()
    expect(parseSimpleFrontmatter('---\nnever closed')).toBeUndefined()
  })
})

describe('normalizeForeignContent', () => {
  it('strips .mdc frontmatter and annotates globs', () => {
    const raw = '---\ndescription: TS style\nglobs: "**/*.ts"\nalwaysApply: false\n---\nUse 2-space indent.\n'
    const normalized = normalizeForeignContent('.cursor/rules/ts.mdc', raw)
    expect(normalized).toContain('applies to: **/*.ts')
    expect(normalized).toContain('Use 2-space indent.')
    expect(normalized).not.toContain('description:')
  })

  it('annotates always apply', () => {
    const raw = '---\nalwaysApply: true\n---\nGlobal rule.\n'
    const normalized = normalizeForeignContent('.cursor/rules/g.mdc', raw)
    expect(normalized).toContain('always applies')
    expect(normalized).not.toContain('---')
  })

  it('annotates copilot applyTo and drops the frontmatter', () => {
    const raw = '---\napplyTo: "src/**"\n---\nCopilot body.\n'
    const normalized = normalizeForeignContent('.github/instructions/naming.instructions.md', raw)
    expect(normalized).toContain('applies to: src/**')
    expect(normalized).toContain('Copilot body.')
    expect(normalized).not.toContain('applyTo:')
  })

  it('passes non-foreign files through unchanged', () => {
    expect(normalizeForeignContent('AGENTS.md', 'hello')).toBe('hello')
    expect(normalizeForeignContent('.clinerules', 'plain text')).toBe('plain text')
  })
})

describe('discoverForeignRuleFiles', () => {
  it('discovers all three formats in one directory', async () => {
    const root = await tempRepo()
    try {
      await mkdir(join(root, '.cursor/rules'), { recursive: true })
      await mkdir(join(root, '.clinerules'), { recursive: true })
      await mkdir(join(root, '.github/instructions'), { recursive: true })
      await write(join(root, '.cursor/rules/style.mdc'), '---\nglobs: "**/*.ts"\n---\nTS rule')
      await write(join(root, '.clinerules/arch.md'), 'Cline arch')
      await write(join(root, '.github/copilot-instructions.md'), 'Copilot global')
      await write(join(root, '.github/instructions/naming.instructions.md'), '---\napplyTo: "**/*.ts"\n---\nNaming rule')

      const files = await discoverForeignRuleFiles(root, root)

      expect(files.map(file => file.displayPath).sort()).toEqual([
        '.clinerules/arch.md',
        '.cursor/rules/style.mdc',
        '.github/copilot-instructions.md',
        '.github/instructions/naming.instructions.md',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats .clinerules as a single file when it is one', async () => {
    const root = await tempRepo()
    try {
      await write(join(root, '.clinerules'), 'single file rules')
      const files = await discoverForeignRuleFiles(root, root)
      expect(files.map(file => file.displayPath)).toEqual(['.clinerules'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns nothing when no foreign formats exist', async () => {
    const root = await tempRepo()
    try {
      expect(await discoverForeignRuleFiles(root, root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('foreign rules in the instruction chain', () => {
  it('loads foreign rule files into the baseline under their own display paths', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.cursor/rules'), { recursive: true })
      await mkdir(join(root, '.github/instructions'), { recursive: true })
      await write(join(home, 'AGENTS.md'), 'global')
      await write(join(root, 'AGENTS.md'), 'root agents')
      await write(join(root, '.cursor/rules/style.mdc'), '---\nglobs: "**/*.ts"\n---\nUse tabs.\n')
      await write(join(root, '.github/instructions/naming.instructions.md'), '---\napplyTo: "**/*.ts"\n---\nUse kebab-case.\n')

      const files = await discoverBaselineInstructionFiles({ cwd: root, dshHome: home })

      const names = files.map(file => file.displayPath)
      expect(names).toContain('.cursor/rules/style.mdc')
      expect(names).toContain('.github/instructions/naming.instructions.md')

      const loaded = await loadBaselineInstructions({ cwd: root, dshHome: home, maxBytes: 65536 })
      expect(loaded).toBeDefined()
      expect(loaded?.text).toContain('Instructions from: .cursor/rules/style.mdc')
      expect(loaded?.text).toContain('applies to: **/*.ts')
      expect(loaded?.text).toContain('Use tabs.')
      expect(loaded?.text).toContain('Use kebab-case.')
      expect(loaded?.text).not.toContain('appliesTo') // frontmatter stripped
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })

  it('is disabled when inheritForeignRules is false', async () => {
    const root = await tempRepo()
    const home = await tempRepo()
    try {
      await mkdir(join(root, '.cursor/rules'), { recursive: true })
      await write(join(home, 'AGENTS.md'), 'global')
      await write(join(root, '.cursor/rules/style.mdc'), '---\nglobs: "**/*.ts"\n---\nUse tabs.\n')

      const files = await discoverBaselineInstructionFiles({
        cwd: root,
        dshHome: home,
        inheritForeignRules: false,
      })
      expect(files.map(file => file.displayPath)).not.toContain('.cursor/rules/style.mdc')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  })
})
