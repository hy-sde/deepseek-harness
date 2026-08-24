# @deepseek-ai/dsh-tool-browser

English | [中文](README.zh.md)

The model-facing agentic browser tool for the DeepSeek Harness (ported from omp / oh-my-pi), resolving the host [`ctx.browser`](../../browser/browser/README.md) service through a **launch / attach / relay** backend. Agent-plane: this package mounts as a preset row and registers no service of its own.

## What it does

Registers one tool (`browser`) and a `browser:tools` system-prompt section:

- **open** — navigate the named tab (`url`, `wait_until`, optional `code` to run after load), returning the observation (title, url, ARIA snapshot).
- **run** — evaluate `code` in the tab, then re-observe best-effort.
- **state** — return the current observation without navigating.
- **close** — close one tab, `all` tabs, or with `kill` the spawned browser.
- **Screenshots** — `screenshot: yes` writes a PNG (into `screenshotDir`, default `<cwd>/.dsh-browser`) and returns its path for the model to re-read.

Backends mirror omp's `app` object: `app.path` spawns a stealth-patched browser, `app.cdp_url` attaches to an existing CDP endpoint, `app.relay` drives the user's own tabs through the local relay + extension.

## ARIA refs

Every observation carries a Playwright ARIA snapshot with `[ref=eN]` ids. The ids are renumbered per snapshot and remain valid until the next one; address elements by CSS selector as a fallback. Prefer the snapshot over a screenshot when pixels don't matter — snapshots are cheap, screenshots are not.

## Configuration

- `cwd` — default working directory (session header first; default process cwd).
- `maxAriaChars` — ARIA snapshot cap returned to the model (default 20000).
- `screenshotDir` — screenshot output directory (default `<cwd>/.dsh-browser`).
- `waitUntil` — default wait condition (`load`).
- `timeoutSeconds` — default per-call timeout (30).

## Session isolation

The `browser` service is shared host-plane; the tool namespaces its tab key per session id, so concurrent sessions never steer each other's tabs.

## Targeting the local harness GUI

The tool is URL-agnostic, so it can also drive the harness's own Web GUI (`dsh web`, `http://127.0.0.1:3080`): `launch` a browser or `attach` to a running Chrome, navigate to the local origin, and work the GUI's session-history and review surfaces directly. That closes the loop for the same corpus — a session is readable as a URL (`session://<id>`), as tool results (`session_query`), and as screen pixels (browser → GUI) without any special casing in the tool.
