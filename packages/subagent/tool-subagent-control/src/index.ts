/**
 * The globally named `send_message`, `interrupt_agent`, and
 * `pending_decisions` tools: thin model-facing adapters over
 * `ctx.subagents.followup()`, `ctx.subagents.interrupt()`, and the keyed
 * open-decision ledger (`listOpenDecisions` / `resolveOpenDecision`). They
 * perform no lifecycle routing of their own — residency, cold resume, and
 * interrupt authorization belong to the subagent service — and they live apart
 * from the provider-bound `@deepseek-ai/dsh-tool-subagent` instances so
 * multiple delegation tools share one control API.
 * @module @deepseek-ai/dsh-tool-subagent-control
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-subagent-control'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Guidance order after the open-decision tool family in parent prompts. */
const CONTROL_SECTION_ORDER = 116

/**
 * Register the `send_message`, `interrupt_agent`, and `pending_decisions`
 * tools plus a short coordination-policy section.
 * @param ctx - context carrying the tool registry, subagent service, and system prompt.
 */
export function apply(ctx: Context): void {
  // Usage policy ships with the tool family (the master convention: tool
  // guidance lives in tool plugins as prompt sections, not in the deployment
  // persona). Empty text while either tool is absent keeps the section inert.
  ctx.systemPrompt.section({
    name: 'tool:subagent-control',
    order: CONTROL_SECTION_ORDER,
    text: context =>
      ctx.tools.get('send_message', context.scope) === undefined
        ? ''
        : 'A settled subagent stays addressable: continue it with send_message when it is the one '
          + 'holding the work it needs. Each report carrying a decision key is owed exactly one '
          + 'answer — check pending_decisions before finishing, and close each key by passing that '
          + 'key as resolve_decision_key on the same send_message that carries your answer. Never '
          + 're-answer a key already resolved; if the child re-asks with the same key, answer once more.',
  })
  ctx.tools.register(defineTool({
    name: 'send_message',
    description:
      'Send a message to a background subagent by its subagent id, continuing the same conversation. It '
      + 'becomes the subagent\'s next turn: if it is still working, the message waits until its current turn '
      + 'finishes, so it cannot redirect work already underway. This call returns no answer from the '
      + 'subagent — only confirmation that the message was delivered — so use it to give it more work. A '
      + 'failure means the message was NOT delivered. Pass `resolve_decision_key` when this message answers '
      + 'that child\'s open decision, so its ledger record closes with the answer it is owed.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'The subagent id returned when the background subagent was started.',
      },
      message: {
        type: 'string',
        required: true,
        description: 'The message to deliver to the subagent.',
      },
      resolve_decision_key: {
        type: 'string',
        description: 'A decision key this child opened (from pending_decisions) that this message answers; closes the ledger record.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string', required: true },
          decisionResolved: { type: 'boolean', required: true },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: args.resolve_decision_key !== undefined
          ? value.decisionResolved
            ? `message queued as the next turn for subagent ${args.subagent_id}; decision "${args.resolve_decision_key}" closed`
            : `message queued as the next turn for subagent ${args.subagent_id}; no open decision "${args.resolve_decision_key}" existed to close`
          : `message queued as the next turn for subagent ${args.subagent_id}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        // Parent authority requires an exact live calling agent.
        throw new Error('send_message requires a calling agent (exec.agent was undefined)')
      }
      const message: ContentBlock[] = [{ type: 'text', text: args.message }]
      const messageId = await ctx.subagents.followup(
        parent,
        SessionId(args.subagent_id),
        message,
        {
          source: { kind: 'coordinator', form: 'relay', senderSessionId: parent.id },
          signal: exec.signal,
        },
      )
      const decisionResolved = args.resolve_decision_key !== undefined
        ? ctx.subagents.resolveOpenDecision(parent, SessionId(args.subagent_id), args.resolve_decision_key)
        : false
      return { messageId, decisionResolved }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'interrupt_agent',
    description:
      'Request cancellation of a background agent\'s current turn by its agent id. The target may be your '
      + 'direct child or a deeper agent created under you. Only the current turn stops: messages already '
      + 'queued for the agent stay parked until a later send_message, agents it started keep running, and '
      + 'the agent itself stays available for follow-ups. This call returns as soon as the stop request is '
      + 'accepted, so the target may keep running briefly; interrupting an agent that already finished is '
      + 'an accepted no-op.',
    parameters: {
      agent_id: {
        type: 'string',
        required: true,
        description: 'The agent id of the running agent to interrupt.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
        },
      },
      render: (args, _value) => [{
        type: 'text',
        text: `interrupt requested for agent ${args.agent_id}`,
      }],
    },
    execute(args, exec) {
      const caller = exec.agent
      if (!caller) {
        // Ancestor authority requires an exact live calling agent.
        throw new Error('interrupt_agent requires a calling agent (exec.agent was undefined)')
      }
      // The service authorizes the exact live caller against the target's
      // recorded lineage; the tool adds no authority of its own.
      ctx.subagents.interrupt(SessionId(args.agent_id), { kind: 'ancestor', agent: caller })
      return Promise.resolve({ accepted: true })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pending_decisions',
    description:
      'List every open keyed decision your background subagents are still owed an answer to. A child that '
      + 'reported with status needs-decision or blocked and a decisionKey stays owed until you answer; '
      + 'open decisions survive the child settling, so check this after a child’s run ends and before you '
      + 'finish your own turn. Answer each key exactly once with send_message + resolve_decision_key.',
    parameters: {
      subagent_id: {
        type: 'string',
        description: 'Optional filter: only show decisions from this subagent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          decisions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                child_id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                key: { type: 'string', required: true },
                status: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                opened_at: { type: 'number', required: true },
              },
            },
            required: true,
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: value.decisions.length === 0
          ? `no open decisions${args.subagent_id !== undefined ? ` from subagent ${args.subagent_id}` : ''}`
          : `${value.decisions.length} open decision(s)${args.subagent_id !== undefined ? ` from subagent ${args.subagent_id}` : ''}: `
            + value.decisions
              .map(d => `${d.key} (${d.status}, ${d.label ?? d.child_id}) — ${d.summary}`)
              .join('; '),
      }],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) {
        throw new Error('pending_decisions requires a calling agent (exec.agent was undefined)')
      }
      const rows = ctx.subagents.listOpenDecisions(caller)
      const filtered = args.subagent_id !== undefined
        ? rows.filter(entry => entry.childId === args.subagent_id)
        : rows
      return {
        decisions: filtered.map(entry => ({
          child_id: entry.childId.toString(),
          label: entry.label,
          key: entry.key,
          status: entry.status,
          summary: entry.summary,
          opened_at: entry.openedAt,
        })),
      }
    },
  }))
}
