---
description: "Model-facing agentic browser tool for agents and maintainers choosing, configuring, or debugging the `browser` tool over the host `ctx.browser` service through launch, attach, and relay backends."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-browser

English | [中文](README.zh.md)

## Summary

The model-facing browser tool resolves the host `ctx.browser` service through launch / attach / relay backends and registers one `browser` tool plus a `browser:tools` prompt section: it opens named tabs, evaluates JS, returns observations with ARIA snapshots, takes screenshots, and closes tabs, namespacing its tab keys per session so concurrent sessions never steer each other's tabs. Choose it when an agent must drive a real browser — the harness's own Web GUI included — through the shared host service. Steps are synchronous and rendered content is text-summarized, so long-running pages and pixel-accurate layout checks are the main boundaries.

## Table of Contents

- [What it does](#what-it-does)
- [ARIA refs](#aria-refs)
- [Configuration](#configuration)
- [Session isolation](#session-isolation)
- [Targeting the local harness GUI](#targeting-the-local-harness-gui)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

The model-facing agentic browser tool for the DeepSeek Harness (ported from omp / oh-my-pi), resolving the host [`ctx.browser`](../../browser/browser/README.md) service through a **launch / attach / relay** backend. Agent-plane: this package mounts as a preset row and registers no service of its own.

<a id="what-it-does"></a>
## What it does

Registers one tool (`browser`) and a `browser:tools` system-prompt section:

- **open** — navigate the named tab (`url`, `wait_until`, optional `code` to run after load), returning the observation (title, url, ARIA snapshot).
- **run** — evaluate `code` in the tab, then re-observe best-effort.
- **state** — return the current observation without navigating.
- **close** — close one tab, `all` tabs, or with `kill` the spawned browser.
- **Screenshots** — `screenshot: yes` writes a PNG (into `screenshotDir`, default `<cwd>/.dsh-browser`) and returns its path for the model to re-read.

Backends mirror omp's `app` object: `app.path` spawns a stealth-patched browser, `app.cdp_url` attaches to an existing CDP endpoint, `app.relay` drives the user's own tabs through the local relay + extension.

<a id="aria-refs"></a>
## ARIA refs

Every observation carries a Playwright ARIA snapshot with `[ref=eN]` ids. The ids are renumbered per snapshot and remain valid until the next one; address elements by CSS selector as a fallback. Prefer the snapshot over a screenshot when pixels don't matter — snapshots are cheap, screenshots are not.

<a id="configuration"></a>
## Configuration

- `cwd` — default working directory (session header first; default process cwd).
- `maxAriaChars` — ARIA snapshot cap returned to the model (default 20000).
- `screenshotDir` — screenshot output directory (default `<cwd>/.dsh-browser`).
- `waitUntil` — default wait condition (`load`).
- `timeoutSeconds` — default per-call timeout (30).

<a id="session-isolation"></a>
## Session isolation

The `browser` service is shared host-plane; the tool namespaces its tab key per session id, so concurrent sessions never steer each other's tabs.

<a id="targeting-the-local-harness-gui"></a>
## Targeting the local harness GUI

The tool is URL-agnostic, so it can also drive the harness's own Web GUI (`dsh web`, `http://127.0.0.1:3080`): `launch` a browser or `attach` to a running Chrome, navigate to the local origin, and work the GUI's session-history and review surfaces directly. That closes the loop for the same corpus — a session is readable as a URL (`session://<id>`), as tool results (`session_query`), and as screen pixels (browser → GUI) without any special casing in the tool.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

`dsh-tool-browser` owns the browser-automation schema and result rendering; see [`@deepseek-ai/dsh-tool-browser`](../../../docs/tool-catalog.md#deepseek-aidsh-tool-browser) for the registered entry points.

#### Token effect

Schema tokens per request while the plugin is mounted; successful navigation and read steps return compact summaries.

#### KV Cache effect

The plugin adds no request-prefix text of its own; provider cache reuse follows consumer prompts that mention browser state.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Execution is synchronous per step; long-running pages need explicit timeouts or `stop`.
- Rendered content is text-summarized for the model; pixel-accurate layout checks are not supported.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
