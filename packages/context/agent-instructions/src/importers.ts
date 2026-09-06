/**
 * Foreign-format instruction importers (port of oh-my-pi discovery G5).
 *
 * The harness's native instruction chain loads `AGENTS.md`/`CLAUDE.md` (plus
 * `.local` overlays) from every ancestor directory of the session cwd. Teams
 * that standardize on another agent's rule formats keep their rules in:
 *   - Cursor:  `.cursor/rules/*.mdc`   (MDC: frontmatter `description`/`globs`/`alwaysApply`)
 *   - Cline:   `.clinerules`           (single file) or `.clinerules/*.md`
 *   - Copilot: `.github/copilot-instructions.md`
 *              `.github/instructions/*.instructions.md`  (frontmatter `applyTo`)
 *
 * This module discovers those files per ancestor directory and renders them
 * into the AGENTS.md-compatible chain under distinct root-relative display
 * paths, so the existing per-directory dedup, byte budget, scope keys, and
 * session reconciliation all work unchanged.
 *
 * Fidelity note: upstream stores each format's frontmatter fields (`globs`,
 * `applyTo`, `alwaysApply`) as structured rule metadata. The fork renders the
 * body plus a single scope annotation line so applicability survives into the
 * model-facing chain without a separate rule schema. Upstream also lets rule
 * authors turn a rule off with `enabled: false` frontmatter (oh-my-pi
 * `f250bbf3e3`); the fork mirrors that: such foreign files are discovered
 * but omitted from the chain (see {@link isForeignRuleDisabled}).
 *
 * @module @deepseek-ai/dsh-agent-instructions/importers
 */

import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'

/** One discovered foreign-format instruction file before content is read. */
export interface ForeignRuleFile {
  /** Absolute path of the foreign rule file. */
  absolutePath: string
  /** Project-root-relative display path (the scope-key source of truth). */
  displayPath: string
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

type PathKind = 'file' | 'dir' | 'absent' | 'unavailable'

async function statPath(path: string, fileSystem?: FileSystem, signal?: AbortSignal): Promise<PathKind> {
  if (fileSystem === undefined) {
    try {
      signal?.throwIfAborted()
      const info = await stat(path)
      signal?.throwIfAborted()
      if (info.isFile()) return 'file'
      if (info.isDirectory()) return 'dir'
      return 'absent'
    } catch (error: unknown) {
      signal?.throwIfAborted()
      return isMissingPathError(error) ? 'absent' : 'unavailable'
    }
  }
  try {
    const target = await fileSystem.resolve(path, signal === undefined ? undefined : { signal })
    const info = await fileSystem.stat(target, signal)
    signal?.throwIfAborted()
    if (info?.type === 'file') return 'file'
    if (info?.type === 'directory') return 'dir'
    return 'absent'
  } catch (error) {
    signal?.throwIfAborted()
    return isMissingPathError(error) ? 'absent' : 'unavailable'
  }
}

async function listDirNames(
  dir: string,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  if (fileSystem === undefined) {
    try {
      signal?.throwIfAborted()
      const entries = await readdir(dir)
      signal?.throwIfAborted()
      return entries
    } catch {
      signal?.throwIfAborted()
      return undefined
    }
  }
  try {
    const target = await fileSystem.resolve(dir, signal === undefined ? undefined : { signal })
    const entries = await fileSystem.listDir(target, signal)
    signal?.throwIfAborted()
    return entries.map(entry => entry.name)
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
}

/**
 * Discover every foreign-format instruction file inside one directory.
 * Directory-formats scan their named subdirectory (`.cursor/rules/`,
 * `.clinerules/`, `.github/instructions/`) non-recursively; the two single-file
 * formats (`copilot-instructions.md`, a file named exactly `.clinerules`) are
 * probed directly. Called once per ancestor directory.
 * @param dir - ancestor directory to scan.
 * @param root - project root used for root-relative display paths.
 * @param fileSystem - optional provider used instead of host scans.
 * @param signal - cancellation for provider and host probes.
 * @returns discovered foreign files, or `[]` when the directory has none.
 */
export async function discoverForeignRuleFiles(
  dir: string,
  root: string,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<ForeignRuleFile[]> {
  const found: ForeignRuleFile[] = []
  const add = (absolutePath: string): void => {
    found.push({ absolutePath, displayPath: relative(root, absolutePath) })
  }

  // Cursor: `.cursor/rules/*.mdc`
  const cursorList = await listDirNames(join(dir, '.cursor', 'rules'), fileSystem, signal)
  if (cursorList !== undefined) {
    for (const name of cursorList) {
      if (name.toLowerCase().endsWith('.mdc')) add(join(dir, '.cursor', 'rules', name))
    }
  }

  // Cline: `.clinerules` (file) or `.clinerules/*.md` (directory)
  const clinerulesKind = await statPath(join(dir, '.clinerules'), fileSystem, signal)
  if (clinerulesKind === 'file') {
    add(join(dir, '.clinerules'))
  } else if (clinerulesKind === 'dir') {
    const clineList = await listDirNames(join(dir, '.clinerules'), fileSystem, signal)
    if (clineList !== undefined) {
      for (const name of clineList) {
        if (name.toLowerCase().endsWith('.md')) add(join(dir, '.clinerules', name))
      }
    }
  }

  // Copilot: `.github/copilot-instructions.md` + `.github/instructions/*.instructions.md`
  if ((await statPath(join(dir, '.github', 'copilot-instructions.md'), fileSystem, signal)) === 'file') {
    add(join(dir, '.github', 'copilot-instructions.md'))
  }
  const copilotList = await listDirNames(join(dir, '.github', 'instructions'), fileSystem, signal)
  if (copilotList !== undefined) {
    for (const name of copilotList) {
      if (name.toLowerCase().endsWith('.instructions.md')) add(join(dir, '.github', 'instructions', name))
    }
  }

  return found
}

/**
 * Normalize one foreign-format file's raw content into chain-ready markdown.
 * Strips leading YAML frontmatter and prepends a one-line annotation carrying
 * the format's applicability field (`globs`, `applyTo`, or `alwaysApply`) so
 * scope survives into the rendered chain without a rule schema. Non-foreign
 * files pass through unchanged (identity), and the SAME function applies in
 * baseline discovery and session reconciliation so content digests align.
 * @param displayPath - project-relative path used to select the format.
 * @param content - raw file bytes decoded as UTF-8.
 * @returns normalized markdown for the chain.
 */
export function normalizeForeignContent(displayPath: string, content: string): string {
  const lower = displayPath.toLowerCase()
  if (lower.endsWith('.mdc') || lower.endsWith('.instructions.md')) {
    const parsed = parseSimpleFrontmatter(content)
    if (parsed === undefined) return content
    const fields: string[] = []
    if (lower.endsWith('.mdc')) {
      const globs = typeof parsed.frontmatter.globs === 'string' ? parsed.frontmatter.globs : undefined
      if (globs !== undefined && globs.length > 0) fields.push(`applies to: ${globs}`)
      if (parsed.frontmatter.alwaysApply === true) fields.push('always applies')
    } else if (typeof parsed.frontmatter.applyTo === 'string' && parsed.frontmatter.applyTo.length > 0) {
      fields.push(`applies to: ${parsed.frontmatter.applyTo}`)
    }
    const annotation = fields.length > 0 ? `(${fields.join('; ')})` : ''
    const body = parsed.body
    return annotation.length > 0 ? `${annotation}\n\n${body}` : body
  }
  return content
}

/**
 * True when `displayPath` names one of the discovered foreign-format rule
 * files (Cursor `.mdc`, Cline `.clinerules` file-or-dir, Copilot
 * `copilot-instructions.md` / `.instructions.md`). Native chain files
 * (`AGENTS.md`, `CLAUDE.md`, their `.local` overlays) are never foreign, so a
 * `enabled: false` frontmatter there keeps its current semantics.
 */
export function isForeignRuleFile(displayPath: string): boolean {
  const lower = displayPath.toLowerCase()
  return lower.endsWith('.mdc')
    || lower.endsWith('.clinerules')
    || lower.includes('.clinerules/')
    || lower.endsWith('copilot-instructions.md')
    || lower.endsWith('.instructions.md')
}

/**
 * True when a foreign rule file's frontmatter explicitly disables it
 * (`enabled: false`) — oh-my-pi discovery semantics (`f250bbf3e3`): a rule a
 * team turned off must not be inherited into the instruction chain, while the
 * file stays on disk for inspection. Only foreign rule files are considered;
 * every other path returns `false`.
 * @param displayPath - project-relative path of the candidate file.
 * @param content - raw file bytes decoded as UTF-8.
 */
export function isForeignRuleDisabled(displayPath: string, content: string): boolean {
  if (!isForeignRuleFile(displayPath)) return false
  const parsed = parseSimpleFrontmatter(content)
  return parsed !== undefined && parsed.frontmatter.enabled === false
}

/**
 * Strip a leading `---\n...\n---` YAML frontmatter block, returning its fields
 * and the body. Only flat `key: value` lines are parsed (the formats use no
 * nested structures for the fields that matter here); anything else is treated
 * as body text so content is never destroyed.
 * @param raw - the document text to parse.
 * @returns the parsed fields plus body, or undefined when no frontmatter.
 */
export function parseSimpleFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } | undefined {
  if (!raw.startsWith('---')) return undefined
  const newline = raw.indexOf('\n')
  if (newline < 0) return undefined
  const rest = raw.slice(newline + 1)
  const end = rest.indexOf('\n---')
  if (end < 0) return undefined
  const frontmatterText = rest.slice(0, end)
  const body = rest.slice(end + 4).replace(/^\n/, '')
  const frontmatter: Record<string, unknown> = {}
  for (const line of frontmatterText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon < 0) continue
    const key = trimmed.slice(0, colon).trim()
    if (key.length === 0) continue
    let value: unknown = trimmed.slice(colon + 1).trim()
    if (value === 'true') value = true
    else if (value === 'false') value = false
    else if ((String(value).startsWith('"') && String(value).endsWith('"')) || (String(value).startsWith("'") && String(value).endsWith("'"))) {
      value = String(value).slice(1, -1)
    }
    frontmatter[key] = value
  }
  return { frontmatter, body }
}
