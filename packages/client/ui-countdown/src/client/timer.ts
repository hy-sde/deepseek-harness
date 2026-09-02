/**
 * Module-level countdown timer store shared by the side-bar renderings (the
 * wide cell and the collapsed-rail chip). A browser singleton: the timer
 * survives side-bar rail/wide flips and keeps counting from an absolute
 * `endAt` timestamp, so background-tab timer throttling can never skew the
 * remaining time — every read recomputes from `Date.now()`, and completion
 * is marked once regardless of which callback notices it first.
 */

export interface TimerSnapshot {
  /** Whether a countdown is active. */
  running: boolean
  /** Epoch ms at which the active countdown ends; null when idle. */
  endAt: number | null
  /** Configured duration for the next start (the default is 45 minutes). */
  durationMs: number
  /** Epoch ms of the one completion mark, cleared by any (re)start. */
  finishedAt: number | null
}

const ONE_MINUTE = 60_000

/** Clamp a duration to the supported [1s, 24h] range. */
function clampDuration(ms: number): number {
  const value = Number.isFinite(ms) ? Math.floor(ms) : ONE_MINUTE
  if (value < 1000) return 1000
  if (value > 24 * 3600 * ONE_MINUTE) return 24 * 3600 * ONE_MINUTE
  return value
}

/**
 * The shared countdown timer: one absolute-deadline store behind the sidebar
 * renders. Exposes a stable snapshot for `useSyncExternalStore`, a subscribe
 * handle, and duration/start/stop/complete controls.
 */
export class CountdownStore {
  private snapshot: TimerSnapshot = {
    running: false,
    endAt: null,
    durationMs: 45 * ONE_MINUTE,
    finishedAt: null,
  }

  private readonly listeners = new Set<() => void>()

  /** Stable until the next mutation, so `useSyncExternalStore` never loops. */
  getSnapshot = (): TimerSnapshot => this.snapshot

  /** Register a snapshot change listener; returns its unsubscribe handle. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(partial: Partial<TimerSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial }
    for (const listener of this.listeners) listener()
  }

  /**
   * Adopt a new duration for the next start (clamped to the supported range).
   * @param ms - The requested duration in milliseconds.
   */
  setDuration(ms: number): void {
    this.set({ durationMs: clampDuration(ms), finishedAt: null })
  }

  /** Start a countdown from the current duration (a no-op while running starts fresh). */
  start(): void {
    this.set({ running: true, endAt: Date.now() + this.snapshot.durationMs, finishedAt: null })
  }

  /** Reset and immediately start again with the same duration. */
  restart(): void {
    this.start()
  }

  /** Clear the active countdown back to idle. */
  stop(): void {
    this.set({ running: false, endAt: null })
  }

  /**
   * Mark the timer as elapsed. The presentation layer calls this exactly when
   * the deadline passes and then alerts the user; the `finishedAt` guard keeps
   * overlapping callbacks (interval + visibility) from alerting twice.
   */
  complete(): void {
    if (this.snapshot.finishedAt !== null) return
    this.set({ running: false, finishedAt: Date.now() })
  }

  /**
   * Remaining ms for display: the live deadline delta while running, else the
   * configured duration.
   * @returns The remaining milliseconds (or the full duration when idle).
   */
  remainingMs(): number {
    if (!this.snapshot.running || this.snapshot.endAt === null) return this.snapshot.durationMs
    return Math.max(0, this.snapshot.endAt - Date.now())
  }
}

/** The browser-wide singleton used by the countdown slots. */
export const countdown = new CountdownStore()
