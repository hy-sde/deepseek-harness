# Agent Note: Upstream-merge decision ledger (durable, keyed, consulted before conflict resolution)

Status: implemented

English | [中文](2026-10-02-merge-decision-ledger.zh.md)

## Problem

The 0.1.5/0.1.6 syncs' one silent functional regression — the fork's byte-aware live-write batching and `compressionLevel` dropped when the 2026-09-10 0.1.5-rc.1 upstream merge took upstream's rewritten session package wholesale ([re-port](2026-09-20-upstream-merge-post-merge-validation.md)) — and the earlier audit's lost `llm-pi-ai` empty-compat fix share a root cause that post-merge scanners cannot address: **the keyed-decision ledger from the original merge sessions was never a consultable artifact.** The 2026-09-19 0.1.6-alpha.2 merge message says it outright: "keyed-decision ledger NOT ported." A diff scanner detects losses after the merge; nothing told the person or agent resolving a conflict what earlier merges had already decided about that key. Knowledge loss is upstream of code loss.

## Decision

A durable, keyed decision ledger lives in the pi-durable agent (Route A: `@hy-sde-org/dsh-pi-durable`, database `~/.dsh/storages/pi-agent.sqlite`). Each decision is a `decision`-kind entry with data `{ledger: 'upstream-merge-decisions', merge, key, side, status, what, refs}` and `requestId = ledger:<merge>:<key>`, so re-seeding is exactly-once — reruns replay to the same submissions instead of duplicating. Entries are stored verbatim in sqlite (never ACP-compressed) and commit atomically with the transcript. Seeded 2026-10-02 from the 2026-09-12 and 2026-09-24 merge-loss audits: 20 entries, via `/Users/hui/Documents/workspace/seed-merge-ledger.mjs`.

### Consult ritual (binding)

1. **Before resolving any upstream-merge conflict**, page the durable agent's history and filter `kind=decision` for the key, package, or file in question. A recorded decision binds unless the captain explicitly overrides it; record the override as a new entry that supersedes the old key.
2. **After resolving**, append one decision entry with the schema above (`requestId = ledger:<merge>:<key>` keeps it idempotent). Record `side`, the rationale, and refs — the "because" is the load-bearing part.
3. **Keep the detection layer.** The mb-based diff scanner over `--first-parent` fix/feat commits still runs post-merge; the ledger is prevention, the scanner is detection. Neither substitutes for the other.

### Operations

The `durable_agent_*` tools are mounted in the cordis-plus preset (engine row `pi-durable`, host plane, in the web profile composition). From scripts, import the engine dist directly and call `writeEntry` with the same resolved config; the host process owns `LOCAL_API_KEY`, so script-side runs never need generation for ledger writes (`writeEntry` is passive — it never triggers a model call).

### Seeded decisions (2026-10-02)

- `session-persistence/live-batching-compression` — fork-wins, regression fixed by the 2026-09-25 live-batching re-port (lost to the 2026-09-10 upstream-wins merge, "upstream wins", detected by 3 red jsonl.spec tests).
- `agent-loop/cancel-claimed-input` — fork-wins, fixed by the 2026-09-25 cancel-semantics fix (cancel never erases claimed input; pre-existing code/test mismatch).
- `scope-lifecycle/persona-field` — fork-wins (`persona` → `personaPrefix`), stale upstream test text fixed.
- `process/merge-validation-vitest-gap` — lesson: merge validation must run the full vitest suite of touched packages (the batching loss slipped through gates without vitest).
- `wiki/apiproxy` superseded · `tools/run-code-session-reset-params` superseded · `client/popup-ri-reveal` and `client/popup-wo-reveal` upstream-adopted · `ui-workspace/recency-init` superseded · `subagent/workspace-capability` present · `worker-thread/no-warnings` obsolete · `codebase-memory/gitignore` restored · `tool-str-replace-editor/643-line-deletion` deliberate · `control-types/SubagentControlError-map` deliberate upstream redesign · `AGENTS.md/package-layout-edit-ast` open (cosmetic) · `docs/generated-catalog` expected churn — all from the 2026-09-24 audit.
- `llm-pi-ai/empty-compat` fixed · `client/browser-catalog-ordering` decided (upstream oldest-first; fork flip is an optional follow-up flipping index.ts and spec together) · `client/pointer-hover-close` survived — from the 2026-09-12 audit.
- `process/consult-convention` — the meta-entry carrying this ritual.

## Alternatives considered

**A tracked in-repo ledger file (markdown/csv).** Visible in review, but it is exactly the artifact merges overwrite and upstream renames, and script-side appends would conflict on every merge. Lost to the durable agent store: append-only, `requestId`-idempotent, immune to upstream churn, and queryable by key without grepping prose.

**The post-merge diff scanner alone.** It detects losses only after the merge lands and tells the conflict resolver nothing mid-merge; kept as the detection layer, but prevention needs a consultable record. Lost as the sole mechanism.

**Decision comments and tests at each site.** Site-local attribution rots with the code and cannot answer "what did earlier merges decide about this key?" in one place. Lost to the keyed ledger.

## Consequences

The cost: the ledger lives outside the repo (`~/.dsh/storages/pi-agent.sqlite`), so a fresh machine must re-run the seed script (idempotent — replays to the same submissions), and the consult ritual depends on the durable-agent tooling being mounted (cordis-plus preset). The buy: conflict resolvers now see the prior side, rationale, and refs before choosing; the 20 decisions seeded 2026-10-02 carry the "because"; and the scanner stays detection-only, so prevention and detection no longer share a single point of failure.
