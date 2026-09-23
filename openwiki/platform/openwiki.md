---
type: Reference
title: OpenWiki Engine (Fork Port)
description: The in-fork port of the openwiki 0.4 engine in DeepSeek Harness — the deterministic, resumable, claim-grounded repository wiki machinery that runs in-process behind the five lifecycle tools.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-5353364249482c00f941525b
    resource: repo://packages/openwiki/openwiki-core/README.md
  - id: openwiki-source-16a3c374a2e2e48adc42d79a
    resource: repo://packages/openwiki/tool-openwiki/README.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# OpenWiki Engine (Fork Port)

This fork ports the [openwiki](https://github.com/langchain-ai/openwiki) 0.4.3 **deterministic engine core** (MIT-licensed; attribution preserved in the module headers) as `@deepseek-ai/dsh-openwiki-core`: the model-free repository wiki machinery that upstream pairs with DeepAgents. The fork removed the DeepAgents/CLI coupling — the engine runs **in-process** behind a minimal `WikiFs` filesystem seam, so no external `openwiki` CLI is needed. Repositories written by either engine are interoperable because the on-disk formats are identical.

## Engine surface

The core is a pure TypeScript library (only `zod` + `yaml` deps), organized as `src/*`:

- **Lifecycle** — resumable repository-page-job orchestration (`begin` / `submit_plan` / `next_page` / `submit_page` / `finish`) with a durable `.run.json` checkpoint, git source fingerprinting, update no-op detection, and a `.page-manifest.json` correctness ledger.
- **Claims** — the Grounded Claims core (add/confirm/update/retract mutations), the code-brain store/session/runtime with `.claims/` sidecar persistence and verification, and the repository evidence resolver that maps `repo://path#L20-L48` resources to opaque `repo-lines-v1:sha256:` versions with relocation anchors.
- **OKF** — OKF v0.2 front matter validation/repair, generated-event origin, index-labels, recursive concept-index synchronization, claim-sources, and a claims-verification projection.
- **Validation** — Mermaid fence validation (jsdom/mermaid optional, graceful heuristic fallback) and wiki-internal-link validation with broken-link stamping.
- **Setup + fs** — `.openwikiignore` load, managed AGENTS.md/CLAUDE.md snippets plus `INSTRUCTIONS.md` wiki goal, recoverable init wiki replacement, and the in-fork `WikiFs`/`createNodeWikiFs` seam.
- **Integration** — the transport-neutral `HostSessionManager` + zod protocol (`openwiki_begin` … `openwiki_finish`) and Git repository-root resolution.

## The five lifecycle tools

`@deepseek-ai/dsh-tool-openwiki` is one Cordis agent-plane plugin (mounts as a preset or profile-patch row, injects `tools` + `systemPrompt`, registers no service of its own):

- `openwiki_begin` — start or resume a durable run (`.run.json`) over a Git repository root; returns `status=noop` for clean updates.
- `openwiki_submit_plan` — validate and durably persist the ordered PageJob queue; init requires `/openwiki/quickstart.md`, and paths are normalized.
- `openwiki_next_page` — first pending job with existing Markdown + Claims.
- `openwiki_submit_page` — complete the current job by proving its complete Claim set against the written page (front matter repair, then Claims resolution and durable verification).
- `openwiki_finish` — deterministic finalization: planned/abandoned deletions, Mermaid validation, wiki index sync, link validation, generated-event origin, Claims finalization + manifest replacement, run metadata, and `.run.json` removal.

Configuration:

```yaml
- id: tool-openwiki
  name: '@deepseek-ai/dsh-tool-openwiki'
  config:
    host: harness          # stable host identity recorded in run metadata
    producerActor: harness # origin actor for engine-owned finalizers
```

## Model experience

- **Schemas.** The five lifecycle schemas encode the exact resumable protocol: explicit `root`+`mode` begin, a final non-replaceable ordered plan, per-job claims with `id` reuse/retraction conventions, and a finish that requires every job complete. Results are small JSON views (`changedPaths`, `claimIssues`, completions, no-op status), so wiki generation cost stays bounded per page.
- **Prompt section.** One `openwiki:tools` card: the required lifecycle sequence, durable/resumable run semantics, the rule that every material Claim carries a repository evidence resource, exact claim reconciliation (preserve `id`/statement/evidence of unchanged claims, reuse `id` for revision, omit to retract), and the hook to use `codebase-memory` for structural discovery instead of file-by-file repository scans.

## Known limitations

- The tools are closely tied to the ported core — behaviors (`.run.json`, `.page-manifest.json`, `.claims/` sidecars, OKF front matter, evidence URIs) match openwiki 0.4 exactly today.
- Mermaid/jsdom peers are optional: authoritative Mermaid validation needs the optional `mermaid` + `jsdom` packages in the host process; without them validation degrades to heuristics.
- Git is required: source fingerprinting, update windows, and root resolution shell out to `git`.
- Upstream's CI workflow and source connectors are deliberately not ported — this fork's wiki runs in-process through these very tools.

## Related pages

- [Quickstart](../quickstart.md) — this wiki was generated by the engine documented here.
- [Codebase Memory Tools](codebase-memory.md) — the structural discovery surface the openwiki:tools card points at.
