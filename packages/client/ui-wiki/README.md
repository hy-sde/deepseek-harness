---
description: "Browser-side wiki drawer for the LLM-wiki workflow: a frame-wide floating panel toggled from the sidebar foot that browses and edits the host Logseq graph, with pages, blocks, tags, and search behind a shared store."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-wiki

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-wiki` adds an embedded wiki drawer to the LLM-wiki workflow: a frame-wide floating panel toggled from the sidebar foot that browses and edits the host `wikiGraph` Logseq graph, with no desktop Logseq. Pages, blocks, tags, and search live behind a shared store with a typed wire face over the connection's `wiki` api-proxy domain. It registers two additive slots, `sidebar.footer.action` and `shell.overlay`, so mounting it never changes the host or the model plane. Choose it when the model's wiki work should stay inside the GUI; the model's own graph work runs through `@deepseek-ai/dsh-tool-logseq`, never through this drawer.

## Table of Contents

- [Surfaces](#surfaces)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Embedded wiki drawer for the LLM-wiki workflow: a frame-wide floating panel toggled from the sidebar foot that browses and edits the Logseq graph served by the host `wikiGraph` service — no desktop Logseq. Pages, blocks, tags, and search live behind a shared store with a typed wire face over the connection's `wiki` api-proxy domain.

## Surfaces

- `sidebar.footer.action` — the **Wiki** toggle (wide label; rail shows a glyph only).
- - `shell.overlay` — the floating **LLM Wiki** drawer: search, page list with inline creation, page view with a recursive outliner (inline block editing, add-child, delete, and page deletion) and linked references.

Slot registrations are additive — mounting this package never changes the host or the model plane.

## Model Experience

None, as the drawer is a browser-only surface; the model's own wiki work runs through `@deepseek-ai/dsh-tool-logseq` and never through this package.

#### KV Cache effect

No prompt-shaping data comes from this package.

## Known Limitations and Deferred Work

- - **Requires the host service** — mounts against `ctx.wikiGraph` (via the `wiki` apiproxy domain); without it every call answers a clean "wiki service absent" error.
- - **CLI-backed latency** — every read/write spawns the `logseq` CLI process; the drawer shows loading/busy states but is not virtualized, so very large pages cost a full re-render.
- - **Property values are refs** — displayed inline as `key:: value`, edited via block text; the full property-value editor stays CLI-side.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
