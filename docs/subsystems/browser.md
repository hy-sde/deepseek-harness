# Agentic browser

English | [中文](browser.zh.md)

The browser seam is split across a Host Service ([dsh-browser](../../packages/browser/browser), `ctx.browser`) and a Consumer ([dsh-tool-browser](../../packages/browser/tool-browser), the `browser` tool). The service owns real browser connections over Chrome DevTools Protocol through Playwright Core CDP — ported from omp's browser tool with stealth + relay/CDP-attach (see [port_omp.md](../../port_omp.md)). The tool layer owns the model-facing contract; the relay shares its design with `omp browser-relay` (MIT).

Source: [`packages/browser/browser/src/service.ts`](../../packages/browser/browser/src/service.ts)

## Service surface

`ctx.browser` is host-plane: one instance serves every session, holds no durable state, and is disposed with its owning context (closing its browsers and stopping the relay). Its verbs mirror the omp browser surface reduced to what the model actually needs:

- **Backends** — `resolveKind` maps a request to `launch` (`app.path` spawns a stealth-patched browser), `attach` (`app.cdp_url` connects to an existing CDP endpoint), or `relay` (`app.relay` / `DSH_BROWSER_RELAY=1` drives the user's own tabs). `ensureRelay` starts the in-process relay server (default `http://127.0.0.1:9224`, ephemeral port fallback).
- **Tabs** — `open` navigates a named tab; `run` evaluates JS in a tab; `observe` returns title/url/size + an ARIA snapshot with `[ref=eN]` ids; `click`/`type` address elements by ARIA ref or CSS selector; `screenshot` writes a PNG; `close` closes tabs and, with `kill`, spawned browsers.
- **Stealth** — the 14 omp-puppeteer init scripts run in every launched page, the machine-tell launch flags are suppressed, and a spoofed user-agent + client-hints override is applied on the browser CDP session.

## ARIA refs

Every observation is a Playwright ARIA snapshot with `[ref=eN]` ids (the bundled ARIA-snapshot sources run in the page's main world, same technique as omp). Ids are renumbered per snapshot and stay valid until the next one; CSS selectors remain available as a fallback. Screenshots are written as PNG paths the model can re-read.

## Relay

`src/relay/server.ts` + `bridge.ts` (a port of omp's) impersonate Chrome's CDP discovery endpoint on loopback: `GET /json/version` (503 until the extension connects), `GET /json`, `WS /cdp` (downstream CDP clients), `WS /ext` (the extension, token-gated when configured), and `GET /ext-assets/*` for sideloading the extension. The companion MV3 extension (assets under `src/assets`) owns one `chrome.debugger` attachment per tab; the bridge multiplexes every downstream connection over it with minted session ids.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowser--browserservice"></a>

### `ctx.browser` — `BrowserService`

One browser connection per (cwd + kind), one tab per name.

```ts cordis-catalog
/**
 * The relay endpoint this instance serves (created lazily in relay kind).
 * @returns the relay base URL this instance binds or resolves.
 */
relayEndpoint(): string

/**
 * Resolve the browser kind for a session (attach/launch/relay), like omp.
 * @param input - optional app-path, cdp URL, or explicit relay opt-in.
 * @returns the resolved {@link BrowserKind} to drive.
 */
resolveKind(input: { path?: string; cdpUrl?: string; relay?: boolean }): BrowserKind

/**
 * Ensure the relay server is running for this instance (idempotent).
 * @returns the relay base URL the in-process server is bound to.
 */
async ensureRelay(): Promise<string>

/**
 * Open (or navigate) a named tab to `url`; returns the page observation.
 * @param name - tab id; one tab per name, one browser per cwd+kind.
 * @param url - the URL to navigate to.
 * @param opts - backend kind, working directory, wait condition, timeout.
 * @returns the page observation (title, url, ARIA snapshot, size).
 */
async open( name: string, url: string, opts: { kind: BrowserKind cwd: string waitUntil?: WaitUntil timeoutMs?: number }, ): Promise<PageObservation>

/**
 * Evaluate `code` in the named tab and return the JSON-serializable value.
 * @param name - tab id.
 * @param code - JavaScript body/expression evaluated in the tab's page.
 * @param opts - backend kind, working directory, timeout.
 * @returns the evaluated value (JSON-serializable).
 */
async run( name: string, code: string, opts: { kind: BrowserKind; cwd: string; timeoutMs?: number }, ): Promise<unknown>

/**
 * Click an ARIA-ref (`aria-ref=e5`) or CSS selector in the named tab.
 * @param name - tab id.
 * @param selector - ARIA ref selector or CSS selector.
 * @param opts - backend kind, working directory.
 * @returns the re-observed page after the click.
 */
async click( name: string, selector: string, opts: { kind: BrowserKind; cwd: string }, ): Promise<PageObservation>

/**
 * Type text into an ARIA-ref or CSS selector in the named tab.
 * @param name - tab id.
 * @param selector - ARIA ref selector or CSS selector.
 * @param text - the text to fill.
 * @param opts - backend kind, working directory.
 * @returns the re-observed page after the fill.
 */
async type( name: string, selector: string, text: string, opts: { kind: BrowserKind; cwd: string }, ): Promise<PageObservation>

/**
 * Close named tabs; `all` closes every tab, `kill` also closes browsers.
 * @param name - tab id.
 * @param opts - backend kind, working directory, close-all and kill flags.
 * @returns a promise resolving once the close is initiated.
 */
async close(name: string, opts: { kind: BrowserKind; cwd: string; all?: boolean; kill?: boolean }): Promise<void>

/**
 * Screenshot the named tab to a PNG file; returns the written path.
 * @param name - tab id.
 * @param destination - the PNG file path to write.
 * @param opts - backend kind, working directory, full-page flag.
 * @returns the written screenshot path.
 */
async screenshot( name: string, destination: string, opts: { kind: BrowserKind; cwd: string; fullPage?: boolean }, ): Promise<ScreenshotResult>

/**
 * Observe the named tab (title, url, size, ARIA snapshot) without navigating.
 * @param name - tab id.
 * @param opts - backend kind, working directory.
 * @returns the page observation.
 */
async observe(name: string, opts: { kind: BrowserKind; cwd: string }): Promise<PageObservation>

/** Close every browser connection and stop the relay (cleanup on ctx dispose). */
stop(): void
```

Source: [`packages/browser/browser/src/service.ts`](../../packages/browser/browser/src/service.ts)
<!-- END GENERATED cordis-surface -->

## Usage

Register the host row in the bundle (`browser`) and the tool row in an agent preset (`tool-browser`, no realm — it only consumes the host instance). The tool namespaces its tab key per session id, so concurrent sessions never steer each other's tabs.
