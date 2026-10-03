import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as PluginUse from '@deepseek-ai/dsh-skill-plugin-use'

/** Create a temp dir; realpath'd because candidate locators are realpath'd (macOS /var symlink). */
async function withTempDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'skill-plugin-use-')))
}

describe('dsh-skill-plugin-use', () => {
  it('registers, lists, loads, and disposes an inline advice', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(PluginUse, {
      providerName: 'test-plugins',
      plugins: [{
        name: 'github-ci',
        description: 'Advise the agent to prefer the GitHub CI plugin tools.',
        whenToUse: 'When the user asks about pull request checks or CI runs.',
        instructions: 'Prefer `ci_status` and `ci_retry` for pipeline questions.',
        tools: ['ci_status', 'ci_retry'],
      }],
    })

    expect(await ctx.skills.list()).toEqual([{
      name: 'github-ci',
      description: 'Advise the agent to prefer the GitHub CI plugin tools.',
      whenToUse: 'When the user asks about pull request checks or CI runs.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'test-plugins',
      source: 'composition',
    }])
    const loaded = await ctx.skills.get('github-ci')
    expect(loaded?.provider).toBe('test-plugins')
    expect(loaded?.source).toBe('composition')
    expect(loaded?.content).toBe('Prefer `ci_status` and `ci_retry` for pipeline questions.\n\nPlugin-provided tools: `ci_status`, `ci_retry`.')
    expect(loaded?.path).toBeUndefined()
    expect(loaded?.resourceBase).toBeUndefined()

    await fiber.dispose()
    expect(await ctx.skills.list()).toEqual([])
  })

  it('loads file-backed advice bodies and reflects live edits', async () => {
    const dir = await withTempDir()
    try {
      await writeFile(join(dir, 'advice.md'), 'Original body.', 'utf8')
      const ctx = new Context()
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin(PluginUse, {
        baseDir: dir,
        plugins: [{ name: 'file-advice', description: 'File-backed advice.', instructionsFile: 'advice.md' }],
      })

      expect(await ctx.skills.list()).toEqual([{
        path: join(dir, 'advice.md'),
        name: 'file-advice',
        description: 'File-backed advice.',
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'plugin-use',
        source: 'composition',
        resourceBase: { kind: 'directory', path: dir },
      }])
      expect((await ctx.skills.get('file-advice'))?.content).toBe('Original body.')

      await writeFile(join(dir, 'advice.md'), 'Edited body.', 'utf8')
      expect((await ctx.skills.get('file-advice'))?.content).toBe('Edited body.')

      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('omits advice whose file-backed body is absent at discovery', async () => {
    const dir = await withTempDir()
    try {
      const ctx = new Context()
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin(PluginUse, {
        baseDir: dir,
        plugins: [{ name: 'ghost-advice', description: 'Missing file advice.', instructionsFile: 'ghost.md' }],
      })
      expect(await ctx.skills.list()).toEqual([])
      expect(await ctx.skills.get('ghost-advice')).toBeUndefined()

      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('drops file-backed loads once the body disappears', async () => {
    const dir = await withTempDir()
    try {
      await writeFile(join(dir, 'ghost.md'), 'Present body.', 'utf8')
      const ctx = new Context()
      await ctx.plugin(SkillRegistry)
      const fiber = await ctx.plugin(PluginUse, {
        baseDir: dir,
        plugins: [{ name: 'ghost-advice', description: 'Vanishing file advice.', instructionsFile: 'ghost.md' }],
      })
      expect((await ctx.skills.list()).map(skill => skill.name)).toEqual(['ghost-advice'])

      await rm(join(dir, 'ghost.md'))
      expect(await ctx.skills.get('ghost-advice')).toBeUndefined()

      await fiber.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('honors modelInvocable false as gesture-only', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(PluginUse, {
      plugins: [{ name: 'gesture-only', description: 'Gesture-only advice.', instructions: 'Body.', modelInvocable: false }],
    })
    expect((await ctx.skills.list())[0]?.invocation).toEqual({ modelInvocable: false, userInvocable: true })
    await fiber.dispose()
  })

  it('rejects invalid configuration at mount', () => {
    const ctx = new Context()
    const invalid: PluginUse.PluginAdvice[] = [
      { name: 'Not_Kebab', description: 'd' },
      { name: 'both', description: 'd', instructions: 'a', instructionsFile: 'f.md' },
      { name: 'neither', description: 'd' },
      { name: 'empty-tool', description: 'd', instructions: 'a', tools: [''] },
    ]
    for (const plugin of invalid) {
      expect(() => { PluginUse.apply(ctx, { plugins: [plugin] }) }).toThrow(TypeError)
    }
    expect(() => {
      PluginUse.apply(ctx, {
        plugins: [
          { name: 'dup', description: 'd', instructions: 'a' },
          { name: 'dup', description: 'd', instructions: 'a' },
        ],
      })
    }).toThrow('duplicate advice name "dup"')
  })

  it('resolves advice file paths against tilde, absolute, and baseDir', () => {
    expect(PluginUse.resolveAdviceFile('~/notes.md', '/base')).toBe(join(homedir(), 'notes.md'))
    expect(PluginUse.resolveAdviceFile('/abs/notes.md', '/base')).toBe('/abs/notes.md')
    expect(PluginUse.resolveAdviceFile('rel/notes.md', '/base')).toBe('/base/rel/notes.md')
  })
})
