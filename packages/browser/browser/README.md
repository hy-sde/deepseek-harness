---
description: "The host `ctx.browser` service for agents and maintainers choosing, configuring, or debugging launch, attach, and relay browser backends over Chrome DevTools Protocol."
kind: "package-reference"
---

# @deepseek-ai/dsh-browser

English | [中文](README.zh.md)

## Summary

The host `ctx.browser` service owns real browser connections over Chrome DevTools Protocol through four backends: `launch` (stealth-patched browser), `patch` (CloakBrowser Chromium — source-level C++ fingerprint patches; preferred default), `attach` (existing CDP endpoint), and `relay` (the user's own Chrome tabs via an in-process relay plus an MV3 extension). On those connections it opens and navigates tabs, evaluates JS, returns ARIA snapshots with stable `[ref=eN]` ids, and closes tabs. `@deepseek-ai/dsh-tool-browser` is its intended consumer. The cost is one connection per cwd+kind with no launch/teardown policy; stealth features are not a security boundary.

## Table of Contents

- [What it does](#what-it-does)
- [Backends](#backends)
- [Configuration](#configuration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

The host `ctx.browser` service for the agentic browser tool (ported from omp / oh-my-pi): it owns real browser connections over Chrome DevTools Protocol through [playwright-core CDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp), with four backends — **launch** (stealth-patched browser binary), **patch** (the CloakBrowser Chromium via the `cloakbrowser` npm dependency: source-level C++ fingerprint patches and per-session randomization), **attach** (existing CDP endpoint via `cdp_url`), and **relay** (the user's own Chrome tabs through an in-process relay server + companion MV3 extension). Intended to be consumed by [`@deepseek-ai/dsh-tool-browser`](../tool-browser/README.md), never by the model directly.

<a id="what-it-does"></a>
## What it does

Registers one host service on the composition (`ctx.browser`). The surface:

- **Backends** — `resolveKind` maps a tool request to `launch` / `attach` / `relay`, mirroring omp's kind resolution (`app.path` → spawn, `app.cdp_url` → attach, `app.relay` / `DSH_BROWSER_RELAY` → relay); `ensureRelay` starts the in-process relay server (default `http://127.0.0.1:9224`, ephemeral port fallback).
- **Tabs** — `open` navigates a named tab (one tab per name, one browser connection per cwd+kind); `run` evaluates JS in a tab; `observe` returns title/url/size + an ARIA snapshot with `[ref=eN]` ids; `click`/`type` address elements by ARIA ref or CSS selector; `screenshot` writes a PNG; `close` closes tabs and, with `kill`, spawned browsers.
- **Stealth** — the 14 omp-puppeteer init scripts run in every launched page (`src/stealth-scripts.ts`, generated), the machine-tell launch flags are suppressed, and a spoofed user-agent + client-hints override is applied on the browser CDP session.

The ARIA snapshot is produced by the bundled Playwright ARIA-snapshot sources (Apache-2.0, Microsoft) vendored as `src/aria-bundle.ts` — the same generated bundle omp uses — so every snapshot carries actionable `[ref=eN]` ids that stay valid until the next snapshot.

<a id="backends"></a>
## Backends

| kind | resolution | browser |
| --- | --- | --- |
| `launch` | `app.path` (or `browserPath` config) | `chromium.launch({ executablePath, headless, args: STEALTH_LAUNCH_ARGS, ignoreDefaultArgs })` |
| `patch` | `app.patch` / `usePatch` config (default here) | `cloakbrowser.launch(...)` — the CloakBrowser Chromium (71 source-level C++ fingerprint patches, per-session randomization) |
| `attach` | `app.cdp_url` | `chromium.connectOverCDP(cdpUrl)` — any real Chrome family endpoint |
| `relay` | `app.relay` / `DSH_BROWSER_RELAY=1` | `chromium.connectOverCDP(relay)` — the relay impersonates Chrome's CDP discovery |

The `patch` backend launches the CloakBrowser Chromium through the `cloakbrowser` npm dependency — a drop-in Playwright wrapper that returns a regular `playwright-core` `Browser` (same instance the service drives). Its fingerprint randomization happens at the C++ layer per session, so the JS-level stealth scripts and UA override are deliberately NOT applied on this backend. The first launch auto-downloads the patched Chromium (~200 MB, cached under `~/.cloakbrowser/`); `patchOptions` can pass `proxy`, `geoip` (match timezone+locale to the proxy IP), and `humanize` (human-like input). Anti-detection raises the bar, it does not make a site accessible.

The relay (`src/relay/server.ts`, `bridge.ts`, a port of omp's) binds loopback, serves `GET /json/version` (503 until the extension connects), `GET /json`, `WS /cdp` (downstream CDP clients), `WS /ext` (the extension, token-gated when configured), and `GET /ext-assets/*` so the extension can be sideloaded from `chrome://extensions` → Load unpacked. The bridge multiplexes every downstream CDP connection over the extension's one `chrome.debugger` attachment per tab with minted session ids — the same design as `omp browser-relay` (MIT).

<a id="configuration"></a>
## Configuration

- `browserPath` — default executable for `launch` (optional; Playwright resolves one).
- `usePatch` — default to the CloakBrowser backend (true in the base bundle row).
- `patchOptions` — CloakBrowser launch flags: `proxy` (URL), `geoip` (bool), `humanize` (bool).
- `headless` — default headless (true).
- `viewport` — launch viewport (default 1365×768 @ 1.25).
- `relayUrl` / `relayToken` — relay endpoint and optional extension token.
- `timeoutMs` — default navigation timeout (30000).

The service is host-plane, holds no durable state, and is disposed with its owning context (closes its browsers and stops the relay).

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The service owns no launch/teardown policy for browser processes; consumers must scope and dispose their own sessions.
- Stealth and fingerprint features target common automation detectors and are not a security boundary.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
