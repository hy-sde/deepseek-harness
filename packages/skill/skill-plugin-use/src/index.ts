/**
 * Composition-declared plugin-advice skill provider.
 *
 * One advice skill per configured plugin: the `/name` gesture and the `skill`
 * tool load a body that advises the model to prefer that plugin's mounted
 * tools for the current response. Bodies are inline configuration text or a
 * markdown file; declared tool names render as a trailing tool-map line.
 *
 * @module @deepseek-ai/dsh-skill-plugin-use
 */

import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  BUNDLED_SKILL_RANK,
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillLookupOptions,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'

/** Source label for composition-declared advice skills; prompt-visible metadata. */
const ADVICE_SOURCE = 'composition'

const DEFAULT_PROVIDER_NAME = 'plugin-use'

/** One composition-declared plugin advice. */
export interface PluginAdvice {
  /** Kebab-case skill name; the same token is the `/name` gesture. */
  readonly name: string
  /** Short routing description shown by discovery consumers. */
  readonly description: string
  /** Optional extra routing guidance passed through to the catalog. */
  readonly whenToUse?: string
  /** Inline advice body. Exactly one of `instructions` and `instructionsFile` is required. */
  readonly instructions?: string
  /**
   * Markdown advice body path. Absolute or `~`-expanded paths load as-is;
   * relative paths resolve against `Config.baseDir`.
   */
  readonly instructionsFile?: string
  /** Tool names the plugin contributes; rendered as a trailing tool-map line. */
  tools?: string[]
  /** Whether model-facing catalogs and the `skill` tool include this advice. Defaults to true. */
  readonly modelInvocable?: boolean
}

/** Plugin-advice provider configuration. */
export interface Config {
  /** Unique provider name. Defaults to `plugin-use`. */
  providerName?: string
  /** Base directory for relative `instructionsFile` paths. Defaults to the process cwd. */
  baseDir?: string
  /** One advice per plugin; an empty list publishes nothing. */
  plugins?: PluginAdvice[]
}

/** Validated plugin-advice configuration. */
export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  baseDir: z.string().required(false),
  plugins: z.array(z.object({
    name: z.string().required(),
    description: z.string().min(1).required(),
    whenToUse: z.string().required(false),
    instructions: z.string().required(false),
    instructionsFile: z.string().required(false),
    tools: z.array(z.string()).required(false),
    modelInvocable: z.boolean().required(false),
  })).required(false),
})

type AdviceLocator =
  | { readonly kind: 'inline'; readonly body: string; readonly tools: readonly string[] }
  | { readonly kind: 'file'; readonly file: string; readonly tools: readonly string[] }

interface ValidatedAdvice {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
  readonly locator: AdviceLocator
}

/** Cordis plugin name. */
export const name = 'skill-plugin-use'
/** Service required by the advice provider. */
export const inject = ['skills']

/**
 * Register the plugin-advice provider on `ctx.skills`. Entry validation runs
 * at mount: an invalid name, a duplicate name, or an advice without exactly
 * one body source fails the composition load, while a configured file that is
 * missing at discovery is omitted like any other absent skill source.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const providerName = config.providerName ?? DEFAULT_PROVIDER_NAME
  const baseDir = config.baseDir !== undefined ? resolve(expandTilde(config.baseDir)) : process.cwd()
  const advices = validateAdvices(config.plugins ?? [], baseDir)
  ctx.skills.registerProvider(() => new PluginAdviceProvider(providerName, advices))
}

/** Provider that publishes configured plugin advices into `ctx.skills`. */
export class PluginAdviceProvider implements SkillProvider {
  readonly name: string

  constructor(
    name: string,
    private readonly advices: readonly ValidatedAdvice[],
  ) {
    this.name = name
  }

  /**
   * Publish one candidate per configured advice, omitting file-backed bodies
   * whose file is currently absent.
   * @returns the configured candidates; discovery is always complete.
   */
  async list(): Promise<SkillCandidate[]> {
    const candidates: SkillCandidate[] = []
    for (const advice of this.advices) {
      const candidate = await this.candidate(advice)
      if (candidate !== undefined) candidates.push(candidate)
    }
    return candidates
  }

  /**
   * Load the advice body, re-reading file-backed bodies on every call.
   * @param candidate - the winning candidate originally returned by this provider.
   * @param options - lookup options whose signal cancels file reads.
   * @returns the complete advice, or `undefined` when a file-backed body is no longer loadable.
   */
  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const locator = candidate.locator as AdviceLocator
    const body = locator.kind === 'inline'
      ? locator.body
      : await readAdviceFile(locator.file, options.signal)
    if (body === undefined) return undefined
    return {
      name: candidate.name,
      description: candidate.description,
      ...candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {},
      invocation: candidate.invocation,
      provider: this.name,
      source: candidate.source,
      ...(locator.kind === 'file'
        ? { path: locator.file, resourceBase: { kind: 'directory', path: dirname(locator.file) } }
        : {}),
      content: renderAdviceBody(body, locator.tools),
    }
  }

  private async candidate(advice: ValidatedAdvice): Promise<SkillCandidate | undefined> {
    const base = {
      name: advice.name,
      description: advice.description,
      ...advice.whenToUse !== undefined ? { whenToUse: advice.whenToUse } : {},
      invocation: { modelInvocable: advice.modelInvocable, userInvocable: true },
      provider: this.name,
      source: ADVICE_SOURCE,
      rank: BUNDLED_SKILL_RANK,
    }
    if (advice.locator.kind === 'inline') return { ...base, locator: advice.locator }
    const file = await this.existingFile(advice.locator.file)
    if (file === undefined) return undefined
    return {
      ...base,
      path: file,
      resourceBase: { kind: 'directory', path: dirname(file) },
      locator: { ...advice.locator, file },
    }
  }

  private async existingFile(path: string): Promise<string | undefined> {
    try {
      return await realpath(path)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error
      return undefined
    }
  }
}

/**
 * Validate and freeze configuration entries at mount. A missing
 * `instructionsFile` is deliberately not an error here: discovery omits the
 * entry, matching absent-skill behavior for file sources.
 * @param plugins - raw configuration entries.
 * @param baseDir - base directory for relative file paths.
 * @returns validated entries with resolved absolute file paths.
 */
function validateAdvices(plugins: readonly PluginAdvice[], baseDir: string): ValidatedAdvice[] {
  const advices: ValidatedAdvice[] = []
  const seen = new Set<string>()
  for (const [index, plugin] of plugins.entries()) {
    const label = typeof plugin.name === 'string' && plugin.name.length > 0
      ? `"${plugin.name}"`
      : `#${index}`
    if (!isSkillName(plugin.name)) {
      throw new TypeError(`skill-plugin-use: advice ${label} requires a kebab-case name`)
    }
    if (seen.has(plugin.name)) {
      throw new TypeError(`skill-plugin-use: duplicate advice name ${label}`)
    }
    if (typeof plugin.description !== 'string' || plugin.description.length === 0) {
      throw new TypeError(`skill-plugin-use: advice ${label} requires a description`)
    }
    if (plugin.instructions !== undefined && plugin.instructionsFile !== undefined) {
      throw new TypeError(`skill-plugin-use: advice ${label} requires exactly one of instructions or instructionsFile`)
    }
    const tools = plugin.tools ?? []
    for (const tool of tools) {
      if (typeof tool !== 'string' || tool.length === 0) {
        throw new TypeError(`skill-plugin-use: advice ${label} tools must be non-empty strings`)
      }
    }
    let locator: AdviceLocator
    if (plugin.instructions !== undefined) {
      locator = { kind: 'inline', body: plugin.instructions.trim(), tools }
    } else {
      const file = plugin.instructionsFile
      if (file === undefined) {
        throw new TypeError(`skill-plugin-use: advice ${label} requires exactly one of instructions or instructionsFile`)
      }
      locator = { kind: 'file', file: resolveAdviceFile(file, baseDir), tools }
    }
    seen.add(plugin.name)
    advices.push({
      name: plugin.name,
      description: plugin.description,
      ...(plugin.whenToUse !== undefined ? { whenToUse: plugin.whenToUse } : {}),
      modelInvocable: plugin.modelInvocable ?? true,
      locator,
    })
  }
  return advices
}

/**
 * Render the model-facing advice body: the configured body verbatim plus a
 * trailing tool-map line when tools are declared.
 * @param body - trimmed advice body.
 * @param tools - declared tool names; empty renders nothing.
 * @returns the complete advice body.
 */
function renderAdviceBody(body: string, tools: readonly string[]): string {
  if (tools.length === 0) return body
  return `${body}\n\nPlugin-provided tools: ${tools.map(tool => `\`${tool}\``).join(', ')}.`
}

/**
 * Resolve a configured advice file path: tilde-expanded, then absolute, then
 * baseDir-relative.
 * @param path - configured path.
 * @param baseDir - base directory for relative paths.
 * @returns the resolved path.
 */
export function resolveAdviceFile(path: string, baseDir: string): string {
  const expanded = expandTilde(path)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded)
}

function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

async function readAdviceFile(path: string, signal: AbortSignal | undefined): Promise<string | undefined> {
  try {
    const file = await realpath(path)
    return await readFile(file, { encoding: 'utf8', signal })
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    throw error
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
