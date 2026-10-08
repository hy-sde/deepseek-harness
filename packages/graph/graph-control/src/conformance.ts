/**
 * Executable conformance checks for the supervisor-wake scheduling contract
 * (`dueAt` round-trip and exactly-once re-scheduling). The checks are
 * vitest-free so tests and host wiring can run them against any structural
 * {@link ScheduleWakeConformanceStore}; `GraphControlStore` satisfies the
 * seam, and a misbehaving substitute proves a violated clause is reported
 * instead of passing silently.
 * @module
 */

import type {
  AgentGraphControlSnapshot,
  AgentGraphSupervisorWakeRecord,
  ScheduleAgentGraphSupervisorWakeRequest,
} from './types.ts'

/**
 * Structural seam the scheduling checks run against (the control store
 * satisfies it).
 */
export interface ScheduleWakeConformanceStore {
  scheduleSupervisorWake(request: ScheduleAgentGraphSupervisorWakeRequest): Promise<{
    wake: AgentGraphSupervisorWakeRecord
    created: boolean
  }>
  readSupervisorWake(graphId: string, wakeId: string): Promise<AgentGraphSupervisorWakeRecord | undefined>
  snapshot(): Promise<AgentGraphControlSnapshot>
}

/** Checks run by {@link graphControlStoreConformanceChecks}. */
export type GraphControlConformanceCheck = 'schedule-round-trip' | 'schedule-replay-idempotent'

/** One check outcome; `ok: false` carries the violated clauses in `detail`. */
export interface GraphControlConformanceCheckResult {
  readonly check: GraphControlConformanceCheck
  readonly ok: boolean
  /** Semicolon-joined violated clauses; present only when the check failed. */
  readonly detail?: string
}

const CONFORMANCE_GRAPH = 'graph_conformance'
const CONFORMANCE_ROOT = 'graph_conformance_root'
const ROUND_TRIP_WAKE = 'graph_wake_conformance_round_trip'
const ONE_SHOT_WAKE = 'graph_wake_conformance_one_shot'
const REPLAY_WAKE = 'graph_wake_conformance_replay'
const DUE_AT = 5_000
const RECUR_MS = 60_000

/**
 * Run the scheduling conformance checks against one store and report every
 * violated clause. An empty failure list means the store conforms; the checks
 * use dedicated ids, so the store may hold unrelated rows.
 * @param store - the store under check (fresh or pre-populated).
 * @returns one result per check, in run order.
 */
export async function graphControlStoreConformanceChecks(
  store: ScheduleWakeConformanceStore,
): Promise<GraphControlConformanceCheckResult[]> {
  return [await checkScheduleRoundTrip(store), await checkScheduleReplayIdempotent(store)]
}

/** Every field a scheduled row must keep verbatim across a read or a replay. */
function sameWakeRow(left: AgentGraphSupervisorWakeRecord, right: AgentGraphSupervisorWakeRecord): boolean {
  return (
    left.wakeId === right.wakeId &&
    left.graphId === right.graphId &&
    left.snapshotVersion === right.snapshotVersion &&
    left.rootSessionId === right.rootSessionId &&
    left.status === right.status &&
    left.attemptCount === right.attemptCount &&
    left.dueAt === right.dueAt &&
    left.recurMs === right.recurMs &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  )
}

function result(check: GraphControlConformanceCheck, problems: readonly string[]): GraphControlConformanceCheckResult {
  return problems.length === 0
    ? { check, ok: true }
    : { check, ok: false, detail: problems.join('; ') }
}

/** Schedule with `dueAt` + `recurMs` and observe the row through read and snapshot. */
async function checkScheduleRoundTrip(store: ScheduleWakeConformanceStore): Promise<GraphControlConformanceCheckResult> {
  const problems: string[] = []
  const request: ScheduleAgentGraphSupervisorWakeRequest = {
    graphId: CONFORMANCE_GRAPH,
    wakeId: ROUND_TRIP_WAKE,
    snapshotVersion: 'conformance',
    rootSessionId: CONFORMANCE_ROOT,
    dueAt: DUE_AT,
    recurMs: RECUR_MS,
  }
  const { wake, created } = await store.scheduleSupervisorWake(request)
  if (!created) problems.push('the first schedule must create the row')
  if (wake.dueAt !== DUE_AT) problems.push(`dueAt must round-trip as ${DUE_AT}`)
  if (wake.recurMs !== RECUR_MS) problems.push(`recurMs must round-trip as ${RECUR_MS}`)
  const read = await store.readSupervisorWake(request.graphId, request.wakeId)
  if (read === undefined || !sameWakeRow(read, wake)) {
    problems.push('readSupervisorWake must return the scheduled row unchanged')
  }
  const snapshot = await store.snapshot()
  const snapshotted = snapshot.supervisorWakes.find(wake => wake.wakeId === request.wakeId)
  if (snapshotted === undefined || !sameWakeRow(snapshotted, wake)) {
    problems.push('snapshot() must include the scheduled row with dueAt/recurMs')
  }
  // A scheduled wake without recurrence is a one-shot: recurMs stays absent.
  const oneShot = await store.scheduleSupervisorWake({
    graphId: CONFORMANCE_GRAPH,
    wakeId: ONE_SHOT_WAKE,
    snapshotVersion: 'conformance',
    rootSessionId: CONFORMANCE_ROOT,
    dueAt: DUE_AT,
  })
  if (oneShot.created && oneShot.wake.recurMs !== undefined) {
    problems.push('a schedule without recurMs must persist no recurrence')
  }
  return result('schedule-round-trip', problems)
}

/** Re-scheduling the same wakeId is exactly-once: `created: false`, row untouched. */
async function checkScheduleReplayIdempotent(
  store: ScheduleWakeConformanceStore,
): Promise<GraphControlConformanceCheckResult> {
  const problems: string[] = []
  const request: ScheduleAgentGraphSupervisorWakeRequest = {
    graphId: CONFORMANCE_GRAPH,
    wakeId: REPLAY_WAKE,
    snapshotVersion: 'conformance',
    rootSessionId: CONFORMANCE_ROOT,
    dueAt: DUE_AT,
    recurMs: RECUR_MS,
  }
  const first = await store.scheduleSupervisorWake(request)
  const replay = await store.scheduleSupervisorWake(request)
  if (replay.created) problems.push('re-scheduling the same wakeId must return created: false')
  if (!sameWakeRow(replay.wake, first.wake)) {
    problems.push('re-scheduling the same wakeId must return the row unchanged')
  }
  const rescheduled = await store.scheduleSupervisorWake({ ...request, dueAt: DUE_AT + 1 })
  if (rescheduled.created || !sameWakeRow(rescheduled.wake, first.wake)) {
    problems.push('re-scheduling with a different dueAt must not rewrite the row')
  }
  return result('schedule-replay-idempotent', problems)
}
