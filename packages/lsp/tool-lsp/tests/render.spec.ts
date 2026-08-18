import { describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import {
  DEFAULT_MAX_LOCATIONS,
  DEFAULT_MAX_RESULT_CHARS,
  formatCodeActions,
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatLocations,
  formatRename,
  LSP_OPERATIONS,
  parseLspArgs,
  presentLspCall,
  renderUri,
} from '@deepseek-ai/dsh-tool-lsp'
import type { LspLocation } from '@deepseek-ai/dsh-lsp'

const WS = resolve('/home/u/proj')
const WS_URI = pathToFileURL(WS).href

function loc(uri: string, line: number, character = 0): LspLocation {
  return { uri, range: { start: { line, character }, end: { line, character: character + 1 } } }
}

describe('parseLspArgs', () => {
  it('accepts every registered operation and converts one-based to zero-based', () => {
    for (const operation of LSP_OPERATIONS) {
      const input = parseLspArgs({
        operation,
        file_path: 'a.ts',
        line: 3,
        character: 5,
        ...(operation === 'rename' ? { new_name: 'newName' } : {}),
      })
      expect(input.operation).toBe(operation)
      expect(input.position).toEqual({ line: 2, character: 4 })
    }
  })

  it('rejects an unknown operation', () => {
    expect(() => parseLspArgs({ operation: 'notAnOperation', file_path: 'a.ts', line: 1, character: 1 }))
      .toThrow(/operation must be one of/)
  })

  it('rejects rename without new_name and new_name on other operations', () => {
    expect(() => parseLspArgs({ operation: 'rename', file_path: 'a.ts', line: 1, character: 1 }))
      .toThrow(/rename requires a non-empty new_name/)
    expect(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts', line: 1, character: 1, new_name: 'x' }))
      .toThrow(/new_name is only meaningful for rename/)
    expect(() => parseLspArgs({ operation: 'rename', file_path: 'a.ts', line: 1, character: 1, new_name: 'x' }))
      .not.toThrow()
  })

  it('rejects a blank file_path', () => {
    expect(() => parseLspArgs({ operation: 'hover', file_path: '   ', line: 1, character: 1 }))
      .toThrow(/file_path/)
  })

  it('rejects non-positive or non-integer coordinates', () => {
    expect(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts', line: 0, character: 1 })).toThrow(/line/)
    expect(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts', line: 1, character: 0 })).toThrow(/character/)
    expect(() => parseLspArgs({ operation: 'hover', file_path: 'a.ts', line: 1.5, character: 1 })).toThrow(/line/)
  })
})

describe('renderUri', () => {
  it('relativizes a file: URI inside the workspace with forward slashes', () => {
    const uri = pathToFileURL(join(WS, 'src', 'a.ts')).href
    expect(renderUri(uri, WS_URI)).toBe('src/a.ts')
  })

  it('returns an absolute path for a file: URI outside the workspace', () => {
    const outside = resolve(WS, '..', 'other', 'lib', 'b.ts')
    const uri = pathToFileURL(outside).href
    expect(renderUri(uri, WS_URI)).toBe(outside.replaceAll('\\', '/'))
  })

  it('renders the workspace root itself as "."', () => {
    expect(renderUri(WS_URI, WS_URI)).toBe('.')
  })

  it('keeps an in-workspace path whose first segment starts with dots relative', () => {
    // `..generated` is a real in-workspace dir, not a parent escape; only a `..` segment is external.
    const uri = pathToFileURL(join(WS, '..generated', 'a.ts')).href
    expect(renderUri(uri, WS_URI)).toBe('..generated/a.ts')
  })

  it('relativizes Windows execution-world URIs on a non-Windows host', () => {
    expect(renderUri('file:///C:/WORKSPACE/src/a.ts', 'file:///c:/workspace')).toBe('src/a.ts')
    expect(renderUri('file:///D:/lib/b.ts', 'file:///C:/workspace')).toBe('D:/lib/b.ts')
  })

  it('renders remote file authorities without host path conversion', () => {
    expect(renderUri('file://server/share/workspace/a.ts', 'file://server/share/workspace')).toBe('a.ts')
    expect(renderUri('file://SERVER/share/workspace/src/A.ts', 'file://server/Share/Workspace')).toBe('src/A.ts')
    expect(renderUri('file://other/share/b.ts', 'file://server/share/workspace')).toBe('//other/share/b.ts')
    expect(renderUri('file:///D:/lib/a.ts', 'file://server/share/workspace')).toBe('D:/lib/a.ts')
    expect(renderUri('file:///a.ts', 'file://server/')).toBe('/a.ts')
    expect(renderUri('file:///a.ts', 'file:///')).toBe('a.ts')
  })

  it('preserves backslashes as ordinary POSIX filename characters', () => {
    expect(renderUri('file:///home/u/proj/dir%5Cname/a.ts', 'file:///home/u/proj')).toBe('dir\\name/a.ts')
  })

  it('keeps malformed or mismatched URI coordinates verbatim', () => {
    expect(renderUri('file://[', WS_URI)).toBe('file://[')
    expect(renderUri('file:///a.ts', 'https://example.com/workspace')).toBe('file:///a.ts')
    expect(renderUri('file:///a.ts', 'file:///bad%ZZ')).toBe('file:///a.ts')
    expect(renderUri('file:///C:/workspace/bad%5Cpath', 'file:///C:/workspace')).toBe('file:///C:/workspace/bad%5Cpath')
    expect(renderUri('file:///short', 'file:///short/deeper')).toBe('/short')
    expect(renderUri('file:///', 'file:///C:/workspace')).toBe('/')
  })

  it('keeps a non-file URI verbatim', () => {
    expect(renderUri('untitled:Untitled-1', WS_URI)).toBe('untitled:Untitled-1')
    expect(renderUri('jdt://contents/Foo.class', WS_URI)).toBe('jdt://contents/Foo.class')
  })

  it('keeps a malformed file: URI verbatim when it cannot be parsed to a path', () => {
    // An encoded path separator is invalid on every platform and must remain verbatim.
    expect(renderUri('file:///bad%2Fpath', WS_URI)).toBe('file:///bad%2Fpath')
    expect(renderUri('file:///bad%00path', WS_URI)).toBe('file:///bad%00path')
  })
})

describe('formatLocations', () => {
  it('renders a no-result line for an empty list', () => {
    expect(formatLocations([], WS_URI, DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)).toBe('No results.')
  })

  it('renders one-based path:line:character grouped by file', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const text = formatLocations([loc(a, 0, 0), loc(a, 4, 2)], WS_URI, DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toBe('a.ts:1:1\na.ts:5:3')
  })

  it('caps at maxLocations and marks the omission', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const many = Array.from({ length: 5 }, (_, i) => loc(a, i))
    const text = formatLocations(many, WS_URI, 2, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toContain('a.ts:1:1')
    expect(text).toContain('3 more locations omitted (limit 2).')
  })

  it('uses the singular omission marker for exactly one extra', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const text = formatLocations([loc(a, 0), loc(a, 1)], WS_URI, 1, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toContain('1 more location omitted (limit 1).')
  })

  it('caps the complete location text even when one URI is enormous', () => {
    const maxResultChars = 80
    const text = formatLocations([loc(`custom:${'x'.repeat(1_000_000)}`, 0)], WS_URI, 1, maxResultChars)
    expect(text).toHaveLength(maxResultChars)
    expect(text).toContain('locations truncated')
  })
})

describe('formatHover', () => {
  it('renders a no-result line for null', () => {
    expect(formatHover(null, DEFAULT_MAX_RESULT_CHARS)).toBe('No hover information.')
  })

  it('returns short hover verbatim', () => {
    expect(formatHover({ contents: '```ts\nx: number\n```' }, DEFAULT_MAX_RESULT_CHARS)).toBe('```ts\nx: number\n```')
  })

  it('caps the complete hover text including its truncation marker', () => {
    const text = formatHover({ contents: 'a'.repeat(100) }, 60)
    expect(text).toHaveLength(60)
    expect(text).toContain('hover truncated (limit 60 characters).')
  })

  it('still honors a cap smaller than the truncation marker', () => {
    expect(formatHover({ contents: 'a'.repeat(100) }, 10)).toHaveLength(10)
  })
})

describe('formatDocumentSymbols', () => {
  const symbol = (name: string, depth: number, line = 0, detail?: string) => ({
    name,
    kind: 2,
    range: { start: { line, character: 0 }, end: { line, character: 4 } },
    selectionRange: { start: { line, character: 2 }, end: { line, character: 6 } },
    depth,
    ...(detail === undefined ? {} : { detail }),
  })

  it('renders a no-result line for an empty list', () => {
    expect(formatDocumentSymbols('a.ts', [], DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)).toBe('No symbols found.')
  })

  it('renders a depth-indented tree with one-based coordinates and detail', () => {
    const text = formatDocumentSymbols('a.ts', [symbol('outer', 0, 0, 'class Outer'), symbol('inner', 1, 2)], DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toBe('Symbols in a.ts:\n1:3 outer — class Outer\n  3:3 inner')
  })

  it('caps at maxSymbols and marks the omission', () => {
    const text = formatDocumentSymbols('a.ts', [symbol('a', 0), symbol('b', 0), symbol('c', 0)], 2, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toContain('Symbols in a.ts:')
    expect(text).toContain('1 more symbol(s) omitted (limit 2).')
  })

  it('caps the complete text even when a detail is enormous', () => {
    const text = formatDocumentSymbols('a.ts', [symbol('a', 0, 0, 'x'.repeat(1000))], 10, 80)
    expect(text).toHaveLength(80)
    expect(text).toContain('symbols truncated')
  })
})

describe('formatCodeActions', () => {
  it('renders a no-result line for an empty list', () => {
    expect(formatCodeActions([], DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)).toBe('No code actions available.')
  })

  it('renders numbered titles with kind/preferred markers and skips absent ones', () => {
    const text = formatCodeActions([
      { title: 'Fix it', kind: 'quickfix', isPreferred: true },
      { title: 'Just a title' },
      { title: 'Pref only', isPreferred: true },
    ], DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toBe('0. Fix it [preferred, quickfix]\n1. Just a title\n2. Pref only [preferred]')
  })

  it('caps at maxActions and marks the omission', () => {
    const text = formatCodeActions([{ title: 'a' }, { title: 'b' }, { title: 'c' }], 2, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toContain('1 more action(s) omitted (limit 2).')
  })
})

describe('formatRename', () => {
  const file = (uri: string, edits: { start: number; newText: string }[]) => ({
    uri,
    edits: edits.map(({ start, newText }) => ({
      range: { start: { line: start, character: 0 }, end: { line: start, character: 4 } },
      newText,
    })),
  })

  it('renders a no-edit line for an empty map', () => {
    expect(formatRename([], WS_URI, DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)).toBe('Rename returned no edits.')
  })

  it('renders per-file one-based edit lines with escaped newlines', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const b = pathToFileURL(join(WS, 'b.ts')).href
    const text = formatRename([file(a, [{ start: 0, newText: 'x' }]), file(b, [{ start: 3, newText: 'line\nbreak' }])], WS_URI, DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toBe('a.ts:\n  1:1 → x\nb.ts:\n  4:1 → line\\nbreak')
  })

  it('caps at maxEdits across files', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const text = formatRename([file(a, [{ start: 0, newText: 'x' }, { start: 1, newText: 'y' }, { start: 2, newText: 'z' }])], WS_URI, 2, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toContain('more edits omitted (limit 2).')
    expect(text).not.toContain('3:1')
  })

  it('relativizes file: URIs and keeps non-file URIs verbatim', () => {
    const a = pathToFileURL(join(WS, 'a.ts')).href
    const text = formatRename([file(a, [{ start: 0, newText: 'x' }]), file('jdt://contents/Foo.class', [{ start: 0, newText: 'x' }])], WS_URI, 10, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toContain('a.ts:')
    expect(text).toContain('jdt://contents/Foo.class:')
  })
})

describe('formatDiagnostics', () => {
  const diagnostic = (line: number, message: string, severity?: number, source?: string) => ({
    range: { start: { line, character: 1 }, end: { line, character: 4 } },
    ...(severity === undefined ? {} : { severity }),
    ...(source === undefined ? {} : { source }),
    message,
  })

  it('renders a clean no-diagnostics line for an empty list', () => {
    expect(formatDiagnostics('a.ts', [], DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)).toBe('No diagnostics.')
  })

  it('renders one-based path:line with severity/source and message', () => {
    const text = formatDiagnostics('a.ts', [diagnostic(0, 'oops', 1, 'ts'), diagnostic(4, 'meh', 2)], DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toBe('a.ts:1 [Error] (ts) — oops\na.ts:5 [Warning] — meh')
  })

  it('omits severity and source when absent', () => {
    expect(formatDiagnostics('a.ts', [diagnostic(0, 'plain')], DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS))
      .toBe('a.ts:1 — plain')
  })

  it('reports unknown severities deterministically', () => {
    expect(formatDiagnostics('a.ts', [diagnostic(0, 'x', 9)], DEFAULT_MAX_LOCATIONS, DEFAULT_MAX_RESULT_CHARS))
      .toBe('a.ts:1 [9] — x')
  })

  it('caps at maxDiagnostics and marks the omission', () => {
    const many = Array.from({ length: 5 }, (_, i) => diagnostic(i, `d${i}`))
    const text = formatDiagnostics('a.ts', many, 2, DEFAULT_MAX_RESULT_CHARS)
    expect(text).toContain('3 more diagnostic(s) omitted (limit 2).')
  })

  it('caps the complete text even when one message is enormous', () => {
    const text = formatDiagnostics('a.ts', [diagnostic(0, 'x'.repeat(1000))], 10, 80)
    expect(text).toHaveLength(80)
    expect(text).toContain('diagnostics truncated')
  })
})

describe('presentLspCall', () => {
  it('is a generic search card with an operation/cursor title and a line location', () => {
    expect(presentLspCall({ operation: 'findReferences', file_path: 'a.ts', line: 3, character: 7 })).toEqual({
      card: 'generic',
      kind: 'search',
      title: 'LSP findReferences a.ts:3:7',
      locations: [{ path: 'a.ts', line: 3 }],
    })
  })
})
