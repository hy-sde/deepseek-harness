---
description: "Parallelize-by-default orchestration policy: config-driven fan-out rules, a fail-closed task-isolation guard, and the rendered `orchestration:policy` system-prompt section (firstmate dispatch-profile shape, P1)."
kind: "package-reference"
---

# @deepseek-ai/dsh-orchestration-policy

English | [中文](README.zh.md)

## Summary

`dsh-orchestration-policy` makes parallelize-by-default work predictable: when a request decomposes into independent chunks, the agent fans them out as isolated task children (one per `worktree acquire` lease) up to a configured ceiling and serializes only for a true dependency. It renders the `orchestration:policy` system-prompt section from the same config that arms the optional `orchestrationPolicy` seam guard, so prompt text and enforcement cannot drift. Mount it beside the subagent and worktree tools; every knob is optional and the policy stays inert until `enabled: true`. It also wires the staged-review push gate and the outcomes-not-mechanics reporting contract.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount next to `dsh-tool-subagent` and the `worktree` tool (`dsh-tool-git`) in a composition whose deployment wants parallelize-by-default:

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-git'
- name: '@deepseek-ai/dsh-tool-git'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
- name: '@deepseek-ai/dsh-orchestration-policy'
  config:
    enabled: true
```

### Configuration knobs (all optional)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch: guard and prompt text are inert until `true`. |
| `defaultMode` | `parallel` | Posture for decomposable work: `parallel` (default) or `serial`. |
| `maxFanOut` | `3` | Ceiling on one fan-out wave; beyond it the remainder is a follow-up wave. |
| `isolation` | `required` | `required` = fail-closed isolation; `suggested` = prompt-only. |
| `enforceWorkspace` | `true` | Whether the seam guard enforces isolation when `isolation: required`. |
| `serializeReasons` | all four | Accepted reasons to serialize: `same-file-edit`, `semantic-dependency`, `shared-mutable-state`, `incompatible-concurrency`. |
| `announcePlan` | `true` | Show the captain one plan summary before a wave is dispatched. |
| `reviewGate.enabled` | `active` | The gate is active whenever the policy is enabled; `false` exits it. |
| `reviewGate.default` | `review-gated` | Standing posture for repositories without an explicit entry. |
| `reviewGate.posture` | `{}` | Explicit standing posture per repository-root prefix (`*` = global; longest matching prefix wins). Host-owned config — never repo files. |
| `reviewGate.requireVerdict` | `ship` | The only verdict that releases a push today. |
| `reviewGate.onUnavailable` | `block` | No current `ship` verdict: `block` (fail-closed refusal) or `warn` (loud degrade). A `reject` verdict always blocks in both modes. |
| `scoutPolicy.knowledgeOnly` | the five labels | Intent labels whose output is scout, not PR-shaped (prompt-rendered guidance). |
| `reporting.mode` | `outcomes` | Captain-facing prose follows the outcome contract; `verbose` = today's behavior (debugging). |
| `reporting.includePerTask` | `summary` | Per-task detail in the one-block wave summary: `summary` (one line per task) or `detail` (blocks). |
| `reporting.forbiddenTerms` | the seven terms | Mechanics vocabulary to translate or omit in captain-facing text (default: subagent, workspace, lease, worktree, pool, continuation, provider). |

**Precedence is fixed** (firstmate precedence): explicit captain instruction in the moment > configured rule > configured default > built-in default. **Malformed configuration fails at LOAD** with an actionable message (`maxFanOut` must be a positive integer; unknown isolation mode; unknown serialize reason) — never silently ignored or selected around.

### What the policy changes

1. **Classify, then fan out**: independent chunks (different files/subsystems, no shared mutable state, no ordering) are dispatched in parallel — one task per isolated working copy. **Serialize only for a true dependency** named in `serializeReasons`; *same-file edits alone are not a reason* (split by intent and merge instead).
2. **Isolation is enforced, not requested**: `isolation: required` + `enforceWorkspace` means a `subagent` start **without** a `workspace` is rejected with the fix (pass the `path` from `worktree acquire`). A provider that cannot honor `workspace` degrades to a reported warning instead of silently running unisolated.
3. **Announce + steer**: one plan summary before a wave (`announcePlan`), `send_message` steering at the nearest step boundary, `interrupt_agent` cancellation, and lease release after each child settles (never `force` without the captain's word).
4. **Gate the boundary**: under `review-gated` posture a push without a current `ship` verdict for the same staged range is refused with the fix (`review --target staged`); a verdict recorded before a re-stage/amend is *stale* and re-review is required. Verdicts live in the host process — a host restart clears them, which is deliberately fail-closed.
5. **Report outcomes, not mechanics**: the captain reads one block per wave (decided / shipped / blocked / needs captain) instead of N child transcripts; mechanics vocabulary is translated or omitted; every "needs you" is a decision, a blocker, a credential need, or a review-ready result. Detail is available on request.

A companion engine knob: `dsh-tool-git`'s `worktreeMaxSlots` caps the pool per repository (default `0` = unlimited); at the cap `acquire` refuses to **cut** a new slot (`MaxSlots` error, reuse of a provably idle slot is still allowed) — run `release`/`prune`/`destroy` or raise the cap.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the guard mechanics; observable behavior is in [Use this package](#use-this-package).

### Three parts, one source of truth

`resolvePolicyConfig()` validates and resolves partial config (throwing actionable errors at load), and the prompt section is rendered from that resolved config — the same object the guard reads. Configuration and prompt prose therefore cannot drift.

### Service registration is the arming switch

`OrchestrationPolicyService extends Service` and registers under `orchestrationPolicy` (auto-removed with the owning fiber). `tool-subagent` reads it per execution via `ctx.get('orchestrationPolicy')` — an optional service lookup, never an `inject`, so *absence is a first-class state*: today's byte-stable behavior. `ctx.get` carries no inject requirement, so the guard cannot break a composition that never mounts this package.

### Guard semantics matrix

| Policy state | Provider can isolate | `workspace` given | Result |
|---|---|---|---|
| not mounted / `enabled: false` | any | any | no-op (today's behavior) |
| `required` + `enforceWorkspace` | yes | no | **throws** `OrchestrationPolicyError` (fix: `worktree acquire` → pass `path`) |
| `required` + `enforceWorkspace` | no | no | **warning string returned** (caller surfaces it in tool output) |
| `required` + `enforceWorkspace` | any | yes | allowed |
| `suggested` or `enforceWorkspace: false` | any | any | no-op (prompt-only guidance) |

The guard sits at the model-facing `tool-subagent` seam (both one-shot and continuable starts). SDK/ACP/API paths do not go through the tool and never see the guard.

### Push gate mechanics (P2)

`review --target staged` records `{ root, beforeHead, indexTree, verdict }` per repository (one record per target, so a later worktree review cannot shadow a staged verdict). `commit_apply --push` snapshots the same two identities **before** any staging/commit, resolves the repository posture (`resolvePosture`: longest prefix match → `*` → configured default → `review-gated`), and consults the record: missing → `block`/`warn` per `onUnavailable`; identity mismatch → stale (always block); `reject` → always block; `ship` + matching identity → release with a recorded note. Local commits (`push: false`) are never gated — the gate lives at the boundary.

### Reporting contract (P3)

`buildReportingRules` renders the outcome contract from resolved config (`mode`, `includePerTask`, `forbiddenTerms`) — empty under `mode: 'verbose'` so today's behavior is one knob away. The section is pure prompt text: the model owns the final message; there is no tool-side render seam. The contract (one block per wave, needs-you taxonomy, per-task knob, forbidden vocabulary) is pinned by spec as a pure-function contract, not by golden prose.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- The engine behind the isolation requirement: [`@deepseek-ai/dsh-git`](../../git/git/README.md) worktree pool with durable leases, and the `worktree` tool in [`@deepseek-ai/dsh-tool-git`](../../git/tool-git/README.md) — `acquire --branch`, `release`, `list`, `prune`, `destroy`.
- The delegated child boundary: [`@deepseek-ai/dsh-tool-subagent`](../../subagent/tool-subagent/README.md) `workspace` argument and the `send_message`/`interrupt_agent` steering tools in [`@deepseek-ai/dsh-tool-subagent-control`](../../subagent/tool-subagent-control/README.md).
- The port plan: the P1 scoping note `firstmate-policy-scope.md` (kept alongside `port_firstmate.md` in the fork workspace), P2 review gate and P3 outcomes-not-mechanics reporting.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt section

#### What the model sees

`orchestration:policy` (order 129) — rendered from the *resolved config* at mount; empty text while `enabled: false`. The section speaks in "isolated working copies / task children" and never exposes policy internals (firstmate §9 shape).

##### Section template

```markdown
# Orchestration policy (parallelize-by-default)
Goal: same quality, more velocity, less captain cognitive load. Fan out independent chunks as isolated task children; today's serial behavior is the exception.
1. Classify before doing: independent chunks (different files/subsystems, no shared mutable state, no ordering) or one unit of work.
2. Serialize ONLY for a true dependency — the accepted reasons are:
- same-file-edit: two chunks edit the same file
- semantic-dependency: one change is an input to the next
- shared-mutable-state: lockfiles, migrations, generated code, credentials
- incompatible-concurrency: both rework the same subsystem in conflicting ways
   Same-file edits ALONE are not a reason to serialize: split by intent and merge; a shared-file edit with conflicting intent is `incompatible-concurrency`.
3. Fan out: per chunk `worktree acquire --branch <task>` then `subagent { workspace: <lease path> }` — parallel, up to 3 per wave; beyond that announce the rest as a follow-up wave.
One task = one isolated working copy. A task child MUST be started with `workspace` set to a `worktree acquire` path — the guard rejects a start without one (this is fail-closed, not a preference).
4. Steer with `send_message` at the nearest step boundary; `interrupt_agent` cancels; `list_agents` shows the fleet. Collect every child before merging; release each lease after its child settles — never `force` a release without the captain's explicit word.
5. Quality gate: under the `review-gated` posture (the default for any repository without an explicit `fast` entry), a push is REFUSED until `review --target staged` returns `ship` for the CURRENT staged range — run `review` after staging, before `commit_apply --push`. Any change after the review makes the verdict stale and a re-review is required; a `reject` verdict always blocks (even under `onUnavailable: warn`). Only an explicit `fast` posture skips the gate — never infer trust.
6. Report OUTCOMES, not mechanics: after each wave, give the captain ONE block — what was decided, what shipped, what is blocked, and what needs the captain.
Every "needs you" item is one of: a decision, a blocker, a credential need, or a review-ready result — never a child transcript.
Per-task detail: one line per task in the wave summary (detail stays available on request).
Translate or omit mechanics vocabulary in captain-facing text: subagent, workspace, lease, worktree, pool, continuation, provider. When the captain asks for details, give them (escrow, don't dump).
When a turn calls for a captain-facing reply, your FINAL response must stand alone: repeat the outcomes, the consequences, and any decision or approval needed — even if already stated mid-turn; the captain may only see the final message.
Never relay child transcripts, tool output, or status lines verbatim into captain chat: read them as evidence, then send the plain-English outcome.
Knowledge-only intents (investigate, diagnose, plan, audit, reproduce) produce investigation notes, not PR-shaped changes.
Announce the plan once before dispatch: N isolated tasks, what each owns, expected overlap (rare), who merges. One summary — never per-child chatter in the captain-facing thread.
```

#### Token effect

One fixed section while `enabled: true`; empty text (zero tokens) while disabled. The section length is independent of wave size — per-chunk detail stays in each child's own turn, not the parent prefix.

#### KV Cache effect

Prefix-stable while the config (mode, ceiling, reasons, isolation) is unchanged; changing a knob changes the rendered text and invalidates the corresponding prefix.

## Known Limitations and Deferred Work

- **Only the isolation guard is fail-closed.** The classification, fan-out ceiling, announce-plan, and steering steps are prompt-level guidance — the model remains the executor; there is no scheduler daemon.
- **Incapable providers warn, they do not fail.** An out-of-process backend (no `workspace` capability) degrades to a reported warning; if a deployment wants hard failure instead, enforce at the composition level (`isolation: required` with an in-process provider).
- **Verdicts are in-process.** A host restart clears them, so a gated deployment must re-review after a restart before the gate releases a push — deliberately fail-closed, never inferred.
- **Posture is host-owned config.** Per-repository `fast` opt-outs live in the policy config row; opening a repo-writable posture file is an injection surface and is not supported.
- **Reporting is policy text only.** The outcome contract shapes the captain-facing final message; there is no render seam (tool outputs stay as-is for the agent's own use, per the scoped honest limit). If debriefs drift, tighten `forbiddenTerms` / `includePerTask` — or introduce a real seam once the violation rate proves the prompt contract too soft.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe beyond the optional service lookup at the tool seam; its behavior is enforced by its package test suites (guard matrix, config validation, prompt rendering, and a real-git wave E2E).

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Direct `apply()` + `Service` (no Schemastery config class): `resolvePolicyConfig()` runs eagerly in `apply` so malformed config fails at LOAD (a bare `ctx.plugin` without the `systemPrompt` inject satisfied stays pending forever, which is why the load-failure test mounts `SystemPrompt` first). The guard is exercised through the real tool path in `tool-subagent`'s spec (mounted policy after setup — the guard reads it lazily at execute) and in this package's wave E2E over a real temp git repo.

</details>
