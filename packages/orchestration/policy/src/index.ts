/**
 * Parallelize-by-default orchestration policy (P1 of the firstmate port).
 *
 * The policy layer is three parts, matching `firstmate-policy-scope.md` §1:
 * 1. **Policy text** — the `orchestration:policy` system-prompt section,
 *    rendered from the same config that drives the guards, so text and
 *    enforcement can't drift.
 * 2. **Config knobs** — the plugin's `cordis.yml` config row (schema-defaulted
 *    below; every knob is optional). The whole policy is INERT unless
 *    `enabled: true`: default OFF keeps today's model-discretion behavior
 *    byte-stable until a deployment opts in.
 * 3. **Seam guard** — the optional `ctx.orchestrationPolicy` service. Absent
 *    service = no guard (tool-subagent checks it with `ctx.get`, not inject,
 *    so mounting this plugin is the ONLY thing that arms enforcement). A
 *    task child started without an isolated `workspace` under
 *    `isolation: required` is rejected with an actionable fix message
 *    (fail-closed); a provider that cannot honor `workspace` degrades to a
 *    REPORTED warning, never a silent ignore.
 *
 * Precedence is fixed (firstmate precedence): explicit captain instruction in
 * the moment > configured rule > configured default > built-in default.
 * Malformed configuration is an actionable error, never a silent fallback.
 * @module @deepseek-ai/dsh-orchestration-policy
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'

/** The ONLY accepted reasons to serialize instead of fanning out. */
export const SERIALIZE_REASONS = [
  'same-file-edit',
  'semantic-dependency',
  'shared-mutable-state',
  'incompatible-concurrency',
] as const

export type SerializeReason = typeof SERIALIZE_REASONS[number]

/** Plugin configuration (all optional; defaults in {@link DEFAULT_POLICY_CONFIG}). */
export interface OrchestrationPolicyConfig {
  /** Master switch. The guard and prompt text are inert until true (default false). */
  enabled?: boolean
  /** Default posture for work that decomposes (default `parallel`). */
  defaultMode?: 'parallel' | 'serial'
  /** Ceiling on one fan-out wave; beyond it the remainder is a follow-up wave (default 6). */
  maxFanOut?: number
  /** `required` = fail-closed isolation; `suggested` = prompt-only (default `required`). */
  isolation?: 'required' | 'suggested'
  /** Whether the seam guard enforces isolation when `isolation: required` (default true). */
  enforceWorkspace?: boolean
  /** Accepted serialize reasons; anything else is rejected at load (default: all four). */
  serializeReasons?: SerializeReason[]
  /** Show the captain one plan summary before a wave is dispatched (default true). */
  announcePlan?: boolean
}

/** Fully-resolved config (every knob present). */
export interface ResolvedPolicyConfig {
  enabled: boolean
  defaultMode: 'parallel' | 'serial'
  maxFanOut: number
  isolation: 'required' | 'suggested'
  enforceWorkspace: boolean
  serializeReasons: SerializeReason[]
  announcePlan: boolean
}

export const DEFAULT_POLICY_CONFIG: ResolvedPolicyConfig = {
  enabled: false,
  defaultMode: 'parallel',
  maxFanOut: 6,
  isolation: 'required',
  enforceWorkspace: true,
  serializeReasons: [...SERIALIZE_REASONS],
  announcePlan: true,
}

/** Validate + resolve partial config; malformed input throws an actionable error. */
export function resolvePolicyConfig(config: OrchestrationPolicyConfig = {}): ResolvedPolicyConfig {
  if (config.maxFanOut !== undefined && (!Number.isInteger(config.maxFanOut) || config.maxFanOut < 1)) {
    throw new Error(
      `orchestration-policy: \`maxFanOut\` must be a positive integer (got ${JSON.stringify(config.maxFanOut)})`,
    )
  }
  const ISOLATION_MODES = ['required', 'suggested'] as const
  if (config.isolation !== undefined && !ISOLATION_MODES.includes(config.isolation)) {
    throw new Error(
      `orchestration-policy: \`isolation\` must be 'required' or 'suggested' (got ${JSON.stringify(config.isolation)})`,
    )
  }
  if (config.serializeReasons !== undefined) {
    const unknown = config.serializeReasons.filter(reason => !SERIALIZE_REASONS.includes(reason))
    if (unknown.length > 0) {
      throw new Error(
        `orchestration-policy: unknown serialize reason(s) ${JSON.stringify(unknown)} — accept only `
        + SERIALIZE_REASONS.join(', '),
      )
    }
  }
  return { ...DEFAULT_POLICY_CONFIG, ...config }
}

/** A policy rejection: the fail-closed start that violates `isolation: required`. */
export class OrchestrationPolicyError extends Error {
  override readonly name = 'OrchestrationPolicyError' as const
}

/** The optional seam service tool-subagent reads via `ctx.get('orchestrationPolicy')`. */
export class OrchestrationPolicyService extends Service {
  public readonly config: ResolvedPolicyConfig

  constructor(ctx: Context, config: OrchestrationPolicyConfig = {}) {
    super(ctx, 'orchestrationPolicy')
    this.config = resolvePolicyConfig(config)
  }

  /**
   * Fail-closed isolation check for one delegation start.
   * @param workspace - the start's requested `workspace` (undefined = none).
   * @param providerCanIsolate - whether the provider honors `workspace`.
   * @returns a warning string when the provider cannot isolate (REPORTED, not
   *          silent — callers must surface it), `undefined` when allowed.
   * @throws {@link OrchestrationPolicyError} when the start violates the policy.
   */
  assertWorkspace(workspace: string | undefined, providerCanIsolate: boolean): string | undefined {
    if (!this.config.enabled) return undefined
    if (this.config.isolation !== 'required' || !this.config.enforceWorkspace) return undefined
    if (workspace !== undefined) return undefined
    if (!providerCanIsolate) {
      return 'orchestration-policy: task isolation is required but this subagent provider cannot honor `workspace` — configure an in-process provider or set `isolation: suggested`'
    }
    throw new OrchestrationPolicyError(
      'orchestration-policy requires task isolation: pass the isolated working-copy `path` from `worktree acquire` as the `workspace` argument (or set `isolation: suggested` / `enabled: false` to relax)',
    )
  }
}

const SECTION_NAME = 'orchestration:policy'
const SECTION_ORDER = 129

function reasonText(reasons: readonly SerializeReason[]): string {
  const lines = [
    '- same-file-edit: two chunks edit the same file',
    '- semantic-dependency: one change is an input to the next',
    '- shared-mutable-state: lockfiles, migrations, generated code, credentials',
    '- incompatible-concurrency: both rework the same subsystem in conflicting ways',
  ]
  const kept = reasons.map(reason => lines.find(line => line.endsWith(`: ${reason}`)) ?? `- ${reason}`)
  return kept.join('\n')
}

/**
 * Build the orchestration policy prompt section from resolved config.
 * @param config - resolved policy configuration.
 * @returns the {@link PromptSection} to register (empty text when disabled).
 */
export function buildOrchestrationPromptSection(config: ResolvedPolicyConfig = DEFAULT_POLICY_CONFIG): PromptSection {
  if (!config.enabled) return { name: SECTION_NAME, order: SECTION_ORDER, text: '' }
  const mode = config.defaultMode === 'parallel'
    ? 'Fan out independent chunks as isolated task children; today\'s serial behavior is the exception.'
    : 'Run work serially unless a chunk is clearly independent — parallel is opt-in.'
  const reasons = reasonText(config.serializeReasons)
  const isolation = config.isolation === 'required'
    ? 'One task = one isolated working copy. A task child MUST be started with `workspace` set to a `worktree acquire` path — the guard rejects a start without one (this is fail-closed, not a preference).'
    : 'Prefer one task = one isolated working copy (`worktree acquire` + `workspace`), but the guard does not enforce it.'
  const plan = config.announcePlan
    ? 'Announce the plan once before dispatch: N isolated tasks, what each owns, expected overlap (rare), who merges. One summary — never per-child chatter in the captain-facing thread.'
    : ''
  const text = [
    '# Orchestration policy (parallelize-by-default)',
    `Goal: same quality, more velocity, less captain cognitive load. ${mode}`,
    '',
    '1. Classify before doing: independent chunks (different files/subsystems, no shared mutable state, no ordering) or one unit of work.',
    `2. Serialize ONLY for a true dependency — the accepted reasons are:\n${reasons}`,
    '   Same-file edits ALONE are not a reason to serialize: split by intent and merge; a shared-file edit with conflicting intent is `incompatible-concurrency`.',
    `3. Fan out: per chunk \`worktree acquire --branch <task>\` then \`subagent { workspace: <lease path> }\` — parallel, up to ${config.maxFanOut} per wave; beyond that announce the rest as a follow-up wave.`,
    isolation,
    '4. Steer with `send_message` at the nearest step boundary; `interrupt_agent` cancels; `list_agents` shows the fleet. Collect every child before merging; release each lease after its child settles — never `force` a release without the captain\'s explicit word.',
    plan,
  ].filter(Boolean).join('\n')
  return { name: SECTION_NAME, order: SECTION_ORDER, text }
}

/** Cordis plugin name for loader diagnostics. */
export const name = 'orchestration-policy'

/** Services consumed by this plugin (systemPrompt from the host bundle). */
export const inject = ['systemPrompt']

/**
 * Mount the policy: register the service and the prompt section.
 * @param ctx - agent-plane plugin context (injects `systemPrompt`).
 * @param config - plugin configuration (see {@link OrchestrationPolicyConfig}).
 */
export function apply(ctx: Context, config: OrchestrationPolicyConfig = {}): void {
  // Resolve eagerly so malformed config fails at LOAD, not at first start.
  const resolved = resolvePolicyConfig(config)
  new OrchestrationPolicyService(ctx, config)
  ctx.systemPrompt.section(buildOrchestrationPromptSection(resolved))
}

export default { name, inject, apply }
