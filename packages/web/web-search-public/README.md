---
description: "Credential-free WebSearchProvider for the harness web seam: fans one query to five public engines in parallel and consolidates results by cross-engine consensus, no API key required."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-public

English | [中文](README.zh.md)

## Summary

`dsh-web-search-public` is a credential-free `WebSearchProvider` for the harness web seam (`ctx.web`): with no API key or environment variable it fans one query out to five public engines in parallel — Startpage, DuckDuckGo, Ecosia, Google, and Mojeek — and consolidates the answers by cross-engine consensus, so no single engine's challenge, timeout, or slow response blocks or degrades the search. Choose it when a deployment wants public web search with zero setup and tolerance for engine failures; it registers the provider only and owns no model-facing tool — that is `dsh-tool-web`'s job. Its costs are a latency floor for consensus and multiplied anonymous requests that raise bot-challenge exposure, and its best-effort parsers can see engines change markup or challenge without notice.

## Table of Contents

- [Config](#config)
- [Mapping](#mapping)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

A credential-free `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). With no API key or environment variable, it fans one query out to five public search engines in parallel — Startpage, DuckDuckGo, Ecosia, Google and Mojeek — and consolidates the answers by cross-engine consensus, so no single engine's challenge, timeout, or slow response can block or degrade the search. This is a faithful port of oh-my-pi's `searchPublicWeb` aggregate.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). It is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

| Key | Default | Meaning |
|---|---|---|
| `timeoutMs` | `10000` | Per-engine transport timeout (ms), applied as a race so a hung engine cannot pin the call. Must be at least 1000. Bounds one engine even if it ignores aggregate cancellation; the call itself is bounded by the deadlines below. |
| `engines` | `startpage, duckduckgo, ecosia, google, mojeek` | Engine ids the fan-out races concurrently; this order is the tiebreak for consensus ties. Unlisted engines stay disabled; duplicate ids are dropped. |
| `userAgent` | browser-shaped constant | User-Agent sent to the engines. These public endpoints expect a browser-shaped UA; override it if a stricter policy applies. |
| `softDeadlineMs` | `5000` | Soft aggregate deadline (ms): return as soon as every engine settled, or when this passes with at least one success in hand. If it passes with no success yet, the call keeps waiting (up to the hard deadline) for the first success. |
| `hardDeadlineMs` | `30000` | Hard aggregate deadline (ms): return whatever we have, even nothing, so one pathologically slow engine can never pin the call to the 60 s search-tool budget. Must be `>= softDeadlineMs`. |

```yaml
- id: web-search-public
  name: '@deepseek-ai/dsh-web-search-public'
  config:
    timeoutMs: 10000
    softDeadlineMs: 5000
    hardDeadlineMs: 30000
```

## Mapping

Each engine's static-HTML result page is reduced to `WebSearchSource` entries: `url` ← the result link (DuckDuckGo `uddg` and Google `/url?q=` redirect wrappers are unwrapped), `title` ← the visible result heading text, `snippet` ← the result excerpt (DuckDuckGo `result__snippet`, Startpage `w-gl__description`, Ecosia `result__quote`, Google `VwiC3b`, Mojeek `p.s`), `publishedAt` ← DuckDuckGo result timestamps (date prefix). Engines never synthesize `content`; the final bound is enforced by the seam, and `maxResults` is handed to the engines as a bound. Requests carry no credentials, and HTTP redirects are rejected before the `Location` target is contacted (the web-package AGENTS.md rule).

The provider fans the query out to every engine concurrently and consolidates the results: URLs are case/`www.`/trailing-slash-normalized and deduplicated across engines, then ranked by cross-engine consensus (how many engines returned a URL), then by best per-engine rank, then by engine order — so a URL both Startpage and DuckDuckGo returned outranks a single-engine hit, and a tie within the same rank goes to the earlier engine. The most informative snippet (longest available) wins; the earlier engine's title/URL win equal-rank ties. The fan-out races three exits and returns at the earliest — every engine settled, soft deadline with a success in hand, or (waiting past the soft deadline for a first success if none arrived and not everything failed) the hard deadline — then aborts every still-running engine. Individual engine failures (transport errors, non-2xx responses, bot-challenge pages) and zero-result pages are tolerated: the call fails with a `WebError` `WEB_PROVIDER_ERROR` whose message aggregates each engine's reason only when *every* engine fails; a caller-aborted request surfaces as `WEB_ABORTED`. `available()` is true whenever at least one engine is configured — no credential gate exists to fail.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's consensus-merged, maxResults-bounded URLs, titles, snippets, and publication dates or its aggregate `all public search engines failed: ...` failures under the consumer's error wrapper while generated answers and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Parallel fan-out multiplies anonymous requests** — every search contacts all five engines at once (up to 5 concurrent scrapes per query), which raises bot-challenge and per-host rate-limit exposure compared with a single-engine fallback chain. Challenged engines degrade the aggregate rather than fail it, but a heavily rate-limited network can see more challenges, not fewer.
- **Consensus costs a latency floor** — the aggregate deliberately waits for stragglers up to the soft deadline (5 s by default) to enrich consensus; a single slow engine holds the call until the soft window even when another engine already answered. Lower `softDeadlineMs` for lower latency at the cost of thinner consensus.
- **Anonymous engines can bot-challenge without notice** — Startpage and Google in particular frequently serve consent or CAPTCHA pages instead of results; the fan-out absorbs such pages as empty engine answers, but a query can still end in the aggregate failure when every engine is challenged at once.
- **Parsers are best-effort structural scrapes of specific HTML shapes** — engines occasionally change markup; a changed shape yields zero results for that engine rather than malformed data, so the aggregate degrades rather than corrupts.
- **No `content` synthesis** — engines return sources only; the seam's generated-answer surface stays unset.
- **Google is the most fragile engine** — kept for coverage behind the consent-cookie scrape, and can be retired from the engine list without touching the aggregate contract.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
