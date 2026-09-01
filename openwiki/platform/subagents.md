---
type: Reference
title: Subagent Capability Family
description: The delegation family of DeepSeek Harness — the ctx.subagents provider registry, one-shot and continuable children, the durable decision ledger, depth limits, and the product adapters for ACP, Codex, Claude Code and DSH SDK.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-e1036ed9b2a9fbd4d1538ce0
    resource: repo://docs/subsystems/subagent.md
  - id: openwiki-source-de676a9d35cd3650bc210e66
    resource: repo://packages/subagent/README.md
  - id: openwiki-source-1f7a6a44695ed0de665a8695
    resource: repo://packages/subagent/subagent/README.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# Subagent Capability Family

The subagent group is the delegation family: it lets an agent hand a task to a child agent, wait for or continue the child's work, and keep every child discoverable. One contract (`ctx.subagents`) serves any number of named providers, so a single composition can mix in-process children (fresh, or forked from the parent's completed history) with out-of-process children — an ACP agent, a real Codex or Claude Code installation, or a complete Harness runtime over the SDK. The model-facing tools expose delegation, follow-up, and listing to agents, and a parent can always see which children exist and whether they are live or stored.

## The service and its providers

`dsh-subagent` is the service behind child-agent delegation: an agent hands a task to a named child, collects the finished result, and — for continuable children — keeps sending follow-up work across turns. Children come in two shapes: one-shot runs that settle with a single result, and continuable children whose durable session accepts later messages and can be interrupted. The same service answers discovery questions — which children exist, their mode, activity, and lineage — without loading or resuming them. Multiple providers coexist under one contract.

| Package | Role | ctx key |
| --- | --- | --- |
| `subagent/` | Defines the delegation service: provider registry, one-shot runs, continuable children, and discovery | `ctx.subagents` |
| `subagent-spawn-in-process/` | Runs a fresh in-process child | registers on `ctx.subagents` |
| `subagent-fork-in-process/` | Runs an in-process child seeded from the parent's completed history | registers on `ctx.subagents` |
| `subagent-acp/` | Runs an out-of-process child over the Agent Client Protocol | registers on `ctx.subagents` |
| `subagent-codex/` | Runs a real Codex child through the official app-server protocol | registers on `ctx.subagents` |
| `subagent-claude-code/` | Runs a real Claude Code child through the official Agent SDK | registers on `ctx.subagents` |
| `subagent-dsh-sdk/` | Runs an out-of-process Harness child through the TypeScript SDK | registers on `ctx.subagents` |
| `tool-subagent/` | Exposes delegation to the model | registers on `ctx.tools` |
| `tool-subagent-control/` | Exposes follow-up, interrupt, and listing (`send_message`, `interrupt_agent`, `list_agents`) | registers on `ctx.tools` |
| `tool-subagent-report/` | Provides the child-to-parent report channel | registers in child scopes |

The seam differs from bash: it is one optional capability, not part of the agent loop, and multiple provider implementations coexist in one context registered by name — its registry follows the LLM adapter registry, not the single-service executor pattern.

## Provider contract and capability discovery

A provider advertises its **start-time** features on a static descriptor (`SubagentCapabilities`: `agentOptions`, `outputSchema`, `depthLimit`, `toolFilter`, `persona`) that the service checks **before** a one-shot run exists; a request that needs one the provider lacks is rejected loud with `SubagentError('UNSUPPORTED_CAPABILITY')`, never accepted-then-ignored. **Continuable** children are composed by the continuation manager itself, so they are gated by one optional method whose presence *is* the capability — `SubagentProvider.prepareContinuable` — with TypeScript narrowing as the discovery mechanism.

The one-shot `SubagentStartRequest` is built by the tool layer from the model's `{ description, prompt }` plus its own config; the service validates it against the named provider before `start`. Required `parent` supplies the session cwd, lineage, and delegation depth. Optional provider, model, reasoning-effort, and token overrides, output schema, depth, tool filter, and persona require matching capability flags. In-process backends merge `agentOptions` over the parent Agent's options and implement the supported object-rooted schema with a forced capture tool.

## Continuation, the decision ledger, and depth

Provider `start()` fulfills with a published run. The service mints a unique `runId`, snapshots `local` from the provider's exact `localAgent`, and emits a paired observe-only `subagent/start` / `subagent/end`; each continuable Activation emits the same observe-only pair for its residency epoch, so a cold resume is a new epoch with its own `runId`.

- **Decision ledger.** `listOpenDecisions(parent)` lists every open decision a continuable child has reported, oldest first. Open decisions survive the child settling. The durable ledger is folded into the projection on first list, so a restarted host reports the same records without a fresh child report. `resolveOpenDecision(parent, childId, key)` closes one open decision after the parent answers it — idempotent (an already-resolved, never-opened, or malformed key returns `false` without throwing), appending the durable `resolve` mutation.
- **Delegation depth.** Depth is durable `SessionHeader.delegationDepth` plus the merge-extensible runtime field `AgentOptions.subagentDepth`; absence means top-level depth zero, and the greater present value is authoritative. The seam owns both fields — the loop neither sets nor reads them — so an in-process child persists parent depth + 1, cold resume cannot lower it, and every start rejects a derived depth outside the safe-integer domain or above a defined absolute `request.maxDepth` cap.
- **Fork seeding.** The fork backend passes a *balanced completed-turn prefix* of the parent's log (the events up to and including its last `turn/end`) through `CreateAgentOptions.seed`, so the seed is contiguous-from-0 and replay invariants accept it.

## Related pages

- [Plugin Architecture and Composition](../architecture/overview.md) — where the delegation family mounts.
- [Sandbox, Subprocess and Terminal Execution](sandbox-execution.md) — the out-of-process children's runtime siblings, including the approval stack the ACP bridge uses.
