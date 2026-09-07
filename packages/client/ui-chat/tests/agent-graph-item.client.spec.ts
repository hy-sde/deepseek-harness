import { describe, expect, it } from 'vitest'
import type { SessionGraphProjection } from '@deepseek-ai/dsh-graph-projection/types'
import { agentGraphItemFor } from '../src/client/chat/agent-graph-item.ts'

function snapshot(overrides: {
  status?: SessionGraphProjection['status']
  work?: SessionGraphProjection['work']
} = {}): SessionGraphProjection {
  const status = overrides.status ?? 'active'
  return {
    schemaVersion: 1,
    graphId: 'g1',
    status,
    revision: 1,
    closed: status === 'closed',
    work: overrides.work ?? [{ workId: 'w1', status: 'requested', instruction: 'update the index', inputCount: 0 }],
    omitted: { work: 0, records: 0, inputs: 0 },
    pendingWake: false,
    updatedAt: 1,
  }
}

describe('agentGraphItemFor', () => {
  it('returns null while the projection is absent or not yet available', () => {
    expect(agentGraphItemFor(undefined)).toBeNull()
    expect(agentGraphItemFor(null)).toBeNull()
  })

  it('returns null for a quiet closed graph with an empty rail', () => {
    expect(agentGraphItemFor(snapshot({ status: 'closed', work: [] }))).toBeNull()
  })

  it('shows an active graph before any work lands on the rail', () => {
    expect(agentGraphItemFor(snapshot({ status: 'active', work: [] }))).toEqual({ count: 0, status: 'active' })
  })

  it('shows the work count for a closed graph that ran work items', () => {
    expect(agentGraphItemFor(snapshot({ status: 'closed' }))).toEqual({ count: 1, status: 'closed' })
  })

  it('reports the live work count for an active graph', () => {
    expect(agentGraphItemFor(snapshot({
      status: 'active',
      work: [
        { workId: 'w1', status: 'finished', instruction: 'done', inputCount: 1 },
        { workId: 'w2', status: 'executing', instruction: 'in flight', inputCount: 2 },
      ],
    }))).toEqual({ count: 2, status: 'active' })
  })
})
