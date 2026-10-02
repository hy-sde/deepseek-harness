/**
 * Indentation reconciliation for fuzzy-matched patch hunks: aligns the
 * replacement lines' indentation with the indentation actually found in the
 * file, including tab/space style conversion when the pattern and the file
 * disagree consistently. Split out of patch.ts.
 */
import { convertLeadingTabsToSpaces, countLeadingWhitespace, getLeadingWhitespace } from './normalize.ts'

function isBlankLine(line: string): boolean {
  return line.trim().length === 0
}

function areEqualLines(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function areEqualTrimmedLines(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i++) {
    if ((left[i] ?? '').trim() !== (right[i] ?? '').trim()) return false
  }
  return true
}

function getIndentChar(lines: string[]): string {
  for (const line of lines) {
    const ws = getLeadingWhitespace(line)
    if (ws.length > 0) return ws[0] ?? ' '
  }
  return ' '
}

function collectIndentDeltas(oldLines: string[], actualLines: string[]): number[] {
  const deltas: number[] = []
  const lineCount = Math.min(oldLines.length, actualLines.length)
  for (let i = 0; i < lineCount; i++) {
    const oldLine = oldLines[i] ?? ''
    const actualLine = actualLines[i] ?? ''
    if (isBlankLine(oldLine) || isBlankLine(actualLine)) continue
    deltas.push(countLeadingWhitespace(actualLine) - countLeadingWhitespace(oldLine))
  }
  return deltas
}

function applyIndentDelta(lines: string[], delta: number, indentChar: string): string[] {
  return lines.map((line) => {
    if (isBlankLine(line)) return line
    if (delta > 0) return `${indentChar.repeat(delta)}${line}`
    const toRemove = Math.min(-delta, countLeadingWhitespace(line))
    return line.slice(toRemove)
  })
}

function canConvertTabsToSpaces(oldLines: string[], actualLines: string[], spacesPerTab: number): boolean {
  const lineCount = Math.min(oldLines.length, actualLines.length)
  for (let i = 0; i < lineCount; i++) {
    const oldLine = oldLines[i] ?? ''
    const actualLine = actualLines[i] ?? ''
    if (isBlankLine(oldLine) || isBlankLine(actualLine)) continue
    const oldIndent = getLeadingWhitespace(oldLine)
    const actualIndent = getLeadingWhitespace(actualLine)
    if (oldIndent.length === 0) continue
    if (actualIndent.length !== oldIndent.length * spacesPerTab) {
      return false
    }
  }
  return true
}

/**
 * Which whitespace kinds dominate the pattern and the actual file: the
 * conversion branches below only fire on pure tab-pattern/space-file (or the
 * reverse) inputs; a single mixed line disables style conversion entirely.
 */
interface IndentWhitespaceProfile {
  patternTabOnly: boolean
  actualSpaceOnly: boolean
  patternSpaceOnly: boolean
  actualTabOnly: boolean
  patternMixed: boolean
  actualMixed: boolean
}

function profileIndentWhitespace(patternLines: string[], actualLines: string[]): IndentWhitespaceProfile {
  let patternTabOnly = true
  let actualSpaceOnly = true
  let patternSpaceOnly = true
  let actualTabOnly = true
  let patternMixed = false
  let actualMixed = false

  for (const line of patternLines) {
    if (line.trim().length === 0) continue
    const ws = getLeadingWhitespace(line)
    if (ws.includes(' ')) patternTabOnly = false
    if (ws.includes('\t')) patternSpaceOnly = false
    if (ws.includes(' ') && ws.includes('\t')) patternMixed = true
  }

  for (const line of actualLines) {
    if (line.trim().length === 0) continue
    const ws = getLeadingWhitespace(line)
    if (ws.includes('\t')) actualSpaceOnly = false
    if (ws.includes(' ')) actualTabOnly = false
    if (ws.includes(' ') && ws.includes('\t')) actualMixed = true
  }

  return { patternTabOnly, actualSpaceOnly, patternSpaceOnly, actualTabOnly, patternMixed, actualMixed }
}

/** Infer the spaces-per-tab ratio when the pattern uses tabs and the file spaces, or undefined when inconsistent. */
function inferTabsToSpacesRatio(patternLines: string[], actualLines: string[]): number | undefined {
  let ratio: number | undefined
  const lineCount = Math.min(patternLines.length, actualLines.length)
  let consistent = true
  for (let i = 0; i < lineCount; i++) {
    const patternLine = patternLines[i] ?? ''
    const actualLine = actualLines[i] ?? ''
    if (patternLine.trim().length === 0 || actualLine.trim().length === 0) continue
    const patternIndent = countLeadingWhitespace(patternLine)
    const actualIndent = countLeadingWhitespace(actualLine)
    if (patternIndent === 0) continue
    if (actualIndent % patternIndent !== 0) {
      consistent = false
      break
    }
    const nextRatio = actualIndent / patternIndent
    if (!ratio) {
      ratio = nextRatio
    } else if (ratio !== nextRatio) {
      consistent = false
      break
    }
  }
  if (!consistent) return undefined
  return ratio
}

/**
 * Collect (tabs, spaces) indentation pairs from matched lines, keyed by tab
 * count. Returns undefined when the same tab count maps to two different
 * space widths — the mapping is then not a function and no model exists.
 */
function collectTabWidthSamples(patternLines: string[], actualLines: string[]): Map<number, number> | undefined {
  const samples = new Map<number, number>() // tabs -> spaces
  const lineCount = Math.min(patternLines.length, actualLines.length)
  for (let i = 0; i < lineCount; i++) {
    const patternLine = patternLines[i] ?? ''
    const actualLine = actualLines[i] ?? ''
    if (patternLine.trim().length === 0 || actualLine.trim().length === 0) continue
    const spaces = countLeadingWhitespace(patternLine)
    const tabs = countLeadingWhitespace(actualLine)
    if (tabs === 0) continue
    const existing = samples.get(tabs)
    if (existing !== undefined && existing !== spaces) {
      return undefined
    }
    samples.set(tabs, spaces)
  }
  return samples
}

/**
 * Solve `spaces = tabs * width + offset` from the collected samples.
 * One sample: width = spaces / tabs, offset 0. Two+ distinct tab counts:
 * solve from the first two pairs, then validate against every sample.
 */
function inferSpacesToTabsModel(samples: ReadonlyMap<number, number>): { tabWidth: number; offset: number } | undefined {
  let tabWidth: number | undefined
  let offset = 0

  if (samples.size === 1) {
    // One level: assume offset=0, width = spaces / tabs
    const first = [...samples.entries()][0]
    if (first !== undefined) {
      const [tabs, spaces] = first
      if (tabs && spaces && spaces % tabs === 0) {
        tabWidth = spaces / tabs
      }
    }
  } else {
    // Two+ levels: solve via any two distinct pairs
    // spaces = tabs * width + offset  =>  width = (s2 - s1) / (t2 - t1)
    const entries = [...samples.entries()] as Array<[number, number]>
    const [t1, s1] = entries[0] ?? [0, 0]
    const [t2, s2] = entries[1] ?? [0, 0]
    if (t1 !== t2) {
      const w = (s2 - s1) / (t2 - t1)
      if (w > 0 && Number.isInteger(w)) {
        const b = s1 - t1 * w
        // Validate all samples against this model
        let valid = true
        for (const [t, s] of samples) {
          if (t * w + b !== s) {
            valid = false
            break
          }
        }
        if (valid) {
          tabWidth = w
          offset = b
        }
      }
    }
  }

  if (tabWidth !== undefined && tabWidth > 0) {
    return { tabWidth, offset }
  }
  return undefined
}

/** Convert space-indented replacement lines to the file's tab style using the inferred model. */
function convertSpacesToTabs(newLines: string[], tabWidth: number, offset: number): string[] {
  return newLines.map((line) => {
    if (line.trim().length === 0) return line
    const ws = countLeadingWhitespace(line)
    if (ws === 0) return line
    // Reverse: tabs = (spaces - offset) / width
    const adjusted = ws - offset
    if (adjusted >= 0 && adjusted % tabWidth === 0) {
      return '\t'.repeat(adjusted / tabWidth) + line.slice(ws)
    }
    // Partial tab — keep remainder as spaces
    const tabCount = Math.floor(adjusted / tabWidth)
    const remainder = adjusted - tabCount * tabWidth
    if (tabCount >= 0) {
      return '\t'.repeat(tabCount) + ' '.repeat(remainder) + line.slice(ws)
    }
    return line
  })
}

/** Group actual file lines by trimmed content; blank lines are skipped. */
function buildContentToActualLines(actualLines: string[]): Map<string, string[]> {
  const contentToActualLines = new Map<string, string[]>()
  for (const line of actualLines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const arr = contentToActualLines.get(trimmed)
    if (arr) {
      arr.push(line)
    } else {
      contentToActualLines.set(trimmed, [line])
    }
  }
  return contentToActualLines
}

/** Smallest leading-whitespace count over non-blank pattern lines; 0 when none. */
function computePatternMinIndent(patternLines: string[]): number {
  let patternMin = Infinity
  for (const line of patternLines) {
    if (line.trim().length === 0) continue
    patternMin = Math.min(patternMin, countLeadingWhitespace(line))
  }
  return patternMin === Infinity ? 0 : patternMin
}

/** The single indent delta shared by all matched line pairs, or undefined when deltas disagree or no pair exists. */
function computeConsistentIndentDelta(patternLines: string[], actualLines: string[]): number | undefined {
  const deltas = collectIndentDeltas(patternLines, actualLines)
  return deltas.length > 0 && deltas.every(value => value === deltas[0]) ? deltas[0] : undefined
}

/**
 * Reindent replacement lines: context lines (same trimmed content as the
 * actual file) take the file's exact text; new/added lines at the pattern's
 * minimum indent get the consistent delta applied.
 */
function indentNewLinesByContext(
  newLines: string[],
  contentToActualLines: ReadonlyMap<string, string[]>,
  patternMin: number,
  delta: number | undefined,
  indentChar: string,
): string[] {
  // Track which actual lines we've used to handle duplicate content correctly
  const usedActualLines = new Map<string, number>() // trimmed content -> count used

  return newLines.map((newLine) => {
    if (newLine.trim().length === 0) {
      return newLine
    }

    const trimmed = newLine.trim()
    const matchingActualLines = contentToActualLines.get(trimmed)

    // Check if this is a context line (same trimmed content exists in actual)
    if (matchingActualLines && matchingActualLines.length > 0) {
      if (matchingActualLines.length === 1) {
        return matchingActualLines[0] ?? newLine
      }
      if (matchingActualLines.includes(newLine)) {
        return newLine
      }
      const usedCount = usedActualLines.get(trimmed) ?? 0
      if (usedCount < matchingActualLines.length) {
        usedActualLines.set(trimmed, usedCount + 1)
        // Use actual file content directly for context lines
        return matchingActualLines[usedCount] ?? newLine
      }
    }

    // This is a new/added line - apply consistent delta if safe
    if (delta && delta !== 0) {
      const newIndent = countLeadingWhitespace(newLine)
      if (newIndent === patternMin) {
        return applyIndentDelta([newLine], delta, indentChar)[0] ?? newLine
      }
    }
    return newLine
  })
}

/** Adjust indentation of newLines to match the delta between patternLines and actualLines */
export function adjustLinesIndentation(patternLines: string[], actualLines: string[], newLines: string[]): string[] {
  if (patternLines.length === 0 || actualLines.length === 0 || newLines.length === 0) {
    return newLines
  }

  // If pattern already matches actual exactly (including indentation), preserve agent's intended changes
  if (areEqualLines(patternLines, actualLines)) {
    return newLines
  }

  // If the patch is purely an indentation change (same trimmed content), apply exactly as specified
  if (areEqualTrimmedLines(patternLines, newLines)) {
    return newLines
  }

  // Detect indent character from actual content
  const indentChar = getIndentChar(actualLines)
  const profile = profileIndentWhitespace(patternLines, actualLines)

  if (!profile.patternMixed && !profile.actualMixed && profile.patternTabOnly && profile.actualSpaceOnly) {
    const ratio = inferTabsToSpacesRatio(patternLines, actualLines)
    if (ratio && canConvertTabsToSpaces(patternLines, actualLines, ratio)) {
      return convertLeadingTabsToSpaces(newLines.join('\n'), ratio).split('\n')
    }
  }

  // Reverse: pattern uses spaces, actual uses tabs — infer spaces = tabs * width + offset
  // Collect (tabs, spaces) pairs from matched lines to solve for the model's tab rendering.
  // With one data point: spaces = tabs * width (offset=0).
  // With two+: solve ax + b via pairs with distinct tab counts.
  if (!profile.patternMixed && !profile.actualMixed && profile.patternSpaceOnly && profile.actualTabOnly) {
    const samples = collectTabWidthSamples(patternLines, actualLines)
    if (samples && samples.size > 0) {
      const model = inferSpacesToTabsModel(samples)
      if (model) {
        return convertSpacesToTabs(newLines, model.tabWidth, model.offset)
      }
    }
  }

  // Build a map from trimmed content to actual lines (by content, not position)
  // This handles fuzzy matches where pattern and actual may not be positionally aligned
  const contentToActualLines = buildContentToActualLines(actualLines)
  const patternMin = computePatternMinIndent(patternLines)
  const delta = computeConsistentIndentDelta(patternLines, actualLines)
  return indentNewLinesByContext(newLines, contentToActualLines, patternMin, delta, indentChar)
}
