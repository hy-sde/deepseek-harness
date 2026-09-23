---
description: "Model-facing repository wiki lifecycle tools (openwiki_begin … openwiki_finish) driving the ported deterministic openwiki 0.4 engine core in-process."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-openwiki

English | [中文](README.zh.md)

## Summary

`dsh-tool-openwiki` gives an agent the repository wiki lifecycle: `openwiki_begin`, `openwiki_submit_plan`, `openwiki_next_page`, `openwiki_submit_page`, and `openwiki_finish` drive the ported deterministic openwiki 0.4 core in-process, with the same resumable, claim-grounded protocol upstream defines. Choose it in a preset when an agent should maintain a repository wiki through codebase-memory-assisted structural discovery without an external `openwiki` CLI. It is a Cordis agent-plane plugin that injects `tools` + `systemPrompt` and registers no service of its own; the main boundaries are its tight coupling to the ported core's formats and one active run per mounting session.

## Table of Contents

- [Surface](#surface)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Model-facing repository wiki lifecycle tools — `openwiki_begin`, `openwiki_submit_plan`, `openwiki_next_page`, `openwiki_submit_page`, `openwiki_finish` — that drive the ported deterministic openwiki 0.4 engine core (`@deepseek-ai/dsh-openwiki-core`) **in-process**. The five-tool contract and every model-facing description match upstream openwiki 0.4, so harness agents run the same resumable, claim-grounded wiki generation with no external `openwiki` CLI and with `codebase-memory` for structural discovery.

## Surface

One Cordis agent-plane plugin (mounts as a preset or profile-patch row, injects `tools` + `systemPrompt`, registers no service of its own):

- `openwiki_begin` — start or resume a durable run (`.run.json`) over a Git repository root; returns `status=noop` for clean updates.
- `openwiki_submit_plan` — validate and durably persist the ordered PageJob queue; init requires `/openwiki/quickstart.md`, paths are normalized.
- `openwiki_next_page` — first pending job with existing Markdown + Claims.
- `openwiki_submit_page` — complete the current job by proving its complete Claim set against the written page (front matter repair then Claims resolution and durable verification).
- `openwiki_finish` — deterministic finalization: planned/abandoned deletions, Mermaid validation, wiki index sync, link validation, generated-event origin, Claims finalization + manifest replacement, run metadata, and `.run.json` removal.

## Configuration

```yaml
- id: tool-openwiki
  name: '@deepseek-ai/dsh-tool-openwiki'
  config:
    host: harness          # stable host identity recorded in run metadata
    producerActor: harness # origin actor for engine-owned finalizers
```

## Model Experience

### Tool schemas

#### What the model sees

The five lifecycle schemas ([catalog entry](../../../docs/tool-catalog.md#deepseek-aidsh-tool-openwiki)) encode the exact resumable protocol: explicit `root`+`mode` begin, a final non-replaceable ordered plan, per-job claims with `id` reuse/retraction conventions, and a finish that requires every job complete.

#### Token effect

Five compact schemas are added once to the request prefix (~1–2 KB total); results are small JSON views (`changedPaths`, `claimIssues`, completions, no-op status), so wiki generation cost stays bounded per page rather than proportional to repository size.

#### KV Cache effect

All schemas are static; per-call args vary but never condition the request prefix. Cached prefixes stay valid across calls.

### Prompt section

#### What the model sees

One `openwiki:tools` card: the required lifecycle sequence, durable/resumable run semantics, the rule that every material Claim carries a repository evidence resource, exact claim reconciliation (preserve id/statement/evidence of unchanged claims, reuse id for revision, omit to retract), and this hook: use `codebase-memory` for structural discovery instead of file-by-file repository scans.

#### Token effect

Seven short lines added once to the request prefix; negligible per turn.

#### KV Cache effect

Static section text — no invalidation.

## Known Limitations and Deferred Work

- **Closely tied to the ported core** — behaviors (`.run.json`, `.page-manifest.json`, `.claims/` sidecars, OKF front matter, evidence URIs) match openwiki 0.4 exactly today; a future upstream format change would need a matching core bump.
- **Mermaid/jsdom optional** — authoritative Mermaid validation needs the optional `mermaid` + `jsdom` peers in the host process; without them validation degrades to heuristics (same as upstream).
- **One active run per mounting session** — `HostSessionManager` is a single-run adapter; concurrent wiki runs need separate agent sessions or a per-run manager refactor.
- **No CI workflow** — upstream's scheduled GitHub Actions workflow and code-mode connectors are deliberately not ported; the harness runs the wiki in-process through these very tools.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
