---
description: "The in-process port of the deterministic openwiki 0.4.3 engine core — resumable wiki lifecycle, Grounded Claims, OKF front matter, validation, and the HostSessionManager protocol — with no external openwiki CLI."
kind: "package-reference"
---

# @deepseek-ai/dsh-openwiki-core

English | [中文](README.zh.md)

## Summary

`dsh-openwiki-core` provides the ported openwiki 0.4.3 deterministic engine core in-process: resumable repository-page-job lifecycle, Grounded Claims, OKF front matter, Mermaid and wiki-link validation, and the transport-neutral `HostSessionManager` protocol. Choose it when a pipeline needs to generate or maintain a repository wiki without a model in the loop and without an external `openwiki` CLI; `@deepseek-ai/dsh-tool-openwiki` consumes the same core for the five lifecycle tools. It is a pure TypeScript library (only `zod` + `yaml`), and either engine writes interoperable repositories. Notable boundaries: it shells out to `git`, validates Mermaid only with optional `mermaid` + `jsdom` peers, and omits connectors and CI workflow.

## Table of Contents

- [Surface](#surface)
- [Usage](#usage)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

In-fork port of the [openwiki](https://github.com/langchain-ai/openwiki) 0.4.3 **deterministic engine core** (MIT-licensed; attribution preserved in the module headers): the model-free repository wiki machinery that upstream pairs with DeepAgents. This fork removed the DeepAgents/CLI coupling — the engine runs in-process behind a minimal `WikiFs` filesystem seam, so no external `openwiki` CLI is needed. Repositories written by either engine are interoperable because the on-disk formats are identical.

## Surface

Pure TypeScript library (only `zod` + `yaml` deps), organized as `src/*`:

- **Lifecycle** — resumable repository-page-job orchestration (`begin` / `submit_plan` / `next_page` / `submit_page` / `finish`) with a durable `.run.json` checkpoint, git source fingerprinting, update no-op detection, and a `.page-manifest.json` correctness ledger (`generation/*`, `agent/utils.ts`).
- **Claims** — Grounded Claims core (add/confirm/update/retract mutations), the code-brain store/session/runtime with `.claims/` sidecar persistence and verification, and the repository evidence resolver that maps `repo://path#L20-L48` resources to opaque `repo-lines-v1:sha256:` versions with relocation anchors (`claims/*`).
- **OKF** — OKF v0.2 front matter validation/repair, generated-event origin, index-labels, recursive concept-index synchronization, claim-sources, and claims-verification projection (`okf/*`).
- **Validation** — Mermaid fence validation (jsdom/mermaid optional, graceful heuristic fallback) and wiki-internal-link validation with broken-link stamping (`mermaid/*`, `agent/wiki-link-validator.ts`).
- **Setup + fs** — `.openwikiignore` load, managed AGENTS.md/CLAUDE.md snippets + `INSTRUCTIONS.md` wiki goal, recoverable init wiki replacement, and the in-fork `WikiFs`/`createNodeWikiFs` seam (`agent/*`, `fs/*`).
- **Integration** — the transport-neutral `HostSessionManager` + zod protocol (`openwiki_begin` … `openwiki_finish`) and Git repository-root resolution (`integrations/core/*`).

## Usage

The engine is consumed by `@deepseek-ai/dsh-tool-openwiki`, which registers the five lifecycle tools. Direct use (e.g. an automated pipeline) goes through `HostSessionManager`:

```ts
import { HostSessionManager, resolveRepositoryRoot } from '@deepseek-ai/dsh-openwiki-core'

const manager = HostSessionManager.create({ host: 'pipeline' })
const outcome = await manager.begin({ root: '/repo', mode: 'init' })
// outcome.runId → submit_plan → next_page → write page → submit_page → finish
```

## Model Experience

None, as the core library registers no tool schema, prompt section, or result of its own; every model-facing surface lives in `@deepseek-ai/dsh-tool-openwiki` over the same files these exports provide.

#### KV Cache effect

No prompt-shaping data comes from this package.

## Known Limitations and Deferred Work

- **Git required** — source fingerprinting, update windows, and root resolution shell out to `git`. A non-git directory cannot run the lifecycle (the engine still rejects it, matching upstream).
- **Mermaid/jsdom optional** — authoritative Mermaid parsing needs the optional `mermaid` + `jsdom` peers; without them, validation degrades to heuristic fence checks (the same behavior as upstream).
- **No connectors / CI workflow** — upstream's code-mode CI workflow and source connectors (`runCodeModeConnectors`) are intentionally not ported: this fork's wiki runs in-process through lifecycle tools, and connector ingestion belongs to the host process.
- **Home-directory onboarding omitted** — the wiki goal is read from the repository's own `openwiki/INSTRUCTIONS.md`; there is no global onboarding store.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
