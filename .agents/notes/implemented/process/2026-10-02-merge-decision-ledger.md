# Agent Note: Upstream-merge decision ledger (durable, keyed, consulted before conflict resolution)

Status: implemented

English | [中文](2026-10-02-merge-decision-ledger.zh.md)

## Problem

The 0.1.5/0.1.6 syncs' one silent functional regression — the fork's byte-aware live-write batching and `compressionLevel` dropped when `12f54ae41d` took upstream's rewritten session package wholesale ([re-port](2026-09-20-upstream-merge-post-merge-validation.md)) — and the earlier audit's lost `llm-pi-ai` empty-compat fix share a root cause that post-merge scanners cannot address: **the keyed-decision ledger from the original merge sessions was never a consultable artifact.** The `13bcd9930e` merge message says it outright: "keyed-decision ledger NOT ported." A diff scanner detects losses after the merge; nothing told the person or agent resolving a conflict what earlier merges had already decided about that key. Knowledge loss is upstream of code loss.

## Decision

A durable, keyed decision ledger lives in the pi-durable agent (Route A: `@hy-sde-org/dsh-pi-durable`, database `~/.dsh/storages/pi-agent.sqlite`). Each decision is a `decision`-kind entry with data `{ledger: 'upstream-merge-decisions', merge, key, side, status, what, refs}` and `requestId = ledger:<merge>:<key>`, so re-seeding is exactly-once — reruns replay to the same submissions instead of duplicating. Entries are stored verbatim in sqlite (never ACP-compressed) and commit atomically with the transcript. Seeded 2026-10-02 from the 2026-09-12 and 2026-09-24 merge-loss audits: 20 entries, via `/Users/hui/Documents/workspace/seed-merge-ledger.mjs`.

### Consult ritual (binding)

1. **Before resolving any upstream-merge conflict**, page the durable agent's history and filter `kind=decision` for the key, package, or file in question. A recorded decision binds unless the captain explicitly overrides it; record the override as a new entry that supersedes the old key.
2. **After resolving**, append one decision entry with the schema above (`requestId = ledger:<merge>:<key>` keeps it idempotent). Record `side`, the rationale, and refs — the "because" is the load-bearing part.
3. **Keep the detection layer.** The mb-based diff scanner over `--first-parent` fix/feat commits still runs post-merge; the ledger is prevention, the scanner is detection. Neither substitutes for the other.

### Operations

The `durable_agent_*` tools are mounted in the cordis-plus preset (engine row `pi-durable`, host plane, in the web profile composition). From scripts, import the engine dist directly and call `writeEntry` with the same resolved config; the host process owns `LOCAL_API_KEY`, so script-side runs never need generation for ledger writes (`writeEntry` is passive — it never triggers a model call).

### Seeded decisions (2026-10-02)

- `session-persistence/live-batching-compression` — fork-wins, regression fixed by `9248da21c0` (lost to `12f54ae41d` "upstream wins", detected by 3 red jsonl.spec tests).
- `agent-loop/cancel-claimed-input` — fork-wins, fixed by `e0bfc3472e` (cancel never erases claimed input; pre-existing code/test mismatch).
- `scope-lifecycle/persona-field` — fork-wins (`persona` → `personaPrefix`), stale upstream test text fixed.
- `process/merge-validation-vitest-gap` — lesson: merge validation must run the full vitest suite of touched packages (the batching loss slipped through gates without vitest).
- `wiki/apiproxy` superseded · `tools/run-code-session-reset-params` superseded · `client/popup-ri-reveal` and `client/popup-wo-reveal` upstream-adopted · `ui-workspace/recency-init` superseded · `subagent/workspace-capability` present · `worker-thread/no-warnings` obsolete · `codebase-memory/gitignore` restored · `tool-str-replace-editor/643-line-deletion` deliberate · `control-types/SubagentControlError-map` deliberate upstream redesign · `AGENTS.md/package-layout-edit-ast` open (cosmetic) · `docs/generated-catalog` expected churn — all from the 2026-09-24 audit.
- `llm-pi-ai/empty-compat` fixed · `client/browser-catalog-ordering` decided (upstream oldest-first; fork flip is an optional follow-up flipping index.ts and spec together) · `client/pointer-hover-close` survived — from the 2026-09-12 audit.
- `process/consult-convention` — the meta-entry carrying this ritual.
