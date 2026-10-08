/**
 * Canonical `dsh-session` mention rendering for stored session origin.
 * Mentions are produced only by `formatSessionReferenceMention` so the target
 * URI is the canonical encoding (`decodeSessionReferenceUri` round-trips it)
 * and the label is escaped by the same function.
 * @module @deepseek-ai/dsh-memory/session-origin
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'

/**
 * Canonical `@[label](dsh-session:…)` mention for one stored session id.
 * @param sessionId - raw session id as persisted by the backend.
 * @param label - optional display label; defaults to the raw session id.
 * @returns mention carrying the canonical encoding of `sessionId`.
 */
export function sessionOriginMention(sessionId: string, label?: string): string {
  return formatSessionReferenceMention({
    sessionId: brandString<SessionId>(sessionId),
    label: label ?? sessionId,
  })
}
