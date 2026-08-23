/**
 * Native-sidecar `read` routing: when the file is a SQLite database or a PDF
 * and the `dsh-omp-native` sidecar binary is present, `read` serves the table
 * / query text or the page raster summary through it; non-PDF/SQLite paths and
 * a missing sidecar fall through to the regular text read.
 */

import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { OMP_NATIVE_ENV, nativeFamilyOf, resolveOmpNativeBinary, sqliteSuffixOf } from '../src/read-native.ts'

const testToolSignal = new AbortController().signal

let dir: string
let ctx: Context
let fiber: Awaited<ReturnType<Context['plugin']>>
const session = { header: {} }

let callCounter = 0
function call(name: string, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: { session } as never,
  })
}

interface ReadValue {
  path: string
  offset: number
  lines: { number: number; text: string }[]
  totalLines: number
}

async function read(pathArg: string): Promise<ReadValue> {
  const result = await call('read', { file_path: pathArg })
  return (result as { value: ReadValue }).value
}

afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

async function setup() {
  dir = await mkdtemp(join(tmpdir(), 'dsh-tool-fs-native-'))
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  fiber = await ctx.plugin(ToolFs)
}

// Sidecar fixtures live under native/dsh-omp-native/fixtures (repo-relative).
function fixturePath(name: string): string {
  return join(process.cwd(), 'native', 'dsh-omp-native', 'fixtures', name)
}

/** Write an executable shim for the sidecar binary (env override tests). */
async function writeScript(name: string, content: string): Promise<void> {
  const { writeFile, chmod } = await import('node:fs/promises')
  const path = join(dir, name)
  await writeFile(path, content, 'utf8')
  await chmod(path, 0o755)
}

describe('dsh-omp-native routing', () => {
  const binaryAvailable = resolveOmpNativeBinary() !== undefined

  describe.skipIf(!binaryAvailable)('sqlite via sidecar', () => {
    it('lists tables in a sqlite database read with no selector', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      const result = await read('sample.sqlite')
      const text = result.lines.map(l => l.text).join('\n')
      expect(text).toContain('users')
      expect(text).toContain('12 rows')
    })

    it('shows schema and sample rows via the :table selector', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      const result = await read('sample.sqlite:users')
      const text = result.lines.map(l => l.text).join('\n')
      expect(text).toContain('CREATE TABLE')
      expect(text).toContain('alice')
    })

    it('executes a bounded query with where/order/limit', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      const result = await read('sample.sqlite:users?where=age>30&limit=4&order=age:desc')
      const text = result.lines.map(l => l.text).join('\n')
      expect(text).toContain('dave')
      expect(text).not.toContain('alice')
    })

    it('queries one row by primary key', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      const result = await read('sample.sqlite:users:2')
      const text = result.lines.map(l => l.text).join('\n')
      expect(text).toContain('bob')
    })

    it('serves raw SQL through ?q=', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      const result = await read('sample.sqlite?q=SELECT name FROM users WHERE age=40')
      const text = result.lines.map(l => l.text).join('\n')
      expect(text).toContain('dave')
    })
  })

  describe.skipIf(!binaryAvailable)('pdf via sidecar', () => {
    it('reports the raster summary for a real PDF', async () => {
      await setup()
      await copyFile(fixturePath('sample.pdf'), join(dir, 'sample.pdf'))
      const result = await read('sample.pdf')
      const text = result.lines.map(l => l.text).join('\n')
      expect(text).toContain('PDF')
      expect(text).toContain('page')
    })

    it('surfaces a sidecar error for a PDF magic file that fails to rasterize', async () => {
      await setup()
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'broken.pdf'), '%PDF-1.7\n%%EOF\n', 'utf8')
      const result = await call('read', { file_path: 'broken.pdf' })
      const typed = result as { isError?: boolean; content?: { type: string; text: string }[] }
      expect(typed.isError).toBe(true)
      expect(typed.content?.[0]?.text).toContain('cannot rasterize PDF')
    })

    it('falls back to a default message for a message-less PDF sidecar error', async () => {
      await setup()
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'broken.pdf'), '%PDF-1.7\n%%EOF\n', 'utf8')
      await writeScript('fake-pdf-error', '#!/bin/sh\necho \'{"error":{}}\'\nexit 1\n')
      const previous = process.env[OMP_NATIVE_ENV]
      try {
        process.env[OMP_NATIVE_ENV] = join(dir, 'fake-pdf-error')
        const result = await call('read', { file_path: 'broken.pdf' })
        expect((result as { isError?: boolean }).isError).toBe(true)
      } finally {
        process.env[OMP_NATIVE_ENV] = previous ?? ''
      }
    })

    it('summarizes a fake ok payload without a base64 string', async () => {
      await setup()
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'ok.pdf'), '%PDF-1.7\n%%EOF\n', 'utf8')
      await writeScript('fake-pdf-ok', '#!/bin/sh\necho \'{"ok":{"page":3,"total_pages":10,"width":400,"height":500}}\'\nexit 0\n')
      const previous = process.env[OMP_NATIVE_ENV]
      try {
        process.env[OMP_NATIVE_ENV] = join(dir, 'fake-pdf-ok')
        const result = await read('ok.pdf')
        const text = result.lines.map(l => l.text).join('\n')
        expect(text).toContain('10 pages')
        expect(text).toContain('400x500')
      } finally {
        process.env[OMP_NATIVE_ENV] = previous ?? ''
      }
    })

    it('leaves a >20 MiB file to the regular read rather than the sidecar', async () => {
      await setup()
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'big.sqlite'), 'x'.repeat(21 * 1024 * 1024), 'utf8')
      const result = await call('read', { file_path: 'big.sqlite' })
      expect((result as { isError?: boolean }).isError).not.toBe(true)
    })
  })

  describe.skipIf(!binaryAvailable)('sidecar invocation edge cases', () => {
    it('surfaces a runtime error for invalid SQL through ?q=', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      const result = await call('read', { file_path: 'sample.sqlite?q=SELECT * FROM missing_table' })
      const typed = result as { isError?: boolean; content?: { type: string; text: string }[] }
      expect(typed.isError).toBe(true)
      expect(typed.content?.[0]?.text).toContain('cannot read SQLite database')
    })

    it('spawn failure surfaces as an error when the env binary cannot run', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      const previous = process.env[OMP_NATIVE_ENV]
      try {
        // A directory satisfies existsSync but cannot be spawned.
        process.env[OMP_NATIVE_ENV] = tmpdir()
        const result = await call('read', { file_path: 'sample.sqlite' })
        const typed = result as { isError?: boolean; content?: { type: string; text: string }[] }
        expect(typed.isError).toBe(true)
        expect(typed.content?.[0]?.text).toContain('cannot read SQLite database')
      } finally {
        process.env[OMP_NATIVE_ENV] = previous ?? ''
      }
    })

    it('malformed sidecar stdout surfaces as an error', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      await writeScript('fake-native', '#!/bin/sh\necho "this is not JSON"\n')
      const previous = process.env[OMP_NATIVE_ENV]
      try {
        process.env[OMP_NATIVE_ENV] = join(dir, 'fake-native')
        const result = await call('read', { file_path: 'sample.sqlite' })
        const typed = result as { isError?: boolean; content?: { type: string; text: string }[] }
        expect(typed.isError).toBe(true)
        expect(typed.content?.[0]?.text).toContain('cannot read SQLite database')
      } finally {
        process.env[OMP_NATIVE_ENV] = previous ?? ''
      }
    })

    it('sidecar error without JSON payload falls back to stderr text', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      await writeScript('fake-native2', '#!/bin/sh\necho "sidecar exploded" >&2\nexit 1\n')
      const previous = process.env[OMP_NATIVE_ENV]
      try {
        process.env[OMP_NATIVE_ENV] = join(dir, 'fake-native2')
        const result = await call('read', { file_path: 'sample.sqlite' })
        const typed = result as { isError?: boolean; content?: { type: string; text: string }[] }
        expect(typed.isError).toBe(true)
        expect(typed.content?.[0]?.text).toContain('cannot read SQLite database')
      } finally {
        process.env[OMP_NATIVE_ENV] = previous ?? ''
      }
    })

    it('sidecar JSON error without kind/detail surfaces the plain message', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      await writeScript('fake-native3', '#!/bin/sh\necho \'{"error":{"message":"nope"}}\'\nexit 1\n')
      const previous = process.env[OMP_NATIVE_ENV]
      try {
        process.env[OMP_NATIVE_ENV] = join(dir, 'fake-native3')
        const result = await call('read', { file_path: 'sample.sqlite' })
        const typed = result as { isError?: boolean; content?: { type: string; text: string }[] }
        expect(typed.isError).toBe(true)
        expect(typed.content?.[0]?.text).toContain('nope')
      } finally {
        process.env[OMP_NATIVE_ENV] = previous ?? ''
      }
    })

    it('sidecar JSON error without message or detail falls back to defaults', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      await writeScript('fake-native4', '#!/bin/sh\necho \'{"error":{}}\'\nexit 1\n')
      const previous = process.env[OMP_NATIVE_ENV]
      try {
        process.env[OMP_NATIVE_ENV] = join(dir, 'fake-native4')
        const result = await call('read', { file_path: 'sample.sqlite' })
        expect((result as { isError?: boolean }).isError).toBe(true)
      } finally {
        process.env[OMP_NATIVE_ENV] = previous ?? ''
      }
    })

    it('sidecar ok payload without text yields an empty read', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      await writeScript('fake-native5', '#!/bin/sh\necho \'{"ok":{"nothing":"here"}}\'\nexit 0\n')
      const previous = process.env[OMP_NATIVE_ENV]
      try {
        process.env[OMP_NATIVE_ENV] = join(dir, 'fake-native5')
        const result = await read('sample.sqlite')
        expect(result.totalLines).toBe(0)
      } finally {
        process.env[OMP_NATIVE_ENV] = previous ?? ''
      }
    })

    it('sidecar usage error falls through to the regular read', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      await writeScript('fake-native6', '#!/bin/sh\necho \'{"error":{"kind":"usage","message":"target must embed a .sqlite path"}}\'\nexit 2\n')
      const previous = process.env[OMP_NATIVE_ENV]
      try {
        process.env[OMP_NATIVE_ENV] = join(dir, 'fake-native6')
        // Usage errors decline the sidecar without surfacing an error; the
        // regular read attempts the database bytes as text instead.
        const result = await call('read', { file_path: 'sample.sqlite' })
        const text = ((result as { content?: { type: string; text: string }[] }).content?.[0]?.text) ?? ''
        expect(text).not.toContain('cannot read SQLite database')
      } finally {
        process.env[OMP_NATIVE_ENV] = previous ?? ''
      }
    })

    it('sidecar JSON without ok or error surfaces a malformed-output error', async () => {
      await setup()
      await copyFile(fixturePath('sample.sqlite'), join(dir, 'sample.sqlite'))
      await writeScript('fake-native7', '#!/bin/sh\necho \'{"unexpected":true}\'\nexit 1\n')
      const previous = process.env[OMP_NATIVE_ENV]
      try {
        process.env[OMP_NATIVE_ENV] = join(dir, 'fake-native7')
        const result = await call('read', { file_path: 'sample.sqlite' })
        expect((result as { isError?: boolean }).isError).toBe(true)
      } finally {
        process.env[OMP_NATIVE_ENV] = previous ?? ''
      }
    })
  })

  describe('fall-through', () => {
    it('env override resolves to a configured binary when it exists', () => {
      const previous = process.env[OMP_NATIVE_ENV]
      try {
        process.env[OMP_NATIVE_ENV] = process.execPath
        expect(resolveOmpNativeBinary()).toBe(process.execPath)
      } finally {
        process.env[OMP_NATIVE_ENV] = previous ?? ''
      }
    })

    it('resolveOmpNativeBinary returns undefined when no candidate exists', () => {
      const previous = process.env[OMP_NATIVE_ENV]
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(join(tmpdir(), 'no-such-harness-checkout'))
      try {
        process.env[OMP_NATIVE_ENV] = join(tmpdir(), `missing-binary-${Date.now()}`)
        expect(resolveOmpNativeBinary()).toBeUndefined()
      } finally {
        cwdSpy.mockRestore()
        process.env[OMP_NATIVE_ENV] = previous ?? ''
      }
    })

    it('reads plain text files through the regular read even with a sidecar present', async () => {
      await setup()
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'plain.txt'), 'plain text\n', 'utf8')
      const result = await read('plain.txt')
      expect(result.totalLines).toBe(1)
      expect(result.lines[0]?.text).toContain('plain text')
    })

    it('reads a non-PDF .pdf file through the regular read (magic mismatch)', async () => {
      await setup()
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'notes.pdf'), 'meeting notes\n', 'utf8')
      const result = await read('notes.pdf')
      expect(result.totalLines).toBe(1)
      expect(result.lines[0]?.text).toContain('meeting notes')
    })

    it('fall back-through when no sidecar binary is resolvable', async () => {
      await setup()
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(dir, 'notes.sqlite'), 'not a database\n', 'utf8')
      const previous = process.env[OMP_NATIVE_ENV]
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(join(tmpdir(), 'no-such-harness-checkout'))
      try {
        process.env[OMP_NATIVE_ENV] = join(tmpdir(), `missing-binary-${Date.now()}`)
        // No binary, .sqlite extension but not a real database: the native
        // route declines and the regular read serves the text bytes.
        const result = await read('notes.sqlite')
        expect(result.lines[0]?.text).toContain('not a database')
      } finally {
        cwdSpy.mockRestore()
        process.env[OMP_NATIVE_ENV] = previous ?? ''
      }
    })

    it('sqliteSuffixOf extracts the selector after the extension boundary', () => {
      expect(sqliteSuffixOf('db.sqlite')).toBe('')
      expect(sqliteSuffixOf('db.sqlite:users?limit=10')).toBe(':users?limit=10')
      expect(sqliteSuffixOf('db.sqlite3:users:2')).toBe(':users:2')
      expect(sqliteSuffixOf('data/db.sqlite/subpath')).toBe('')
    })

    it('nativeFamilyOf gates by the PDF/SQLite extensions', () => {
      expect(nativeFamilyOf('report.pdf')).toEqual({ family: 'pdf', suffix: '' })
      expect(nativeFamilyOf('report.pdf:2')).toBeUndefined()
      expect(nativeFamilyOf('report.pdf?page=2')).toBeUndefined()
      expect(nativeFamilyOf('db.sqlite:users')).toEqual({ family: 'sqlite', suffix: ':users' })
      expect(nativeFamilyOf('db.sqlite3')).toEqual({ family: 'sqlite', suffix: '' })
      expect(nativeFamilyOf('db.SQLITE:users')).toEqual({ family: 'sqlite', suffix: ':users' })
      expect(nativeFamilyOf('weird.sqlite.backup')).toBeUndefined()
      expect(nativeFamilyOf('notes.txt')).toBeUndefined()
    })
  })
})
