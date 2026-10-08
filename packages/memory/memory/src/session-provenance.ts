/**
 * Canonical `dsh-session` mention rendering for stored session provenance.
 * Mentions are produced only by `formatSessionReferenceMention` so the target
 * URI is the canonical encoding (`decodeSessionReferenceUri` round-trips it)
 * and the label is escaped by the same function.
 * @module @deepseek-ai/dsh-memory/session-provenance
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'

/**
 * Canonical `@[label](dsh-session:…)` mention for one stored session id.
 * @param sessionId - raw session id as persisted by the backend.
 * @returns mention whose label is the raw session id.
 */
export function sessionProvenanceMention(sessionId: string): string {
  return formatSessionReferenceMention({
    sessionId: brandString<SessionId>(sessionId),
    label: sessionId,
  })
}
