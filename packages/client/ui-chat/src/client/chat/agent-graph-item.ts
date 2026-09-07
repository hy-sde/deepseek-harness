/**
 * Display derivation for the `graph` projection chip: the bounded summary
 * (work count · status) or null while the chip must render nothing — no
 * projection, not-yet-available `null`, or a quiet closed graph with an empty
 * rail. Kept free of React and locale so the visibility rule is testable
 * without rendering machinery.
 */
import type { SessionGraphProjection } from '@deepseek-ai/dsh-graph-projection/types'

export interface AgentGraphItemData {
  /** Bounded work items on the graph rail. */
  readonly count: number
  /** Closed/open summary derived by the host. */
  readonly status: SessionGraphProjection['status']
}

/**
 * Derive the chip display data from one session's `graph` projection.
 * @param projection - the `graph` projection value: undefined when the
 *   capability is absent, null before the first publish, or the snapshot.
 * @returns the summary data, or null while the projection is absent or quiet.
 */
export function agentGraphItemFor(projection: SessionGraphProjection | null | undefined): AgentGraphItemData | null {
  if (projection === null || projection === undefined) return null
  if (projection.work.length === 0 && projection.status !== 'active') return null
  return { count: projection.work.length, status: projection.status }
}
