/**
 * Type shapes for the `ctx.vcs` service, mirroring the JSON payloads of the
 * `pi-vcs` CLI (repo-info) and its JSON-lines watch protocol. Field names are
 * kept 1:1 with the CLI contract so a newer `pi-vcs` release shows up as
 * parsed data rather than a schema drift.
 * @module @deepseek-ai/dsh-vcs/types
 */

/** `pi-vcs repo-info <dir>` JSON payload. */
export interface VcsRepoInfo {
  /** Checkout root (the directory containing the `.git` entry). */
  root: string
  /** Resolved git directory (worktree-private for linked worktrees). */
  gitDir: string
}

/** One `pi-vcs watch` event (JSON-lines on stdout). */
export interface VcsWatchEvent {
  /** `head` — the repository HEAD moved. */
  event: 'head'
  /** 1-based event sequence within this watch session. */
  seq: number
}

/** Capabilities present when the service was reached. */
export interface VcsProbe {
  /** Whether the `pi-vcs` CLI is reachable and answers `pi-vcs --version`. */
  available: boolean
  /** CLI-reported version (e.g. `0.1.0`) when available. */
  version?: string
  /** Human-readable failure reason when unavailable. */
  reason?: string
}
