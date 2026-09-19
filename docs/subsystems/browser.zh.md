# Agentic 浏览器

[English](browser.md) | 中文

浏览器 seam 分为宿主服务（[dsh-browser](../../packages/browser/browser)，`ctx.browser`）与消费方（[dsh-tool-browser](../../packages/browser/tool-browser)，`browser` 工具）。服务经 Playwright Core CDP 持有真实浏览器连接 — 移植自 omp 的浏览器工具（stealth＋relay／CDP-attach）。工具层掌管模型方契约；relay 与 `omp browser-relay`（MIT）同一设计。

源码：[`packages/browser/browser/src/service.ts`](../../packages/browser/browser/src/service.ts)

## 服务面

`ctx.browser` 位于宿主平面：一个实例服务所有会话，不持有持久状态，随其所属上下文销毁（关闭浏览器并停止 relay）。其动词对应 omp 浏览器面中模型真正需要的部分：

- **后端** — `resolveKind` 把请求映射为 `launch`（`app.path` 派生 stealth 补丁浏览器）、`attach`（`app.cdp_url` 接入既有 CDP 端点）、或 `relay`（`app.relay`／`DSH_BROWSER_RELAY=1` 驱动用户自己的标签页）。`ensureRelay` 启动进程内 relay 服务器（默认 `http://127.0.0.1:9224`，端口占用时回退临时端口）。
- **标签页** — `open` 导航命名标签页；`run` 在标签页内求值 JS；`observe` 返回 title／url／尺寸＋带 `[ref=eN]` id 的 ARIA 快照；`click`／`type` 按 ARIA ref 或 CSS 选择器寻址元素；`screenshot` 写出 PNG；`close` 关闭标签页，配合 `kill` 还关闭所派生的浏览器。
- **Stealth** — 14 段 omp-puppeteer init 脚本注入每个启动的页面，压制机显启动参数，并在浏览器 CDP session 上应用伪装 UA＋client-hints 覆盖。

## ARIA ref

每次观察都是带 `[ref=eN]` id 的 Playwright ARIA 快照（打包的 ARIA-snapshot 源码运行于页面主世界，与 omp 同技巧）。id 每张快照重新编号，在下一次快照前保持有效；CSS 选择器始终可用作后备。截图写为 PNG 路径供模型再读。

## Relay

`src/relay/server.ts`＋`bridge.ts`（omp 移植）在回环地址上冒充 Chrome 的 CDP discovery 端点：`GET /json/version`（扩展接入前 503）、`GET /json`、`WS /cdp`（下游 CDP 客户端）、`WS /ext`（扩展，可配置 token 门禁）、以及 `GET /ext-assets/*`（侧载扩展用）。配套 MV3 扩展（`src/assets` 下的资源）对每个标签页持有一个 `chrome.debugger` 附着；bridge 以铸造 session id 的方式复用每条下游连接。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
resolveKind(input: { path?: string; cdpUrl?: string; relay?: boolean; patch?: boolean }): BrowserKind

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
 * Scrape one URL in a dedicated browser (launch or CloakBrowser patch — never
 * relay/attach, which belong to other owners). Used by credential-free web
 * search engines as the challenge-fallthrough transport: optional home-page
 * seeding for cookies, then navigate, optionally wait for a ready selector,
 * and return the rendered HTML plus response status and final URL.
 * @param url - target URL.
 * @param options - home-page seed, ready selector, per-navigation timeout.
 * @returns rendered HTML, HTTP status of the last navigation, final page URL.
 */
async fetchPageHtml( url: string, options?: { homeUrl?: string ready?: { selector: string; timeoutMs: number } timeoutMs?: number signal?: AbortSignal /** Mojeek-style ALTCHA interstitial: click its checkbox, wait for the PoW redirect to show results. */ altcha?: { resultsSelector: string; waitMs: number } }, ): Promise<{ html: string; status: number; url: string }>

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

## 使用

在 bundle 中注册宿主行（`browser`），在 agent 预设中注册工具行（`tool-browser`，不带 realm — 只消费宿主实例）。工具把标签页键按会话 id 命名空间隔离，因此并发会话不会互相夺走标签页。
