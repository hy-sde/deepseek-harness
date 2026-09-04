import { describe, expect, it } from 'vitest'
import {
  applyEditsToText,
  negotiatePositionEncoding,
  normalizeCodeActions,
  normalizeDiagnostics,
  normalizeDocumentSymbols,
  normalizeFormattingEdits,
  normalizeHover,
  normalizeLocations,
  normalizeRename,
  requestMethod,
  supportsFormatting,
  supportsOperation,
  supportsTransientOpen,
} from '@deepseek-ai/dsh-lsp-stdio'
import type { WireServerCapabilities } from '@deepseek-ai/dsh-lsp-stdio/src/protocol.ts'

const RANGE = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }

describe('supportsFormatting', () => {
  it('reads the documentFormattingProvider slot (boolean and options forms)', () => {
    expect(supportsFormatting({ documentFormattingProvider: true })).toBe(true)
    expect(supportsFormatting({ documentFormattingProvider: { workDoneProgress: true } })).toBe(true)
    expect(supportsFormatting({ documentFormattingProvider: false })).toBe(false)
    expect(supportsFormatting({})).toBe(false)
  })
})

describe('normalizeFormattingEdits', () => {
  it('returns null-answer and missing-payload handling empty vs throw', () => {
    expect(normalizeFormattingEdits(null)).toEqual([])
    expect(() => normalizeFormattingEdits(undefined)).toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })

  it('normalizes a TextEdit array', () => {
    const edits = [{ range: RANGE, newText: 'x' }]
    expect(normalizeFormattingEdits(edits)).toEqual([{ range: RANGE, newText: 'x' }])
  })

  it('rejects a non-array payload', () => {
    expect(() => normalizeFormattingEdits({ range: RANGE, newText: 'x' })).toThrow(/not a TextEdit array or null/)
  })

  it('rejects a non-object entry and a malformed TextEdit', () => {
    expect(() => normalizeFormattingEdits([42])).toThrow(/non-object entry/)
    expect(() => normalizeFormattingEdits([{ range: RANGE }])).toThrow(/malformed TextEdit/)
    expect(() => normalizeFormattingEdits([{ range: RANGE, newText: 42 }])).toThrow(/malformed TextEdit/)
    expect(() => normalizeFormattingEdits([{ range: { start: null, end: null }, newText: 'x' }])).toThrow(/malformed TextEdit/)
  })
})

describe('applyEditsToText', () => {
  it('returns the original text for no edits', () => {
    expect(applyEditsToText('abc', [])).toBe('abc')
  })

  it('applies one replacement edit', () => {
    const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'zzz' }
    expect(applyEditsToText('abc def', [edit])).toBe('zzz def')
  })

  it('applies multiple edits in descending position order', () => {
    const text = 'aaa\nbbb\nccc\n'
    const edits = [
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: 'XXX' },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: '111' },
    ]
    expect(applyEditsToText(text, edits)).toBe('111\nXXX\nccc\n')
  })

  it('clips an over-long position to the document, and a position past the last line to its end', () => {
    const edit = { range: { start: { line: 0, character: 2 }, end: { line: 2, character: 99 } }, newText: '!' }
    expect(applyEditsToText('ab\ncd\n', [edit])).toBe('ab!')
  })

  it('treats \\r and \\r\\n as line terminators as well', () => {
    const edit = { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: 'X' }
    expect(applyEditsToText('a\r\nbc\rde\n', [edit])).toBe('a\r\nXc\rde\n')
  })

  it('uses a bare \\r (no later \\n) as the line terminator', () => {
    const edit = { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, newText: 'X' }
    expect(applyEditsToText('a\rb', [edit])).toBe('a\rX')
  })

  it('clamps a position whose line has no terminator to the document end', () => {
    // 'single' has no line break at all: resolving line 1 finds no terminator and clamps to length.
    const edit = { range: { start: { line: 0, character: 0 }, end: { line: 1, character: 2 } }, newText: 'X' }
    expect(applyEditsToText('single', [edit])).toBe('X')
  })

  it('orders edits that share a start position by descending range end', () => {
    // Overlapping edits are out of contract; the accepted rule keeps the deterministic order the
    // comparator settles on — among equal starts, the shorter range applies first.
    const text = 'abcdef'
    const edits = [
      { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, newText: 'X' },
      { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 6 } }, newText: 'Y' },
    ]
    expect(applyEditsToText(text, edits)).toBe('abX')
  })
})

describe('normalizeDiagnostics', () => {
  const diagnostic = (start: [number, number], end: [number, number], message: string) => ({
    range: {
      start: { line: start[0], character: start[1] },
      end: { line: end[0], character: end[1] },
    },
    message,
  })

  it('returns empty for a null, non-object, or non-array diagnostics payload', () => {
    expect(normalizeDiagnostics(null, 'file:///a', 1)).toEqual([])
    expect(normalizeDiagnostics(42, 'file:///a', 1)).toEqual([])
    expect(normalizeDiagnostics({ uri: 'file:///a', diagnostics: 'nope' }, 'file:///a', 1)).toEqual([])
  })

  it('requires the target uri and the opened version (or an absent version)', () => {
    const publish = { uri: 'file:///a', diagnostics: [diagnostic([0, 0], [0, 2], 'm')], version: 3 }
    expect(normalizeDiagnostics(publish, 'file:///a', 3)).toHaveLength(1)
    expect(normalizeDiagnostics(publish, 'file:///other', 3)).toEqual([])
    expect(normalizeDiagnostics(publish, 'file:///a', 2)).toEqual([])
    expect(normalizeDiagnostics({ uri: 'file:///a', diagnostics: publish.diagnostics }, 'file:///a', 3)).toHaveLength(1)
  })

  it('drops malformed entries (incl. non-objects) and sorts by range', () => {
    const payload = {
      uri: 'file:///a',
      version: 1,
      diagnostics: [
        { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } }, message: 'late' },
        { range: { start: { line: 0, character: 5 }, end: { line: 0, character: 8 } }, message: 'early', severity: 2, source: 'ts' },
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, message: 'same start A' },
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, message: 'same start B' },
        { message: 'no range' },
        { range: { start: { line: 3, character: 0 }, end: null }, message: 'bad range' },
        42,
      ],
    }
    expect(normalizeDiagnostics(payload, 'file:///a', 1)).toEqual([
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, message: 'same start B' },
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, message: 'same start A' },
      { range: { start: { line: 0, character: 5 }, end: { line: 0, character: 8 } }, severity: 2, source: 'ts', message: 'early' },
      { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } }, message: 'late' },
    ])
  })
})
describe('requestMethod', () => {
  it('maps each request-backed operation to its textDocument request', () => {
    expect(requestMethod('goToDefinition')).toBe('textDocument/definition')
    expect(requestMethod('findReferences')).toBe('textDocument/references')
    expect(requestMethod('goToImplementation')).toBe('textDocument/implementation')
    expect(requestMethod('goToTypeDefinition')).toBe('textDocument/typeDefinition')
    expect(requestMethod('hover')).toBe('textDocument/hover')
    expect(requestMethod('documentSymbols')).toBe('textDocument/documentSymbol')
    expect(requestMethod('codeActions')).toBe('textDocument/codeAction')
    expect(requestMethod('rename')).toBe('textDocument/rename')
  })

  it('rejects the publish-listener diagnostics operation (no request method)', () => {
    expect(() => requestMethod('diagnostics')).toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })
})

describe('supportsOperation', () => {
  it('reads the provider slot for each operation (boolean and options forms)', () => {
    const caps: WireServerCapabilities = {
      definitionProvider: true,
      referencesProvider: { workDoneProgress: true },
      implementationProvider: false,
      typeDefinitionProvider: true,
      documentSymbolProvider: { workDoneProgress: true },
      codeActionProvider: false,
      renameProvider: true,
    }
    expect(supportsOperation(caps, 'goToDefinition')).toBe(true)
    expect(supportsOperation(caps, 'findReferences')).toBe(true)
    expect(supportsOperation(caps, 'goToImplementation')).toBe(false)
    expect(supportsOperation(caps, 'goToTypeDefinition')).toBe(true)
    expect(supportsOperation(caps, 'documentSymbols')).toBe(true)
    expect(supportsOperation(caps, 'codeActions')).toBe(false)
    expect(supportsOperation(caps, 'rename')).toBe(true)
  })

  it('rejects diagnostics (publish-listener path has no capability slot)', () => {
    expect(supportsOperation({}, 'diagnostics')).toBe(false)
  })
})

describe('supportsTransientOpen', () => {
  it('accepts legacy Full and Incremental enums, rejects None and absent', () => {
    expect(supportsTransientOpen(1)).toBe(true)
    expect(supportsTransientOpen(2)).toBe(true)
    expect(supportsTransientOpen(0)).toBe(false)
    expect(supportsTransientOpen(undefined)).toBe(false)
  })

  it('accepts options with openClose:true and rejects openClose:false', () => {
    expect(supportsTransientOpen({ openClose: true })).toBe(true)
    expect(supportsTransientOpen({ openClose: false, change: 2 })).toBe(false)
  })

  it('requires an explicit openClose for the options form (no change-enum fallback)', () => {
    expect(supportsTransientOpen({ change: 1 })).toBe(false)
    expect(supportsTransientOpen({ change: 2 })).toBe(false)
    expect(supportsTransientOpen({})).toBe(false)
  })
})

describe('negotiatePositionEncoding', () => {
  it('defaults an omitted encoding to utf-16', () => {
    expect(negotiatePositionEncoding(undefined)).toBe('utf-16')
    expect(negotiatePositionEncoding('utf-16')).toBe('utf-16')
  })

  it('rejects any other encoding', () => {
    expect(() => negotiatePositionEncoding('utf-8')).toThrow(/unsupported position encoding/)
  })
})

describe('normalizeLocations', () => {
  it('returns empty only for the protocol no-result value null', () => {
    expect(normalizeLocations(null)).toEqual([])
    expect(() => normalizeLocations(undefined)).toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })

  it('maps a single Location', () => {
    expect(normalizeLocations({ uri: 'file:///a', range: RANGE })).toEqual([{ uri: 'file:///a', range: RANGE }])
  })

  it('maps an array of Locations', () => {
    const result = normalizeLocations([{ uri: 'file:///a', range: RANGE }, { uri: 'file:///b', range: RANGE }])
    expect(result.map(l => l.uri)).toEqual(['file:///a', 'file:///b'])
  })

  it('maps a LocationLink from targetUri + targetSelectionRange', () => {
    const link = { targetUri: 'file:///c', targetSelectionRange: RANGE, targetRange: RANGE }
    expect(normalizeLocations([link])).toEqual([{ uri: 'file:///c', range: RANGE }])
  })

  it('rejects a non-object entry', () => {
    expect(() => normalizeLocations([42])).toThrow(/non-object/)
  })

  it('rejects an entry that is neither a Location nor a LocationLink', () => {
    expect(() => normalizeLocations([{ nope: true }])).toThrow(/neither a Location nor a LocationLink/)
  })

  it('rejects a Location whose range is not an object', () => {
    expect(() => normalizeLocations([{ uri: 'file:///a', range: 'nope' }])).toThrow(/neither a Location/)
  })

  it('rejects a Location whose range positions are malformed', () => {
    expect(() => normalizeLocations([{ uri: 'file:///a', range: { start: null, end: null } }])).toThrow(/neither a Location/)
  })

  it('rejects negative and fractional position coordinates', () => {
    expect(() => normalizeLocations([{ uri: 'file:///a', range: { start: { line: -1, character: 0 }, end: RANGE.end } }]))
      .toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
    expect(() => normalizeLocations([{ uri: 'file:///a', range: { start: RANGE.start, end: { line: 1.5, character: 5 } } }]))
      .toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })
})

describe('normalizeHover', () => {
  it('returns null for null', () => {
    expect(normalizeHover(null)).toBeNull()
  })

  it('rejects a missing hover result', () => {
    expect(() => normalizeHover(undefined)).toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })

  it('reads MarkupContent value and keeps a range', () => {
    expect(normalizeHover({ contents: { kind: 'markdown', value: '# H' }, range: RANGE }))
      .toEqual({ contents: '# H', range: RANGE })
  })

  it('keeps a bare string MarkedString verbatim', () => {
    expect(normalizeHover({ contents: 'plain text' })).toEqual({ contents: 'plain text' })
  })

  it('renders a language-tagged MarkedString object as a fenced code block', () => {
    expect(normalizeHover({ contents: { language: 'ts', value: 'const x = 1' } }))
      .toEqual({ contents: '```ts\nconst x = 1\n```' })
  })

  it('joins a MarkedString array with one blank line', () => {
    expect(normalizeHover({ contents: ['a', { language: 'ts', value: 'b' }] }))
      .toEqual({ contents: 'a\n\n```ts\nb\n```' })
  })

  it('drops an empty-contents hover to null', () => {
    expect(normalizeHover({ contents: { kind: 'plaintext', value: '' } })).toBeNull()
  })

  it('rejects a MarkupContent with a non-string value', () => {
    expect(() => normalizeHover({ contents: { kind: 'markdown', value: 42 } }))
      .toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })

  it('rejects a non-object payload', () => {
    expect(() => normalizeHover(42)).toThrow(/was not an object/)
  })

  it('rejects malformed contents', () => {
    expect(() => normalizeHover({ contents: { weird: true } })).toThrow(/were not MarkupContent/)
    expect(() => normalizeHover({ contents: 42 })).toThrow(/were not MarkupContent/)
  })

  it('rejects a malformed MarkedString array member', () => {
    expect(() => normalizeHover({ contents: ['ok', { language: 'ts', value: 42 }] }))
      .toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
    expect(() => normalizeHover({ contents: [null] }))
      .toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })

  it('rejects a hover with no contents field', () => {
    expect(() => normalizeHover({ range: RANGE })).toThrow(/no contents/)
  })

  it('rejects a malformed range instead of silently dropping it', () => {
    expect(() => normalizeHover({ contents: 'x', range: { start: { line: 1 } } }))
      .toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
  })
})

describe('normalizeDocumentSymbols', () => {
  it('returns empty for null and []; rejects missing and non-array payloads', () => {
    expect(normalizeDocumentSymbols(null)).toEqual([])
    expect(normalizeDocumentSymbols([])).toEqual([])
    expect(() => normalizeDocumentSymbols(undefined)).toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
    expect(() => normalizeDocumentSymbols({ name: 'x', kind: 2 })).toThrow(/not an array/)
  })

  it('flattens a hierarchical DocumentSymbol tree in document order with depth', () => {
    const payload = [
      {
        name: 'outer',
        kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        detail: 'class Outer',
        children: [
          {
            name: 'inner',
            kind: 6,
            range: { start: { line: 1, character: 2 }, end: { line: 1, character: 9 } },
            selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
          },
        ],
      },
    ]
    const result = normalizeDocumentSymbols(payload)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      name: 'outer',
      kind: 5,
      depth: 0,
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      detail: 'class Outer',
    })
    expect(result[1]).toMatchObject({ name: 'inner', kind: 6, depth: 1 })
  })

  it('falls back range to selectionRange when a hierarchical symbol has no range', () => {
    const result = normalizeDocumentSymbols([{ name: 'a', kind: 2, selectionRange: RANGE, children: [] }])
    expect(result[0]?.range).toEqual(RANGE)
  })

  it('rejects a hierarchical symbol missing both selectionRange and location markers', () => {
    expect(() => normalizeDocumentSymbols([{ name: 'a', kind: 2, range: RANGE }]))
      .toThrow(/neither selectionRange nor location/)
  })

  it('maps flat SymbolInformation entries to leaf symbols', () => {
    const result = normalizeDocumentSymbols([{ name: 'b', kind: 2, location: { uri: 'file:///b', range: RANGE }, containerName: 'lib' }])
    expect(result).toEqual([{ name: 'b', kind: 2, range: RANGE, selectionRange: RANGE, depth: 0 }])
  })

  it('rejects entries that are neither DocumentSymbol nor SymbolInformation', () => {
    expect(() => normalizeDocumentSymbols([{ nope: true }])).toThrow(/malformed symbol/)
    expect(() => normalizeDocumentSymbols([null])).toThrow(/non-object/)
    expect(() => normalizeDocumentSymbols([{ name: 'x' }])).toThrow(/malformed symbol/)
  })
})

describe('normalizeCodeActions', () => {
  it('returns empty for null and []; rejects missing/non-array payloads', () => {
    expect(normalizeCodeActions(null)).toEqual([])
    expect(normalizeCodeActions([])).toEqual([])
    expect(() => normalizeCodeActions(undefined)).toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
    expect(() => normalizeCodeActions({ title: 'x', kind: 'quickfix' })).toThrow(/not an array/)
  })

  it('normalizes CodeAction entries with title/kind/isPreferred and their diagnostics', () => {
    const result = normalizeCodeActions([{
      title: 'Fix it',
      kind: 'quickfix',
      isPreferred: true,
      diagnostics: [{ range: RANGE, message: 'oops', severity: 1, source: 'ts' }],
    }])
    expect(result).toEqual([{
      title: 'Fix it',
      kind: 'quickfix',
      isPreferred: true,
      diagnostics: [{ range: RANGE, message: 'oops', severity: 1, source: 'ts' }],
    }])
  })

  it('keeps Command entries as title-only actions', () => {
    const result = normalizeCodeActions([{ title: 'Run command', command: 'x.run' }])
    expect(result).toEqual([{ title: 'Run command', diagnostics: [] }])
  })

  it('drops the edits field (the seam never materializes unresolved edits)', () => {
    const result = normalizeCodeActions([{
      title: 'Refactor',
      kind: 'refactor',
      edit: { changes: { 'file:///a': [{ range: RANGE, newText: 'x' }] } },
    }])
    expect(result[0]?.diagnostics).toEqual([])
    expect('edit' in (result[0] as object)).toBe(false)
  })

  it('rejects entries with a non-string title', () => {
    expect(() => normalizeCodeActions([{ title: 42, kind: 'quickfix' }])).toThrow(/without a title/)
  })
})

describe('normalizeRename', () => {
  it('returns empty for null and []; rejects malformed payloads', () => {
    expect(normalizeRename(null)).toEqual([])
    expect(normalizeRename([])).toEqual([])
    expect(() => normalizeRename(undefined)).toThrow(expect.objectContaining({ code: 'LSP_MALFORMED_RESPONSE' }))
    expect(() => normalizeRename({ changes: 'nope' })).toThrow(/non-array edit list/)
  })

  it('maps the changes map to per-file TextEdit lists preserving order', () => {
    const result = normalizeRename({
      changes: {
        'file:///a': [{ range: RANGE, newText: 'x' }],
        'file:///b': [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: 'y' },
          { range: RANGE, newText: 'z' },
        ],
      },
    })
    expect(result).toEqual([
      { uri: 'file:///a', edits: [{ range: RANGE, newText: 'x' }] },
      { uri: 'file:///b', edits: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: 'y' },
        { range: RANGE, newText: 'z' },
      ] },
    ])
  })

  it('ignores documentChanges (structural edit support is out of seam scope) and returns empty', () => {
    expect(normalizeRename({ documentChanges: [{ textDocument: { uri: 'file:///a', version: 1 }, edits: [{ range: RANGE, newText: 'x' }] }] }))
      .toEqual([])
  })

  it('rejects a malformed TextEdit member', () => {
    expect(() => normalizeRename({ changes: { 'file:///a': [{ range: RANGE }] } }))
      .toThrow(/malformed TextEdit/)
    expect(() => normalizeRename({ changes: { 'file:///a': ['nope'] } }))
      .toThrow(/non-object TextEdit/)
  })

  it('skips null edit lists (a null change for one URI) while keeping the rest', () => {
    const result = normalizeRename({ changes: { 'file:///a': null, 'file:///b': [{ range: RANGE, newText: 'x' }] } })
    expect(result).toEqual([{ uri: 'file:///b', edits: [{ range: RANGE, newText: 'x' }] }])
  })

  it('returns empty for a workspace-edit without changes and for an object missing changes', () => {
    expect(normalizeRename({ edit: { changes: { 'file:///a': [{ range: RANGE, newText: 'x' }] } } })).toEqual([])
    expect(normalizeRename({})).toEqual([])
  })
})
