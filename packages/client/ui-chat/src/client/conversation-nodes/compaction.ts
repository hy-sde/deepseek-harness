import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { CompactionSummaryNode } from '../contract/snapshot.ts'
import { chatNode } from './common.ts'
import { compactSource, compactSummary, updateCompactionState } from './command.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Automatic compaction checkpoint marker. */
    compaction: CompactionSummaryNode
  }
}

interface CompactionState {
  readonly start?: ConversationMatch
  readonly summary?: ConversationMatch
  readonly checkpoint?: ConversationMatch
  readonly end?: ConversationMatch
}

function fallbackState(context: ConversationNodeContext<CompactionState>): CompactionState {
  const start = context.matches.find(match => match.event.type === 'compaction/start')
  const summary = context.matches.find(match => match.event.type === 'compaction/summary')
  const checkpoint = context.matches.find(match => compactSource(match.event) !== undefined)
  const end = context.matches.find(match => match.event.type === 'compaction/end')
  return {
    ...start === undefined ? {} : { start },
    ...summary === undefined ? {} : { summary },
    ...checkpoint === undefined ? {} : { checkpoint },
    ...end === undefined ? {} : { end },
  }
}

/** Automatic compaction lifecycle and landed checkpoint Definition. */
export const compactionDefinition: ConversationNodeDefinition<CompactionState> = {
  kind: 'compaction',
  target: 'chat',
  match: (event) => {
    const checkpoint = compactSource(event)
    if (checkpoint !== undefined && checkpoint.sourceCommandId === undefined) {
      return { id: checkpoint.compactionId, role: 'update' }
    }
    if (event.type === 'compaction/start'
      || event.type === 'compaction/summary'
      || event.type === 'compaction/end') {
      if (event.data.sourceCommandId !== undefined) return null
      const compactionId: unknown = event.data.compactionId
      if (typeof compactionId !== 'string' || compactionId === '') return null
      return { id: compactionId, role: event.type === 'compaction/start' ? 'start' : 'update' }
    }
    return null
  },
  start: () => ({}),
  update: (context, match) => updateCompactionState(context.state, match),
  buildViewNode: (context) => {
    // Merge window-derived evidence under incremental state: the start-role
    // initialization leaves the state empty until the first update match, so
    // a window that only holds `compaction/start` must still find it.
    const state = { ...fallbackState(context), ...context.state }
    // A landed checkpoint produces the summary marker. Before it — or when the
    // run ended without one (abort/failure) — the window must still show a
    // row: automatic compaction is slow (it summarizes the whole transcript)
    // and an interrupted one is otherwise invisible while the reader sits
    // waiting on a turn that never steps.
    if (state.checkpoint !== undefined) {
      const marker = compactSummary(state.summary, state.checkpoint)
      return chatNode(context, 'compaction', marker.seq, marker)
    }
    const end = state.end
    if (end !== undefined) {
      const error = (end.event.data as { error?: unknown }).error
      return chatNode(context, 'compaction', end.event.seq, {
        kind: 'compaction',
        seq: end.event.seq,
        time: end.event.time,
        summary: null,
        summaryEventSeq: null,
        shadowedItemCount: null,
        shadowedTokenCount: null,
        status: 'interrupted',
        ...typeof error === 'string' && error !== '' ? { error } : {},
      })
    }
    const start = state.start
    if (start === undefined) return null
    return chatNode(context, 'compaction', start.event.seq, {
      kind: 'compaction',
      seq: start.event.seq,
      time: start.event.time,
      summary: null,
      summaryEventSeq: null,
      shadowedItemCount: null,
      shadowedTokenCount: null,
      status: 'running',
    })
  },
}

/**
 * Register the automatic-compaction business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerCompactionConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(compactionDefinition)
}
