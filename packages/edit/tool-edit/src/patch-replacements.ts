/**
 * Sequence matching for patch application: locates each hunk's old lines in
 * the file with hint-aware, fuzzy-tolerant search and computes the line
 * replacements. Split out of patch.ts.
 */
import { ApplyPatchError, type DiffHunk } from './diff.ts'
import { normalizeForFuzzy } from './normalize.ts'
import { adjustLinesIndentation } from './patch-indent.ts'
import {
  type ContextLineResult,
  findClosestSequenceMatch,
  findContextLine,
  type SequenceSearchResult,
  seekSequence,
} from './replace.ts'

// ═══════════════════════════════════════════════════════════════════════════
// Internal Types
// ═══════════════════════════════════════════════════════════════════════════

export interface Replacement {
  startIndex: number
  oldLen: number
  newLines: string[]
}

type HunkVariantKind = 'trim-common' | 'dedupe-shared' | 'collapse-repeated' | 'single-line'

interface HunkVariant {
  oldLines: string[]
  newLines: string[]
  kind: HunkVariantKind
}

// ═══════════════════════════════════════════════════════════════════════════
// Hunk Variant Builders
// ═══════════════════════════════════════════════════════════════════════════

function trimCommonContext(oldLines: string[], newLines: string[]): HunkVariant | undefined {
  let start = 0
  let endOld = oldLines.length
  let endNew = newLines.length

  while (start < endOld && start < endNew && oldLines[start] === newLines[start]) {
    start++
  }

  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--
    endNew--
  }

  if (start === 0 && endOld === oldLines.length && endNew === newLines.length) {
    return undefined
  }

  const trimmedOld = oldLines.slice(start, endOld)
  const trimmedNew = newLines.slice(start, endNew)
  if (trimmedOld.length === 0 && trimmedNew.length === 0) {
    return undefined
  }
  return { oldLines: trimmedOld, newLines: trimmedNew, kind: 'trim-common' }
}

function collapseConsecutiveSharedLines(oldLines: string[], newLines: string[]): HunkVariant | undefined {
  const newSet = new Set(newLines)
  const shared = new Set(oldLines.filter(line => newSet.has(line)))
  const collapse = (lines: string[]): string[] => {
    const out: string[] = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i] ?? ''
      out.push(line)
      let j = i + 1
      while (j < lines.length && lines[j] === line && shared.has(line)) {
        j++
      }
      i = j
    }
    return out
  }

  const collapsedOld = collapse(oldLines)
  const collapsedNew = collapse(newLines)
  if (collapsedOld.length === oldLines.length && collapsedNew.length === newLines.length) {
    return undefined
  }
  return { oldLines: collapsedOld, newLines: collapsedNew, kind: 'dedupe-shared' }
}

function collapseRepeatedBlocks(oldLines: string[], newLines: string[]): HunkVariant | undefined {
  const newSet = new Set(newLines)
  const shared = new Set(oldLines.filter(line => newSet.has(line)))
  const collapse = (lines: string[]): string[] => {
    const output = [...lines]
    let changed = false
    let i = 0
    while (i < output.length) {
      let collapsed = false
      // Only blocks whose lines are all shared are collapsible; if the first line
      // is not shared no size can match, so skip the size search entirely.
      if (shared.has(output[i] ?? '')) {
        for (let size = Math.floor((output.length - i) / 2); size >= 2; size--) {
          let same = true
          for (let idx = 0; idx < size; idx++) {
            if ((output[i + idx] ?? '') !== (output[i + size + idx] ?? '') || !shared.has(output[i + idx] ?? '')) {
              same = false
              break
            }
          }
          if (same) {
            output.splice(i + size, size)
            changed = true
            collapsed = true
            break
          }
        }
      }
      if (!collapsed) {
        i++
      }
    }
    return changed ? output : lines
  }

  const collapsedOld = collapse(oldLines)
  const collapsedNew = collapse(newLines)
  if (collapsedOld.length === oldLines.length && collapsedNew.length === newLines.length) {
    return undefined
  }
  return { oldLines: collapsedOld, newLines: collapsedNew, kind: 'collapse-repeated' }
}

function reduceToSingleLineChange(oldLines: string[], newLines: string[]): HunkVariant | undefined {
  if (oldLines.length !== newLines.length || oldLines.length === 0) return undefined
  let changedIndex: number | undefined
  for (let i = 0; i < oldLines.length; i++) {
    if (oldLines[i] !== newLines[i]) {
      if (changedIndex !== undefined) return undefined
      changedIndex = i
    }
  }
  if (changedIndex === undefined) return undefined
  return { oldLines: [oldLines[changedIndex] ?? ''], newLines: [newLines[changedIndex] ?? ''], kind: 'single-line' }
}

function buildFallbackVariants(hunk: DiffHunk): HunkVariant[] {
  const variants: HunkVariant[] = []
  const base: HunkVariant = { oldLines: hunk.oldLines, newLines: hunk.newLines, kind: 'trim-common' }

  const trimmed = trimCommonContext(base.oldLines, base.newLines)
  if (trimmed) variants.push(trimmed)

  const deduped = collapseConsecutiveSharedLines(
    trimmed?.oldLines ?? base.oldLines,
    trimmed?.newLines ?? base.newLines,
  )
  if (deduped) variants.push(deduped)

  const collapsed = collapseRepeatedBlocks(
    deduped?.oldLines ?? trimmed?.oldLines ?? base.oldLines,
    deduped?.newLines ?? trimmed?.newLines ?? base.newLines,
  )
  if (collapsed) variants.push(collapsed)

  const singleLine = reduceToSingleLineChange(trimmed?.oldLines ?? base.oldLines, trimmed?.newLines ?? base.newLines)
  if (singleLine) variants.push(singleLine)

  const seen = new Set<string>()
  return variants.filter((variant) => {
    if (variant.oldLines.length === 0 && variant.newLines.length === 0) return false
    const key = `${variant.oldLines.join('\n')}||${variant.newLines.join('\n')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function filterFallbackVariants(variants: HunkVariant[], allowAggressive: boolean): HunkVariant[] {
  if (allowAggressive) return variants
  return variants.filter(variant => variant.kind !== 'collapse-repeated' && variant.kind !== 'single-line')
}

// ═══════════════════════════════════════════════════════════════════════════
// Sequence + Context Matching
// ═══════════════════════════════════════════════════════════════════════════

function findContextRelativeMatch(
  lines: string[],
  patternLine: string,
  contextIndex: number,
  preferSecondForwardMatch: boolean,
): number | undefined {
  const trimmed = patternLine.trim()
  const forwardMatches: number[] = []
  for (let i = contextIndex + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === trimmed) {
      forwardMatches.push(i)
    }
  }
  if (forwardMatches.length > 0) {
    if (preferSecondForwardMatch && forwardMatches.length > 1) {
      return forwardMatches[1]
    }
    return forwardMatches[0]
  }
  for (let i = contextIndex - 1; i >= 0; i--) {
    if ((lines[i] ?? '').trim() === trimmed) {
      return i
    }
  }
  return undefined
}

const AMBIGUITY_HINT_WINDOW = 200
const MATCH_PREVIEW_CONTEXT = 2
const MATCH_PREVIEW_MAX_LEN = 80

function formatSequenceMatchPreview(lines: string[], startIdx: number): string {
  const start = Math.max(0, startIdx - MATCH_PREVIEW_CONTEXT)
  const end = Math.min(lines.length, startIdx + MATCH_PREVIEW_CONTEXT + 1)
  const previewLines = lines.slice(start, end)
  return previewLines
    .map((line, i) => {
      const num = start + i + 1
      const truncated = line.length > MATCH_PREVIEW_MAX_LEN ? `${line.slice(0, MATCH_PREVIEW_MAX_LEN - 1)}…` : line
      return `  ${num} | ${truncated}`
    })
    .join('\n')
}

function formatSequenceMatchPreviews(
  lines: string[],
  matchIndices: number[] | undefined,
  matchCount: number | undefined,
): string | undefined {
  if (!matchIndices || matchIndices.length === 0) return undefined
  const previews = matchIndices.map(index => formatSequenceMatchPreview(lines, index))
  const moreMsg =
    matchCount && matchCount > matchIndices.length ? ` (showing first ${matchIndices.length} of ${matchCount})` : ''
  return `${previews.join('\n\n')}${moreMsg}`
}

function chooseHintedMatch(
  matchIndices: number[] | undefined,
  hintIndex: number | undefined,
  window: number,
): number | undefined {
  if (!matchIndices || matchIndices.length === 0 || hintIndex === undefined) return undefined
  const candidates = matchIndices.filter(index => Math.abs(index - hintIndex) <= window)
  if (candidates.length === 1) return candidates[0]
  return undefined
}

/** Get hint index from hunk's line number */
function getHunkHintIndex(hunk: DiffHunk, currentIndex: number): number | undefined {
  if (hunk.oldStartLine === undefined) return undefined
  const hintIndex = Math.max(0, hunk.oldStartLine - 1)
  return hintIndex >= currentIndex ? hintIndex : undefined
}

/**
 * Find hierarchical context in file lines.
 *
 * Handles three formats:
 * 1. Simple context: "function foo" - find this line
 * 2. Hierarchical (newline): "class Foo\nmethod" - find class, then method after it
 * 3. Hierarchical (space): "class Foo method" - try as literal first, then split and search
 *
 * @returns The result from finding the final (innermost) context, or undefined if not found
 */
function findHierarchicalContext(
  lines: string[],
  context: string,
  startFrom: number,
  lineHint: number | undefined,
  allowFuzzy: boolean,
): ContextLineResult {
  // Check for newline-separated hierarchical contexts (from nested @@ anchors)
  if (context.includes('\n')) {
    const parts = context
      .split('\n')
      .map(p => p.trim())
      .filter(p => p.length > 0)
    let currentStart = startFrom

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? ''
      const isLast = i === parts.length - 1

      const result = findContextLine(lines, part, currentStart, { allowFuzzy })

      if (result.matchCount !== undefined && result.matchCount > 1) {
        if (isLast && lineHint !== undefined) {
          const hintStart = Math.max(0, lineHint - 1)
          if (hintStart >= currentStart) {
            const hintedResult = findContextLine(lines, part, hintStart, { allowFuzzy })
            if (hintedResult.index !== undefined) {
              return { ...hintedResult, matchCount: 1, matchIndices: [hintedResult.index] }
            }
          }
        }
        return {
          index: undefined,
          confidence: result.confidence,
          matchCount: result.matchCount,
          matchIndices: result.matchIndices,
          strategy: result.strategy,
        }
      }

      if (result.index === undefined) {
        if (isLast && lineHint !== undefined) {
          const hintStart = Math.max(0, lineHint - 1)
          if (hintStart >= currentStart) {
            const hintedResult = findContextLine(lines, part, hintStart, { allowFuzzy })
            if (hintedResult.index !== undefined) {
              return { ...hintedResult, matchCount: 1, matchIndices: [hintedResult.index] }
            }
          }
        }
        return { index: undefined, confidence: result.confidence }
      }

      if (isLast) {
        return result
      }
      currentStart = result.index + 1
    }
    return { index: undefined, confidence: 0 }
  }

  // Try literal context first
  const spaceParts = context.split(/\s+/).filter(p => p.length > 0)
  const hasSignatureChars = /[(){}[\]]/.test(context)
  if (!hasSignatureChars && spaceParts.length > 2) {
    const outer = spaceParts.slice(0, -1).join(' ')
    const inner = spaceParts[spaceParts.length - 1] ?? ''
    const outerResult = findContextLine(lines, outer, startFrom, { allowFuzzy })
    if (outerResult.matchCount !== undefined && outerResult.matchCount > 1) {
      return {
        index: undefined,
        confidence: outerResult.confidence,
        matchCount: outerResult.matchCount,
        matchIndices: outerResult.matchIndices,
        strategy: outerResult.strategy,
      }
    }
    if (outerResult.index !== undefined) {
      const innerResult = findContextLine(lines, inner, outerResult.index + 1, { allowFuzzy })
      if (innerResult.index !== undefined) {
        return innerResult.matchCount && innerResult.matchCount > 1
          ? { ...innerResult, matchCount: 1, matchIndices: [innerResult.index] }
          : innerResult
      }
      if (innerResult.matchCount !== undefined && innerResult.matchCount > 1) {
        return {
          ...innerResult,
          matchCount: 1,
          matchIndices: innerResult.matchIndices,
        }
      }
    }
  }

  const result = findContextLine(lines, context, startFrom, { allowFuzzy })

  // If line hint exists and result is ambiguous or missing, try from hint
  if ((result.index === undefined || (result.matchCount ?? 0) > 1) && lineHint !== undefined) {
    const hintStart = Math.max(0, lineHint - 1)
    const hintedResult = findContextLine(lines, context, hintStart, { allowFuzzy })
    if (hintedResult.index !== undefined) {
      return { ...hintedResult, matchCount: 1, matchIndices: [hintedResult.index] }
    }
  }

  // If found uniquely, return it
  if (result.index !== undefined && (result.matchCount ?? 0) <= 1) {
    return result
  }
  if (result.matchCount !== undefined && result.matchCount > 1) {
    return result
  }

  // Try from beginning if not found from current position
  if (result.index === undefined && startFrom !== 0) {
    const fromStartResult = findContextLine(lines, context, 0, { allowFuzzy })
    if (fromStartResult.index !== undefined && (fromStartResult.matchCount ?? 0) <= 1) {
      return fromStartResult
    }
    if (fromStartResult.matchCount !== undefined && fromStartResult.matchCount > 1) {
      return fromStartResult
    }
  }

  // Fallback: try space-separated hierarchical matching
  // e.g., "class PatchTool constructor" -> find "class PatchTool", then "constructor" after it
  if (!hasSignatureChars && spaceParts.length > 1) {
    const outer = spaceParts.slice(0, -1).join(' ')
    const inner = spaceParts[spaceParts.length - 1] ?? ''
    const outerResult = findContextLine(lines, outer, startFrom, { allowFuzzy })

    if (outerResult.matchCount !== undefined && outerResult.matchCount > 1) {
      return {
        index: undefined,
        confidence: outerResult.confidence,
        matchCount: outerResult.matchCount,
        matchIndices: outerResult.matchIndices,
        strategy: outerResult.strategy,
      }
    }

    if (outerResult.index === undefined) {
      return { index: undefined, confidence: outerResult.confidence }
    }

    const innerResult = findContextLine(lines, inner, outerResult.index + 1, { allowFuzzy })
    if (innerResult.index !== undefined) {
      return innerResult.matchCount && innerResult.matchCount > 1
        ? { ...innerResult, matchCount: 1, matchIndices: [innerResult.index] }
        : innerResult
    }
    if (innerResult.matchCount !== undefined && innerResult.matchCount > 1) {
      return {
        ...innerResult,
        matchCount: 1,
        matchIndices: innerResult.matchIndices,
      }
    }
  }

  return result
}

/** Find sequence with optional hint position, returning full search result */
function findSequenceWithHint(
  lines: string[],
  pattern: string[],
  currentIndex: number,
  hintIndex: number | undefined,
  eof: boolean,
  allowFuzzy: boolean,
): SequenceSearchResult {
  // Prefer content-based search starting from currentIndex
  const primaryResult = seekSequence(lines, pattern, currentIndex, eof, { allowFuzzy })
  if (
    primaryResult.matchCount &&
    primaryResult.matchCount > 1 &&
    hintIndex !== undefined &&
    hintIndex !== currentIndex
  ) {
    const hintedResult = seekSequence(lines, pattern, hintIndex, eof, { allowFuzzy })
    if (hintedResult.index !== undefined && (hintedResult.matchCount ?? 1) <= 1) {
      return hintedResult
    }
    if (hintedResult.matchCount && hintedResult.matchCount > 1) {
      return hintedResult
    }
  }
  if (primaryResult.index !== undefined || (primaryResult.matchCount && primaryResult.matchCount > 1)) {
    return primaryResult
  }

  // Use line hint as a secondary bias only if needed
  if (hintIndex !== undefined && hintIndex !== currentIndex) {
    const hintedResult = seekSequence(lines, pattern, hintIndex, eof, { allowFuzzy })
    if (hintedResult.index !== undefined || (hintedResult.matchCount && hintedResult.matchCount > 1)) {
      return hintedResult
    }
  }

  // Last resort: search from beginning (handles out-of-order hunks)
  if (currentIndex !== 0) {
    const fromStartResult = seekSequence(lines, pattern, 0, eof, { allowFuzzy })
    if (fromStartResult.index !== undefined || (fromStartResult.matchCount && fromStartResult.matchCount > 1)) {
      return fromStartResult
    }
  }

  return primaryResult
}

function attemptSequenceFallback(
  lines: string[],
  hunk: DiffHunk,
  currentIndex: number,
  lineHint: number | undefined,
  allowFuzzy: boolean,
  allowAggressiveFallbacks: boolean,
): number | undefined {
  if (hunk.oldLines.length === 0) return undefined
  const matchHint = getHunkHintIndex(hunk, currentIndex)
  const fallbackResult = findSequenceWithHint(
    lines,
    hunk.oldLines,
    currentIndex,
    matchHint ?? lineHint,
    false,
    allowFuzzy,
  )
  if (fallbackResult.index !== undefined && (fallbackResult.matchCount ?? 1) <= 1) {
    const nextIndex = fallbackResult.index + 1
    if (nextIndex <= lines.length - hunk.oldLines.length) {
      const secondMatch = seekSequence(lines, hunk.oldLines, nextIndex, false, { allowFuzzy })
      if (secondMatch.index !== undefined) {
        return undefined
      }
    }
    return fallbackResult.index
  }

  for (const variant of filterFallbackVariants(buildFallbackVariants(hunk), allowAggressiveFallbacks)) {
    if (variant.oldLines.length === 0) continue
    const variantResult = findSequenceWithHint(
      lines,
      variant.oldLines,
      currentIndex,
      matchHint ?? lineHint,
      false,
      allowFuzzy,
    )
    if (variantResult.index !== undefined && (variantResult.matchCount ?? 1) <= 1) {
      return variantResult.index
    }
  }
  return undefined
}

/**
 * A prefix/substring strategy matched pattern lines that cover only part of
 * the corresponding file lines; replacing whole lines would silently drop the
 * uncovered text the model never saw. Allow the replacement only when every
 * discarded piece (normalized) survives somewhere in the hunk's new lines.
 */
function assertPartialMatchPreservesDiscardedText(
  path: string,
  pattern: string[],
  matchedLines: string[],
  newLines: string[],
  matchStartIndex: number,
): void {
  let newLinesNorm: string | undefined
  for (let j = 0; j < pattern.length; j++) {
    const lineNorm = normalizeForFuzzy(matchedLines[j] ?? '')
    const patternNorm = normalizeForFuzzy(pattern[j] ?? '')
    if (lineNorm === patternNorm) continue
    const at = lineNorm.indexOf(patternNorm)
    if (at === -1) continue
    const discardedParts = [lineNorm.slice(0, at).trim(), lineNorm.slice(at + patternNorm.length).trim()]
    for (const part of discardedParts) {
      if (part.length === 0) continue
      newLinesNorm ??= newLines.map(normalizeForFuzzy).join('\n')
      if (!newLinesNorm.includes(part)) {
        throw new ApplyPatchError(
          `Refusing partial-line match in ${path} at line ${matchStartIndex + j + 1}: ` +
            `the file line also contains ${JSON.stringify(part)}, which the replacement would silently drop. ` +
            'Provide the complete line in the hunk.',
        )
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Replacement Computation
// ═══════════════════════════════════════════════════════════════════════════

/** Reject 1-indexed line hints before any matching happens. */
function assertValidLineHints(path: string, hunk: DiffHunk): void {
  if (hunk.oldStartLine !== undefined && hunk.oldStartLine < 1) {
    throw new ApplyPatchError(
      `Line hint ${hunk.oldStartLine} is out of range for ${path} (line numbers start at 1)`,
    )
  }
  if (hunk.newStartLine !== undefined && hunk.newStartLine < 1) {
    throw new ApplyPatchError(
      `Line hint ${hunk.newStartLine} is out of range for ${path} (line numbers start at 1)`,
    )
  }
}

/**
 * Locate a hunk's `@@` change context and derive the search start index from
 * it. Returns the context's own line index (which may be undefined when the
 * context did not resolve) plus the next `lineIndex` to continue from.
 */
function resolveChangeContext(
  originalLines: string[],
  path: string,
  hunk: DiffHunk,
  changeContext: string,
  lineIndex: number,
  lineHint: number | undefined,
  allowFuzzy: boolean,
  allowAggressiveFallbacks: boolean,
): { index: number | undefined; lineIndex: number } {
  // Use hierarchical context matching for nested @@ anchors and space-separated contexts
  const result = findHierarchicalContext(originalLines, changeContext, lineIndex, lineHint, allowFuzzy)
  const idx = result.index

  if (idx === undefined || (result.matchCount !== undefined && result.matchCount > 1)) {
    const fallback = attemptSequenceFallback(
      originalLines,
      hunk,
      lineIndex,
      lineHint,
      allowFuzzy,
      allowAggressiveFallbacks,
    )
    if (fallback !== undefined) {
      lineIndex = fallback
    } else if (result.matchCount !== undefined && result.matchCount > 1) {
      const displayContext = changeContext.includes('\n') ? changeContext.split('\n').join(' > ') : changeContext
      const previews = formatSequenceMatchPreviews(originalLines, result.matchIndices, result.matchCount)
      const strategyHint = result.strategy ? ` Matching strategy: ${result.strategy}.` : ''
      const previewText = previews ? `\n\n${previews}` : ''
      throw new ApplyPatchError(
        `Found ${result.matchCount} matches for context '${displayContext}' in ${path}.${strategyHint}` +
          `${previewText}\n\nAdd more surrounding context or additional @@ anchors to make it unique.`,
      )
    } else {
      const displayContext = changeContext.includes('\n') ? changeContext.split('\n').join(' > ') : changeContext
      throw new ApplyPatchError(`Failed to find context '${displayContext}' in ${path}`)
    }
  } else {
    // If oldLines[0] matches the final context, start search at idx (not idx+1)
    // This handles the common case where @@ scope and first context line are identical
    const firstOldLine = hunk.oldLines[0]
    const finalContext = changeContext.includes('\n') ? changeContext.split('\n').pop()?.trim() : changeContext.trim()
    const isHierarchicalContext = changeContext.includes('\n') || changeContext.trim().split(/\s+/).length > 2
    if (firstOldLine !== undefined && (firstOldLine.trim() === finalContext || isHierarchicalContext)) {
      lineIndex = idx
    } else {
      lineIndex = idx + 1
    }
  }
  return { index: idx, lineIndex }
}

/**
 * Compute the insertion point for a pure-addition hunk: the resolved change
 * context position, then the 1-indexed line hint, then the end of the file
 * (before a single trailing blank line).
 */
function resolveInsertionIndex(path: string, hunk: DiffHunk, originalLines: string[], lineIndex: number): number {
  if (hunk.changeContext !== undefined) {
    // changeContext was processed above; lineIndex is set to the context line or after it
    return lineIndex
  }
  const lineHintForInsertion = hunk.oldStartLine ?? hunk.newStartLine
  if (lineHintForInsertion !== undefined) {
    // Reject if line hint is out of range for insertion
    // Valid insertion points are 1 to (file length + 1) for 1-indexed hints
    if (lineHintForInsertion < 1) {
      throw new ApplyPatchError(
        `Line hint ${lineHintForInsertion} is out of range for insertion in ${path} (line numbers start at 1)`,
      )
    }
    if (lineHintForInsertion > originalLines.length + 1) {
      throw new ApplyPatchError(
        `Line hint ${lineHintForInsertion} is out of range for insertion in ${path} (file has ${originalLines.length} lines)`,
      )
    }
    return Math.max(0, lineHintForInsertion - 1)
  }
  return originalLines.length > 0 && originalLines[originalLines.length - 1] === ''
    ? originalLines.length - 1
    : originalLines.length
}

/**
 * Search for a hunk's old lines: exact attempt first, then a retry without a
 * trailing empty line, then the pre-built fallback variants, then a
 * context-relative single-line match, and finally a hint-window
 * disambiguation of an ambiguous result.
 */
function searchHunkPattern(
  originalLines: string[],
  hunk: DiffHunk,
  lineIndex: number,
  lineHint: number | undefined,
  contextIndex: number | undefined,
  allowFuzzy: boolean,
  fallbackVariants: HunkVariant[],
): { pattern: string[]; newSlice: string[]; searchResult: SequenceSearchResult } {
  // Try to find the old lines in the file
  let pattern = [...hunk.oldLines]
  const matchHint = getHunkHintIndex(hunk, lineIndex)
  let searchResult = findSequenceWithHint(originalLines, pattern, lineIndex, matchHint, hunk.isEndOfFile, allowFuzzy)
  let newSlice = [...hunk.newLines]

  // Retry without trailing empty line if present
  if (searchResult.index === undefined && pattern.length > 0 && pattern[pattern.length - 1] === '') {
    pattern = pattern.slice(0, -1)
    if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '') {
      newSlice = newSlice.slice(0, -1)
    }
    searchResult = findSequenceWithHint(originalLines, pattern, lineIndex, matchHint, hunk.isEndOfFile, allowFuzzy)
  }

  if (searchResult.index === undefined || (searchResult.matchCount ?? 0) > 1) {
    for (const variant of fallbackVariants) {
      if (variant.oldLines.length === 0) continue
      const variantResult = findSequenceWithHint(
        originalLines,
        variant.oldLines,
        lineIndex,
        matchHint,
        hunk.isEndOfFile,
        allowFuzzy,
      )
      if (variantResult.index !== undefined && (variantResult.matchCount ?? 1) <= 1) {
        pattern = variant.oldLines
        newSlice = variant.newLines
        searchResult = variantResult
        break
      }
    }
  }

  if (searchResult.index === undefined && contextIndex !== undefined) {
    for (const variant of fallbackVariants) {
      if (variant.oldLines.length !== 1 || variant.newLines.length !== 1) continue
      const removedLine = variant.oldLines[0] ?? ''
      const hasSharedDuplicate = hunk.newLines.some(line => line.trim() === removedLine.trim())
      const adjacentIndex = findContextRelativeMatch(originalLines, removedLine, contextIndex, hasSharedDuplicate)
      if (adjacentIndex !== undefined) {
        pattern = variant.oldLines
        newSlice = variant.newLines
        searchResult = { index: adjacentIndex, confidence: 0.95 }
        break
      }
    }
  }

  if (searchResult.index !== undefined && contextIndex !== undefined && pattern.length === 1) {
    const trimmed = (pattern[0] ?? '').trim()
    let occurrenceCount = 0
    for (const line of originalLines) {
      if (line.trim() === trimmed) occurrenceCount++
    }
    if (occurrenceCount > 1) {
      const hasSharedDuplicate = hunk.newLines.some(line => line.trim() === trimmed)
      const contextMatch = findContextRelativeMatch(originalLines, pattern[0] ?? '', contextIndex, hasSharedDuplicate)
      if (contextMatch !== undefined) {
        searchResult = { index: contextMatch, confidence: searchResult.confidence }
      }
    }
  }

  if ((searchResult.matchCount ?? 0) > 1) {
    const hintIndex = matchHint ?? (lineHint ? lineHint - 1 : undefined)
    const hinted = chooseHintedMatch(searchResult.matchIndices, hintIndex, AMBIGUITY_HINT_WINDOW)
    if (hinted !== undefined) {
      searchResult = { ...searchResult, index: hinted, matchCount: 1 }
    }
  }

  return { pattern, newSlice, searchResult }
}

/** Throw the "found N matches" diagnostic for an ambiguous sequence match. */
function throwAmbiguousSequenceMatches(
  path: string,
  originalLines: string[],
  searchResult: SequenceSearchResult,
): never {
  const previews = formatSequenceMatchPreviews(originalLines, searchResult.matchIndices, searchResult.matchCount)
  const strategyHint = searchResult.strategy ? ` Matching strategy: ${searchResult.strategy}.` : ''
  const previewText = previews ? `\n\n${previews}` : ''
  throw new ApplyPatchError(
    `Found ${searchResult.matchCount} matches for the text in ${path}.${strategyHint}` +
      `${previewText}\n\nAdd more surrounding context or additional @@ anchors to make it unique.`,
  )
}

/** Throw the diagnostic for a hunk whose old lines could not be placed in the file. */
function throwMatchFailure(
  path: string,
  originalLines: string[],
  hunk: DiffHunk,
  pattern: string[],
  searchResult: SequenceSearchResult,
  lineIndex: number,
): never {
  if (searchResult.matchCount !== undefined && searchResult.matchCount > 1) {
    throwAmbiguousSequenceMatches(path, originalLines, searchResult)
  }
  const closest = findClosestSequenceMatch(originalLines, pattern, {
    start: lineIndex,
    eof: hunk.isEndOfFile,
  })
  if (closest.index !== undefined && closest.confidence > 0) {
    const similarityPercent = Math.round(closest.confidence * 100)
    const preview = formatSequenceMatchPreview(originalLines, closest.index)
    throw new ApplyPatchError(
      `Failed to find expected lines in ${path}:\n${hunk.oldLines.join('\n')}\n\n` +
        `Closest match (${similarityPercent}% similar) near line ${closest.index + 1}:\n${preview}`,
    )
  }
  throw new ApplyPatchError(`Failed to find expected lines in ${path}:\n${hunk.oldLines.join('\n')}`)
}

/** Record a warning when the match came from an inexact strategy. */
function pushMatchStrategyWarning(
  warnings: string[],
  path: string,
  found: number,
  searchResult: SequenceSearchResult,
): void {
  if (searchResult.strategy === 'fuzzy-dominant') {
    const similarityPercent = Math.round(searchResult.confidence * 100)
    warnings.push(`Dominant fuzzy match selected in ${path} near line ${found + 1} (${similarityPercent}% similar).`)
  } else if (
    searchResult.strategy === 'comment-prefix' ||
    searchResult.strategy === 'prefix' ||
    searchResult.strategy === 'substring' ||
    searchResult.strategy === 'fuzzy' ||
    searchResult.strategy === 'character'
  ) {
    const similarityPercent = Math.round(searchResult.confidence * 100)
    warnings.push(
      `Inexact match in ${path} near line ${found + 1}: matched via ${searchResult.strategy} strategy ` +
        `(${similarityPercent}% similar). Re-read the file if the result is not what you intended.`,
    )
  }
}

/**
 * For simple diffs (no context marker, no context lines), reject ambiguous
 * replacements when the pattern occurs again after `found`. Skipped when
 * `isEndOfFile` is set (EOF marker provides disambiguation).
 */
function assertSingleOccurrence(
  path: string,
  originalLines: string[],
  hunk: DiffHunk,
  pattern: string[],
  found: number,
  allowFuzzy: boolean,
): void {
  if (hunk.changeContext !== undefined || hunk.hasContextLines || hunk.isEndOfFile || hunk.oldStartLine !== undefined) {
    return
  }
  const secondMatch = seekSequence(originalLines, pattern, found + 1, false, { allowFuzzy })
  if (secondMatch.index !== undefined) {
    const preview1 = formatSequenceMatchPreview(originalLines, found)
    const preview2 = formatSequenceMatchPreview(originalLines, secondMatch.index)
    throw new ApplyPatchError(
      `Found 2 occurrences in ${path}:\n\n${preview1}\n\n${preview2}\n\n` +
        'Add more context lines to disambiguate.',
    )
  }
}

/** True when the matched pattern equals the replacement slice (pure context advance, no +/- change). */
function isPureContextHunk(pattern: string[], newSlice: string[]): boolean {
  if (pattern.length !== newSlice.length) return false
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== newSlice[i]) return false
  }
  return true
}

/** Throw when two replacements cover overlapping line ranges. */
function throwOnOverlappingReplacements(path: string, replacements: Replacement[]): void {
  for (let i = 1; i < replacements.length; i++) {
    const prev = replacements[i - 1] as Replacement
    const next = replacements[i] as Replacement
    const prevEnd = prev.startIndex + prev.oldLen
    if (next.startIndex < prevEnd) {
      const formatRange = (replacement: Replacement): string => {
        if (replacement.oldLen === 0) {
          return `${replacement.startIndex + 1} (insertion)`
        }
        return `${replacement.startIndex + 1}-${replacement.startIndex + replacement.oldLen}`
      }
      const prevRange = formatRange(prev)
      const nextRange = formatRange(next)
      throw new ApplyPatchError(
        `Overlapping hunks detected in ${path} at lines ${prevRange} and ${nextRange}. ` +
          'Split hunks or add more context to avoid overlap.',
      )
    }
  }
}

/**
 * Compute replacements needed to transform originalLines using the diff hunks.
 */
export function computeReplacements(
  originalLines: string[],
  path: string,
  hunks: DiffHunk[],
  allowFuzzy: boolean,
): { replacements: Replacement[]; warnings: string[] } {
  const replacements: Replacement[] = []
  const warnings: string[] = []
  let lineIndex = 0

  for (const hunk of hunks) {
    let contextIndex: number | undefined
    assertValidLineHints(path, hunk)
    const lineHint = hunk.oldStartLine
    const allowAggressiveFallbacks = hunk.changeContext !== undefined || lineHint !== undefined || hunk.isEndOfFile
    const fallbackVariants = filterFallbackVariants(buildFallbackVariants(hunk), allowAggressiveFallbacks)
    if (lineHint !== undefined && hunk.changeContext === undefined && !hunk.hasContextLines) {
      lineIndex = Math.max(0, Math.min(lineHint - 1, originalLines.length - 1))
    }

    // If hunk has a changeContext, find it and adjust lineIndex
    if (hunk.changeContext !== undefined) {
      const resolved = resolveChangeContext(
        originalLines,
        path,
        hunk,
        hunk.changeContext,
        lineIndex,
        lineHint,
        allowFuzzy,
        allowAggressiveFallbacks,
      )
      contextIndex = resolved.index
      lineIndex = resolved.lineIndex
    }

    if (hunk.oldLines.length === 0) {
      // Pure addition - prefer changeContext position, then line hint, then end of file
      replacements.push({
        startIndex: resolveInsertionIndex(path, hunk, originalLines, lineIndex),
        oldLen: 0,
        newLines: [...hunk.newLines],
      })
      continue
    }

    const { pattern, newSlice, searchResult } = searchHunkPattern(
      originalLines,
      hunk,
      lineIndex,
      lineHint,
      contextIndex,
      allowFuzzy,
      fallbackVariants,
    )

    if (searchResult.index === undefined) {
      throwMatchFailure(path, originalLines, hunk, pattern, searchResult, lineIndex)
    }
    const found = searchResult.index

    pushMatchStrategyWarning(warnings, path, found, searchResult)

    // Reject if match is ambiguous (prefix/substring matching found multiple matches)
    if (searchResult.matchCount !== undefined && searchResult.matchCount > 1) {
      throwAmbiguousSequenceMatches(path, originalLines, searchResult)
    }

    assertSingleOccurrence(path, originalLines, hunk, pattern, found, allowFuzzy)

    // Adjust indentation if needed (handles fuzzy matches where indentation differs)
    const actualMatchedLines = originalLines.slice(found, found + pattern.length)

    // Skip pure-context hunks (no +/- lines — oldLines === newLines).
    // They serve only to advance lineIndex for subsequent hunks.
    if (isPureContextHunk(pattern, newSlice)) {
      lineIndex = found + pattern.length
      continue
    }

    if (searchResult.strategy === 'prefix' || searchResult.strategy === 'substring') {
      assertPartialMatchPreservesDiscardedText(path, pattern, actualMatchedLines, newSlice, found)
    }

    const adjustedNewLines = adjustLinesIndentation(pattern, actualMatchedLines, newSlice)
    replacements.push({ startIndex: found, oldLen: pattern.length, newLines: adjustedNewLines })
    lineIndex = found + pattern.length
  }

  // Sort by start index
  replacements.sort((a, b) => a.startIndex - b.startIndex)

  throwOnOverlappingReplacements(path, replacements)

  return { replacements, warnings }
}
