/**
 * Durable open-decisions ledger: the `subagent/decision` session event and the
 * fold that reconstructs a parent's open records from its event log.
 *
 * The keyed open-decisions ledger survives host restarts by writing each
 * mutation as a log-only event on the PARENT session. A decision has two
 * mutations: `open` (child reports `needs-decision`/`blocked` with a key — or
 * the wedge supervisor raises one on a stalled child's behalf) and `resolve`
 * (the parent answers the key). Re-opening the same key refreshes the record
 * (the later `open` wins); a matching `resolve` closes it. Rehydration folds a
 * parent session's `subagent/decision` events in seq order, so a restarted
 * host reconstructs exactly the ledger the reports describe.
 *
 * Log-only by construction: the event carries no `surfaceOp` and never enters
 * model history. It is informational about work the transcript already
 * records, so a reader without this type can skip it safely.
 *
 * @module @deepseek-ai/dsh-subagent/decisions
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { DecisionStatus, OpenDecision } from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One durable mutation of the keyed open-decisions ledger, appended to the
     * PARENT session by the owning subagent runtime (and its wedge supervisor).
     * `open` records or refreshes an unanswered decision; `resolve` closes it.
     * Log-only: no `surfaceOp`, never part of derived model history.
     */
    'subagent/decision': SubagentDecisionEventData
  }
}

/** One durable ledger mutation (`open` or `resolve`). */
export interface SubagentDecisionEventData {
  /** `open` records/refreshes a decision; `resolve` closes it. */
  readonly phase: 'open' | 'resolve'
  /** The reporting (or stalled) child's durable session id. */
  readonly childId: string
  /** The normalized decision key (unique within the child). */
  readonly key: string
  /** Decision status; present on `open`. */
  readonly status?: DecisionStatus
  /** Actionable summary; present on `open`. */
  readonly summary?: string
  /** Child label naming the decision; present on `open`. */
  readonly label?: string
  /** Set on `open` when wedge supervision raised the decision. */
  readonly wedge?: true
  /**
   * Epoch milliseconds when the decision opened. Re-opens keep the event's
   * own time (`event.time`), so refresh does not rewrite the original `open`.
   */
  readonly openedAt: number
}

/**
 * Whether one session event is a durable decision mutation.
 * @param event - the session event to test.
 * @returns true when the event is a decision mutation.
 */
export function isSubagentDecisionEvent(
  event: SessionEvent,
): event is SessionEvent<'subagent/decision'> {
  return event.type === 'subagent/decision'
}

/**
 * Fold a parent session's durable decision events into its current open set,
 * applying `open`/`resolve` in seq order. A later `open` for the same
 * `childId`+`key` refreshes (last wins); a `resolve` deletes.
 * @param events - the parent session's event log (stored order).
 * @returns the folded open records keyed `childId\0key`.
 */
export function foldSubagentDecisions(
  events: readonly SessionEvent[],
): Map<string, OpenDecision> {
  const ledger = new Map<string, OpenDecision>()
  for (const event of events) {
    if (!isSubagentDecisionEvent(event)) continue
    const { phase, childId, key } = event.data
    if (phase === 'resolve') {
      ledger.delete(`${childId}\u0000${key}`)
      continue
    }
    if (typeof childId !== 'string' || typeof key !== 'string' || key.length === 0) {
      throw new Error('persisted subagent decision "open" event needs a string childId and non-empty key')
    }
    const { status, summary, label } = event.data
    if (status !== 'needs-decision' && status !== 'blocked') {
      throw new Error('persisted subagent decision "open" event has an unsupported status')
    }
    if (typeof summary !== 'string' || summary.trim().length === 0) {
      throw new Error('persisted subagent decision "open" event needs a non-empty summary')
    }
    ledger.set(`${childId}\u0000${key}`, {
      childId: childId as never,
      key,
      label: typeof label === 'string' && label.length > 0 ? label : 'subagent',
      status,
      summary,
      openedAt: event.data.openedAt ?? event.time,
      ...event.data.wedge === true ? { wedge: true as const } : {},
    })
  }
  return ledger
}
