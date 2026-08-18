# @deepseek-ai/dsh-web-search-public

English | [中文](README.zh.md)

A credential-free `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). With no API key or environment variable, it chains five public search engines — Startpage first, then DuckDuckGo → Ecosia → Google → Mojeek — and returns the first engine that yields results. If an engine returns no results, times out, or is bot-challenged, the chain advances to the next engine, so searches keep working as long as at least one engine responds.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). It is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

| Key | Default | Meaning |
|---|---|---|
| `timeoutMs` | `10000` | Per-engine transport timeout (ms), applied as a race so a hung engine cannot pin the call. Must be at least 1000. The chain's worst case is `engines.length × timeoutMs` (50 s with the default five engines). |
| `engines` | `startpage, duckduckgo, ecosia, google, mojeek` | Engine ids tried in this exact order. Unlisted engines stay disabled; duplicate ids are dropped. |
| `userAgent` | browser-shaped constant | User-Agent sent to the engines. These public endpoints expect a browser-shaped UA; override it if a stricter policy applies. |

```yaml
- id: web-search-public
  name: '@deepseek-ai/dsh-web-search-public'
  config:
    timeoutMs: 10000
```

## Mapping

Each engine's static-HTML result page is reduced to `WebSearchSource` entries: `url` ← the result link (DuckDuckGo `uddg` and Google `/url?q=` redirect wrappers are unwrapped), `title` ← the visible result heading text, `snippet` ← the result excerpt (DuckDuckGo `result__snippet`, Startpage `w-gl__description`, Ecosia `result__quote`, Google `VwiC3b`, Mojeek `p.s`), `publishedAt` ← DuckDuckGo result timestamps (date prefix). Engines never synthesize `content`; the final bound is enforced by the seam, and `maxResults` is handed to the engines as a bound. Requests carry no credentials, and HTTP redirects are rejected before the `Location` target is contacted (the web-package AGENTS.md rule).

The provider runs the engines in configured order and returns the first one that yields at least one source. Zero-result pages, per-engine timeouts, and engine failures (transport errors, non-2xx responses, bot-challenge pages that parse to nothing) all advance the chain. Only when every engine fails does the call surface a `WebError` `WEB_PROVIDER_ERROR` whose message aggregates each engine's reason; a caller-aborted request surfaces as `WEB_ABORTED`. `available()` is true whenever at least one engine is configured — no credential gate exists to fail.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's maxResults-bounded URLs, titles, snippets, and publication dates or its aggregate `all public search engines failed: ...` failures under the consumer's error wrapper while generated answers and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Anonymous engines can bot-challenge without notice** — Startpage and Google in particular frequently serve consent or CAPTCHA pages instead of results; the chain advances on such pages, but a query can still end in the aggregate failure when every engine is challenged at once.
- **Parsers are best-effort structural scrapes of specific HTML shapes** — engines occasionally change markup; a changed shape yields zero results for that engine rather than malformed data, so the chain degrades rather than corrupts.
- **No `content` synthesis** — engines return sources only; the seam's generated-answer surface stays unset.
- **Google is last and most fragile** — kept for coverage behind the consent-cookie scrape, and can be retired from the order without touching the chain contract.
