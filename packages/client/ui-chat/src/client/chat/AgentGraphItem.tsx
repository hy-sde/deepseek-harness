/**
 * Projection-driven transcript marker for a session continued by the agent
 * graph: one bounded summary row (work count · status) at the top of the chat
 * flow, styled as the compaction chip. The row renders only from the `graph`
 * projection — the chat snapshot never carries projection values — so absence,
 * `null` (no graph yet), and a quiet closed graph render nothing.
 */

import { memo } from 'react'
import type { SessionGraphProjection } from '@deepseek-ai/dsh-graph-projection/types'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { agentGraphItemFor } from './agent-graph-item.ts'
import css from './MessageItem.module.css'

/**
 * Renders the agent-graph continuation marker.
 * @param props - the session's `graph` projection and the view locale seat.
 * @returns the marker row, or null while the projection is absent or quiet.
 */
export const AgentGraphItem = memo(function AgentGraphItem({
  graph,
  t,
}: {
  graph: SessionGraphProjection | null | undefined
  t: ChatViewSlotProps['t']
}) {
  const item = agentGraphItemFor(graph)
  if (item === null) return null
  return (
    <div className={css.compactionRow}>
      <button
        type="button"
        className={css.compactionButton}
        disabled
        data-agent-graph-item=""
        data-agent-graph-status={item.status}
      >
        <span className={css.compactionTitle}>{t('message.agentGraph')}</span>
        <span className={css.compactionSep} aria-hidden />
        <span className={css.compactionSummary}>
          {t(item.count === 1 ? 'message.agentGraph.count.one' : 'message.agentGraph.count.other', { count: item.count })}
          {t('message.agentGraph.separator')}
          {t(item.status === 'active' ? 'message.agentGraph.status.active' : 'message.agentGraph.status.closed')}
        </span>
      </button>
    </div>
  )
})
