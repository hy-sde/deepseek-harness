/**
 * Wedge supervision for continuable subagents: decide when a resident child
 * has stopped making progress and should be surfaced to its parent as a keyed
 * decision, and diagnose stale unanswered decisions.
 *
 * A child is "wedged" when it is still resident and `running`, but produced no
 * activity — no session appends, no inbox/status transitions, and no active
 * `llm/stream` call — for longer than the stale threshold. The active-stream
 * test is load-bearing: long prefills and long thinking produce no interim
 * events for many minutes, so a child inside a live model call is never
 * flagged. Supervision never kills: it raises a `wedge:<childId>` decision
 * through the same keyed protocol, and the parent closes it exactly once
 * (acknowledge, interrupt, or park).
 *
 * Pure functions over detached probe snapshots; the service owns the timers,
 * the probes, and the ledger writes.
 *
 * @module @deepseek-ai/dsh-subagent/supervision
 */

/** Thresholds and switches for one supervision pass. */
export interface SupervisionConfig {
  /** No-progress threshold before a resident running child is flagable (ms). */
  readonly wedgeStaleMs: number
  /**
   * After a wedge decision for a child is resolved, suppress re-raising it
   * until this many ms pass with still no progress (ms).
   */
  readonly wedgeCoolDownMs: number
  /** Re-notify the parent about an unanswered decision once it is this old (ms). */
  readonly staleDecisionNotifyMs: number
  /** Minimum interval between stale-decision re-notifications (ms). */
  readonly staleDecisionReNotifyMs: number
}

/** Detached per-child liveness facts the supervisor may judge wedged. */
export interface WedgeProbe {
  /** Durable child session id. */
  readonly childId: string
  /** The child's durable direct parent session id. */
  readonly parentSession: string
  /** Child label (preset name) for the decision text. */
  readonly label: string
  /** Last observed progress (epoch ms); `0` = no observation yet. */
  readonly lastProgress: number
  /** Whether the child is inside a live `llm/stream` call right now. */
  readonly activeStream: boolean
  /** Whether the child's agent is currently `running` (has work in flight). */
  readonly running: boolean
  /** Whether this child currently has a raised wedge decision outstanding. */
  readonly wedgeOutstanding: boolean
  /** Epoch ms when the parent last resolved this child's wedge decision. */
  readonly wedgeResolvedAt?: number
}

/** The result of judging one probe. */
export type WedgeVerdict =
  | { readonly kind: 'clean' }
  | { readonly kind: 'stale'; readonly idleForMs: number }

/**
 * Judge one child probe against the stale threshold.
 * @param probe - the detached per-child liveness snapshot.
 * @param now - the supervision tick's `Date.now()`.
 * @param config - the supervision thresholds.
 * @returns `stale` when the child is running, has no active stream, and has
 *   been quiet longer than {@link SupervisionConfig.wedgeStaleMs}.
 */
export function diagnoseWedge(
  probe: WedgeProbe,
  now: number,
  config: SupervisionConfig,
): WedgeVerdict {
  if (!probe.running || probe.activeStream) return { kind: 'clean' }
  const idleForMs = probe.lastProgress > 0 ? now - probe.lastProgress : now
  if (idleForMs >= config.wedgeStaleMs) return { kind: 'stale', idleForMs }
  return { kind: 'clean' }
}

/** A decision key the supervisor generates for one stalled child. */
export function wedgeDecisionKey(childId: string): string {
  return `wedge:${childId}`
}

/** Whether one key is a supervisor-raised wedge decision for `childId`. */
export function isWedgeDecisionKey(key: string, childId?: string): boolean {
  if (!key.startsWith('wedge:')) return false
  if (childId === undefined) return true
  return key === wedgeDecisionKey(childId)
}

/** The status wedge decisions are recorded with. */
export const WEDGE_DECISION_STATUS = 'blocked' as const

/**
 * The parent-facing summary for one raised wedge decision.
 * @param probe - the stalled child's probe.
 * @param idleForMs - how long the child has been quiet.
 * @param slots - optional host model-slot snapshot for admission awareness.
 * @returns the `summary` recorded on the wedge decision.
 */
export function wedgeDecisionSummary(
  probe: WedgeProbe,
  idleForMs: number,
  slots?: { running: number; waiting: number; capacity: number } | undefined,
): string {
  const since = new Date(probe.lastProgress > 0 ? probe.lastProgress : Date.now()).toISOString()
  const slotLine = slots === undefined
    ? ''
    : ` Host model slots: ${slots.running}/${slots.capacity} running, ${slots.waiting} waiting.`
  return `Subagent ${probe.childId} (${probe.label}) made no progress for ${Math.round(idleForMs / 1000)}s`
    + ` (last activity ${since}) and holds no active model call; it may be stuck in a tool or a dead loop.`
    + slotLine + ' Answer this decision to acknowledge it, or interrupt the child to stop it.'
}
