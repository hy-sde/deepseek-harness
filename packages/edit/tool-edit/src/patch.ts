/**
 * Patch application logic for the edit tool: applies parsed diff hunks to
 * file content using fuzzy matching for robust handling of whitespace and
 * formatting differences. Adapter replaces oh-my-pi's `LspFileSystem` with a
 * harness `EditSession`-backed filesystem (ctx.fs reads/writes + writethrough).
 *
 * The original's plan-mode guard, ACP bridge, fs-cache invalidation, watcher
 * notifications and post-write disk verification are not ported (the harness
 * fs owns atomic writes); everything else is faithful.
 * Ported from @oh-my-pi/pi-coding-agent (https://github.com/can1357/oh-my-pi). MIT License. Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük.
 */
import * as path from 'node:path'
import type { EditSession } from './session.ts'
import type { EditDiagnosticsResult } from './lsp/writethrough.ts'
import {
  ApplyPatchError,
  type DiffHunk,
  generateUnifiedDiffString,
  normalizeCreateContent,
  parseDiffHunks,
  resolveToCwd,
} from './diff.ts'
import {
  adjustIndentation,
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from './normalize.ts'
import { DEFAULT_FUZZY_THRESHOLD, findMatch } from './replace.ts'
import { computeReplacements, type Replacement } from './patch-replacements.ts'

export type Operation = 'create' | 'delete' | 'update'

export interface PatchInput {
  path: string
  op: Operation
  rename?: string
  diff?: string
}

export interface FileSystem {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  readBinary?: (path: string) => Promise<Uint8Array>
  write(path: string, content: string): Promise<void>
  delete(path: string): Promise<void>
  mkdir(path: string): Promise<void>
}

/**
 * Default filesystem for {@link applyPatch} when no `fs` is supplied. The
 * tool flow always supplies an {@link EditSessionFileSystem}, so this only
 * surfaces a clear error for direct callers that forget one.
 */
const defaultFileSystem: FileSystem = {
  exists: () => Promise.reject(new Error('tool-edit: applyPatch requires an `fs` option')),
  read: () => Promise.reject(new Error('tool-edit: applyPatch requires an `fs` option')),
  write: () => Promise.reject(new Error('tool-edit: applyPatch requires an `fs` option')),
  delete: () => Promise.reject(new Error('tool-edit: applyPatch requires an `fs` option')),
  mkdir: () => Promise.reject(new Error('tool-edit: applyPatch requires an `fs` option')),
}

interface FileChange {
  type: Operation
  path: string
  newPath?: string
  oldContent?: string
  newContent?: string
}

export interface ApplyPatchResult {
  change: FileChange
  warnings?: string[]
}

export interface ApplyPatchOptions {
  cwd: string
  dryRun?: boolean
  fuzzyThreshold?: number
  allowFuzzy?: boolean
  fs?: FileSystem
  /**
   * Permit `op: "create"` to replace an existing file (full-file overwrite).
   * The JSON `patch` edit mode sanctions create-as-overwrite for major
   * restructures; the Codex `apply_patch` envelope documents `*** Add File`
   * as strictly non-overwriting and must leave this unset.
   */
  allowCreateOverwrite?: boolean
}

/**
 * Apply a hunk using character-based fuzzy matching.
 * Used when the hunk contains only -/+ lines without context.
 */
function applyCharacterMatch(
  originalContent: string,
  path: string,
  hunk: DiffHunk,
  fuzzyThreshold: number,
  allowFuzzy: boolean,
): { content: string; warnings: string[] } {
  const oldText = hunk.oldLines.join('\n')
  const newText = hunk.newLines.join('\n')

  const normalizedContent = normalizeToLF(originalContent)
  const normalizedOldText = normalizeToLF(oldText)

  let matchOutcome = findMatch(normalizedContent, normalizedOldText, {
    allowFuzzy,
    threshold: fuzzyThreshold,
  })
  if (!matchOutcome.match && allowFuzzy) {
    const relaxedThreshold = Math.min(fuzzyThreshold, 0.92)
    if (relaxedThreshold < fuzzyThreshold) {
      const relaxedOutcome = findMatch(normalizedContent, normalizedOldText, {
        allowFuzzy,
        threshold: relaxedThreshold,
      })
      if (relaxedOutcome.match) {
        matchOutcome = relaxedOutcome
      }
    }
  }

  // Check for multiple exact occurrences
  if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
    const previews = matchOutcome.occurrencePreviews?.join('\n\n') ?? ''
    const moreMsg = matchOutcome.occurrences > 5 ? ` (showing first 5 of ${matchOutcome.occurrences})` : ''
    throw new ApplyPatchError(
      `Found ${matchOutcome.occurrences} occurrences in ${path}${moreMsg}:\n\n${previews}\n\n` +
      'Add more context lines to disambiguate.',
    )
  }

  if (matchOutcome.fuzzyMatches && matchOutcome.fuzzyMatches > 1) {
    throw new ApplyPatchError(
      `Found ${matchOutcome.fuzzyMatches} high-confidence matches in ${path}. ` +
      'The text must be unique. Please provide more context to make it unique.',
    )
  }

  if (!matchOutcome.match) {
    const closest = matchOutcome.closest
    if (closest) {
      const similarityPercent = Math.round(closest.confidence * 100)
      throw new ApplyPatchError(
        `Could not find a close enough match in ${path}. ` +
        `Closest match (${similarityPercent}% similar) at line ${closest.startLine}.`,
      )
    }
    throw new ApplyPatchError(`Failed to find expected lines in ${path}:\n${oldText}`)
  }

  // Adjust indentation to match what was actually found
  const adjustedNewText = adjustIndentation(normalizedOldText, matchOutcome.match.actualText, newText)

  const warnings: string[] = []
  if (matchOutcome.dominantFuzzy) {
    const similarityPercent = Math.round(matchOutcome.match.confidence * 100)
    warnings.push(
      `Dominant fuzzy match selected in ${path} near line ${matchOutcome.match.startLine} (${similarityPercent}% similar).`,
    )
  }

  // Apply the replacement
  const before = normalizedContent.substring(0, matchOutcome.match.startIndex)
  const after = normalizedContent.substring(matchOutcome.match.startIndex + matchOutcome.match.actualText.length)
  return { content: before + adjustedNewText + after, warnings }
}

function applyTrailingNewlinePolicy(content: string, hadFinalNewline: boolean): string {
  if (hadFinalNewline) {
    return content.endsWith('\n') ? content : `${content}\n`
  }
  return content.replace(/\n+$/u, '')
}

async function readExistingPatchFile(fileSystem: FileSystem, absolutePath: string, path: string): Promise<string> {
  try {
    return await fileSystem.read(absolutePath)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('File not found:')) {
      throw new ApplyPatchError(`File not found: ${path}`)
    }
    // node error codes are surfaced only in adapter land; treat ENOENT-style
    // adapter errors generically by message prefix when available.
    throw error
  }
}

/**
 * Apply replacements to lines, returning the modified content.
 */
function applyReplacements(lines: string[], replacements: Replacement[]): string[] {
  const result = [...lines]

  // Apply in reverse order to maintain indices
  for (let i = replacements.length - 1; i >= 0; i--) {
    const { startIndex, oldLen, newLines } = replacements[i] as Replacement
    result.splice(startIndex, oldLen)
    result.splice(startIndex, 0, ...newLines)
  }

  return result
}

/**
 * Apply diff hunks to file content.
 */
function applyHunksToContent(
  originalContent: string,
  path: string,
  hunks: DiffHunk[],
  fuzzyThreshold: number,
  allowFuzzy: boolean,
): { content: string; warnings: string[] } {
  const hadFinalNewline = originalContent.endsWith('\n')

  // Detect simple replace pattern: single hunk, no @@ context, no context lines, has old lines to match
  // Only use character-based matching when there are no hints to disambiguate
  if (hunks.length === 1) {
    const hunk = hunks[0] as DiffHunk
    if (
      hunk.changeContext === undefined &&
      !hunk.hasContextLines &&
      hunk.oldLines.length > 0 &&
      hunk.oldStartLine === undefined && // No line hint to use for positioning
      !hunk.isEndOfFile // No EOF targeting (prefer end of file)
    ) {
      const { content, warnings } = applyCharacterMatch(originalContent, path, hunk, fuzzyThreshold, allowFuzzy)
      return { content: applyTrailingNewlinePolicy(content, hadFinalNewline), warnings }
    }
  }

  let originalLines = originalContent.split('\n')

  // Track if we have a trailing empty element from the final newline
  // Only strip ONE trailing empty (the newline marker), preserve actual blank lines
  let strippedTrailingEmpty = false
  if (hadFinalNewline && originalLines.length > 0 && originalLines[originalLines.length - 1] === '') {
    // Check if the second-to-last is also empty (actual blank line) - if so, only strip one
    originalLines = originalLines.slice(0, -1)
    strippedTrailingEmpty = true
  }

  const { replacements, warnings } = computeReplacements(originalLines, path, hunks, allowFuzzy)
  const newLines = applyReplacements(originalLines, replacements)

  // Restore the trailing empty element if we stripped it
  if (strippedTrailingEmpty) {
    newLines.push('')
  }

  const content = newLines.join('\n')
  return { content: applyTrailingNewlinePolicy(content, hadFinalNewline), warnings }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply a patch operation to the filesystem.
 */
export async function applyPatch(input: PatchInput, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
  return applyNormalizedPatch(input, options)
}

/**
 * Apply a normalized patch operation to the filesystem.
 * @internal
 */
async function applyNormalizedPatch(input: PatchInput, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
  const {
    cwd,
    dryRun = false,
    fs = defaultFileSystem,
    fuzzyThreshold = DEFAULT_FUZZY_THRESHOLD,
    allowFuzzy = true,
    allowCreateOverwrite = false,
  } = options

  const resolvePath = (p: string): string => resolveToCwd(p, cwd)
  const absolutePath = resolvePath(input.path)
  const op = input.op

  if (input.rename) {
    const destPath = resolvePath(input.rename)
    if (destPath === absolutePath) {
      throw new ApplyPatchError('rename path is the same as source path')
    }
    // The `*** Move to` / rename contract is strictly non-overwriting:
    // reject before the update path reads or writes anything, so both
    // source and pre-existing destination remain untouched. Callers who
    // really need to replace the destination must delete it in an
    // earlier hunk.
    if (await fs.exists(destPath)) {
      throw new ApplyPatchError(`Cannot rename ${input.path} to ${input.rename}: destination already exists.`)
    }
  }

  // Handle CREATE operation
  if (op === 'create') {
    if (!input.diff) {
      throw new ApplyPatchError('Create operation requires diff (file content)')
    }
    // The `*** Add File` contract of the apply_patch envelope is strictly
    // non-overwriting: reject before mkdir/write so pre-existing content
    // stays intact and the caller can re-issue as an explicit
    // `*** Update File` (or a delete+add pair) if overwrite is genuinely
    // intended. The JSON `patch` mode opts out via `allowCreateOverwrite`,
    // where `op: "create"` doubles as a sanctioned full-file overwrite.
    if (!allowCreateOverwrite && (await fs.exists(absolutePath))) {
      throw new ApplyPatchError(
        `Cannot create ${input.path}: file already exists. Use *** Update File to modify it in place.`,
      )
    }
    // Strip + prefixes if present (handles diffs formatted as additions)
    const normalizedContent = normalizeCreateContent(input.diff)
    const content = normalizedContent.endsWith('\n') ? normalizedContent : `${normalizedContent}\n`

    if (!dryRun) {
      const parentDir = path.dirname(absolutePath)
      if (parentDir && parentDir !== '.') {
        await fs.mkdir(parentDir)
      }
      await fs.write(absolutePath, content)
    }

    return {
      change: {
        type: 'create',
        path: absolutePath,
        newContent: content,
      },
    }
  }

  // Handle DELETE operation
  if (op === 'delete') {
    const oldContent = await readExistingPatchFile(fs, absolutePath, input.path)
    if (!dryRun) {
      await fs.delete(absolutePath)
    }

    return {
      change: {
        type: 'delete',
        path: absolutePath,
        oldContent,
      },
    }
  }

  // Handle UPDATE operation
  if (!input.diff) {
    throw new ApplyPatchError('Update operation requires diff (hunks)')
  }

  const originalContent = await readExistingPatchFile(fs, absolutePath, input.path)
  const { bom: bomFromText, text: strippedContent } = stripBom(originalContent)
  let bom = bomFromText
  if (!bom && fs.readBinary) {
    const bytes = await fs.readBinary(absolutePath)
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      bom = '\uFEFF'
    }
  }
  const lineEnding = detectLineEnding(strippedContent)
  const normalizedContent = normalizeToLF(strippedContent)
  const hunks = parseDiffHunks(input.diff)

  if (hunks.length === 0) {
    throw new ApplyPatchError('Diff contains no hunks')
  }

  const { content: newContent, warnings } = applyHunksToContent(
    normalizedContent,
    input.path,
    hunks,
    fuzzyThreshold,
    allowFuzzy,
  )
  const finalContent = bom + restoreLineEndings(newContent, lineEnding)
  const destPath = input.rename ? resolvePath(input.rename) : absolutePath
  const isMove = Boolean(input.rename) && destPath !== absolutePath

  if (!dryRun) {
    if (isMove) {
      const parentDir = path.dirname(destPath)
      if (parentDir && parentDir !== '.') {
        await fs.mkdir(parentDir)
      }
      await fs.write(destPath, finalContent)
      await fs.delete(absolutePath)
    } else {
      await fs.write(absolutePath, finalContent)
    }
  }

  return {
    change: {
      type: 'update',
      path: absolutePath,
      ...(isMove && destPath ? { newPath: destPath } : {}),
      oldContent: originalContent,
      newContent: finalContent,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/**
 * Preview what changes a patch would make without applying it.
 */
export async function previewPatch(input: PatchInput, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
  return applyPatch(input, { ...options, dryRun: true })
}

export async function computePatchDiff(
  input: PatchInput,
  cwd: string,
  options?: { fuzzyThreshold?: number; allowFuzzy?: boolean; allowCreateOverwrite?: boolean },
): Promise<
  | {
    diff: string
    firstChangedLine: number | undefined
  }
  | {
    error: string
  }
> {
  try {
    const result = await previewPatch(input, {
      cwd,
      ...(options?.fuzzyThreshold === undefined ? {} : { fuzzyThreshold: options.fuzzyThreshold }),
      ...(options?.allowFuzzy === undefined ? {} : { allowFuzzy: options.allowFuzzy }),
      ...(options?.allowCreateOverwrite === undefined ? {} : { allowCreateOverwrite: options.allowCreateOverwrite }),
    })
    const oldContent = result.change.oldContent ?? ''
    const newContent = result.change.newContent ?? ''
    const normalizedOld = normalizeToLF(stripBom(oldContent).text)
    const normalizedNew = normalizeToLF(stripBom(newContent).text)
    if (!normalizedOld && !normalizedNew) {
      return { diff: '', firstChangedLine: undefined }
    }
    return generateUnifiedDiffString(normalizedOld, normalizedNew, undefined, {
      path: result.change.newPath ?? result.change.path,
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Harness adapter + per-path execution
// ═══════════════════════════════════════════════════════════════════════════

export interface PatchEditEntry {
  op?: Operation
  rename?: string
  diff?: string
}

export interface PatchParams {
  path: string
  edits: PatchEditEntry[]
}

/** One executed patch edit result for the tool-level aggregator. */
export interface PatchEditOutcome {
  text: string
  change: FileChange
  diff: string
  firstChangedLine: number | undefined
  diagnostics?: EditDiagnosticsResult
}

/** Harness `FileSystem` adapter backed by the {@link EditSession}. */
export class EditSessionFileSystem implements FileSystem {
  #lastDiagnostics: EditDiagnosticsResult | undefined

  constructor(
    private readonly session: EditSession,
    private readonly signal?: AbortSignal,
  ) { }

  async exists(path: string): Promise<boolean> {
    const target = await this.session.reader.resolve(path, this.signal)
    return (await this.session.reader.stat(target, this.signal)) !== undefined
  }

  async read(path: string): Promise<string> {
    const target = await this.session.reader.resolve(path, this.signal)
    return this.session.reader.readText(target, this.signal)
  }

  readBinary(): Promise<Uint8Array> {
    // Binary BOM detection is not available through the harness text seam;
    // stripBom already covers text-level BOM detection.
    return Promise.resolve(new Uint8Array())
  }

  async write(path: string, content: string): Promise<void> {
    const target = await this.session.reader.resolve(path, this.signal)
    const result = await this.session.writethrough(path, content, this.signal)
    if (result.diagnostics !== undefined) {
      this.#lastDiagnostics = result.diagnostics
    }
    // The writethrough's `finalContent` is authoritative: with `formatOnWrite`
    // it is the formatter output, and the diagnostics above were collected
    // against it.
    await this.session.writer.write(target, result.finalContent, this.signal)
  }

  async delete(path: string): Promise<void> {
    const target = await this.session.reader.resolve(path, this.signal)
    await this.session.writer.delete(target, this.signal)
  }

  async mkdir(path: string): Promise<void> {
    // The harness fs seam has no mkdir; creating a parent is handled by
    // resolving the path (backend keeps identity stable) and letting the
    // write succeed — local backends create parents on write. For sandboxed
    // backends this degrades to the backend's own behavior.
    void (await this.session.reader.resolve(path, this.signal))
  }

  getDiagnostics(): EditDiagnosticsResult | undefined {
    return this.#lastDiagnostics
  }
}

function mergeDiagnosticsWithWarnings(
  diagnostics: EditDiagnosticsResult | undefined,
  warnings: string[],
): EditDiagnosticsResult | undefined {
  if (warnings.length === 0) return diagnostics
  const warningMessages = warnings.map(warning => `patch: ${warning}`)
  if (!diagnostics) {
    return {
      summary: `Patch warnings: ${warnings.length}`,
      messages: warningMessages.map(
        (text): EditDiagnosticsResult['messages'][number] => ({
          severity: 2,
          message: text,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        }),
      ),
    }
  }
  return {
    ...diagnostics,
    summary: `${diagnostics.summary}; Patch warnings: ${warnings.length}`,
  }
}

/** Options for executing one patch edit against a session. */
export interface ExecutePatchEntryOptions {
  session: EditSession
  path: string
  params: PatchEditEntry
  signal?: AbortSignal
  allowFuzzy: boolean
  fuzzyThreshold: number
  /** Set by the JSON `patch` mode only; see {@link ApplyPatchOptions.allowCreateOverwrite}. */
  allowCreateOverwrite?: boolean
}

/**
 * Execute one patch edit entry (create/delete/update/rename) for a path.
 * Reads, writes, deletes and renames all flow through the {@link EditSession}
 * seam; writethrough (format + diagnostics) runs before the guarded write.
 */
export async function executePatchEntry(options: ExecutePatchEntryOptions): Promise<PatchEditOutcome> {
  const { session, path, params, signal, allowFuzzy, fuzzyThreshold, allowCreateOverwrite } = options
  const { op: rawOp, rename, diff } = params

  const op: Operation = rawOp === 'create' || rawOp === 'delete' ? rawOp : 'update'
  const resolvedPath = await session.reader.resolve(path, signal)
  const resolvedRename = rename ? await session.reader.resolve(rename, signal) : undefined

  const input: PatchInput = {
    path: resolvedPath.displayPath,
    op,
    ...(resolvedRename === undefined ? {} : { rename: resolvedRename.displayPath }),
    ...(diff === undefined ? {} : { diff }),
  }
  const patchFileSystem = new EditSessionFileSystem(session, signal)
  const result = await applyPatch(input, {
    cwd: session.cwd,
    fs: patchFileSystem,
    fuzzyThreshold,
    allowFuzzy,
    ...(allowCreateOverwrite === undefined ? {} : { allowCreateOverwrite }),
  })

  const effectiveRename = result.change.newPath ? rename : undefined

  let diffResult: { diff: string; firstChangedLine: number | undefined } = {
    diff: '',
    firstChangedLine: undefined,
  }
  if (
    result.change.type === 'update' &&
    result.change.oldContent !== undefined &&
    result.change.newContent !== undefined
  ) {
    const normalizedOld = normalizeToLF(stripBom(result.change.oldContent).text)
    const normalizedNew = normalizeToLF(stripBom(result.change.newContent).text)
    diffResult = generateUnifiedDiffString(normalizedOld, normalizedNew, undefined, {
      path: result.change.newPath ?? result.change.path,
    })
  } else if (result.change.type === 'create' && result.change.newContent !== undefined) {
    const normalizedNew = normalizeToLF(stripBom(result.change.newContent).text)
    diffResult = generateUnifiedDiffString('', normalizedNew, undefined, { path: result.change.path })
  }

  let resultText: string
  switch (result.change.type) {
    case 'create':
      resultText = `Created ${path}`
      break
    case 'delete':
      resultText = `Deleted ${path}`
      break
    case 'update':
      resultText = effectiveRename ? `Updated and moved ${path} to ${effectiveRename}` : `Updated ${path}`
      break
  }

  const diagnostics = mergeDiagnosticsWithWarnings(patchFileSystem.getDiagnostics(), result.warnings ?? [])

  return {
    text: resultText,
    change: result.change,
    diff: diffResult.diff,
    firstChangedLine: diffResult.firstChangedLine,
    ...(diagnostics ? { diagnostics } : {}),
  }
}
