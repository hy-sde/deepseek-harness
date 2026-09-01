---
type: Reference
title: LLM Capability Family
description: The LLM capability family of DeepSeek Harness — the provider-neutral ctx.llm service, the shared message and stream vocabulary, the DeepSeek and pi-ai provider adapters, retry execution, and replay-aware token measurement.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-2f176bb02578b94d15e791fb
    resource: repo://docs/subsystems/llm-streaming.md
  - id: openwiki-source-f6e7ab149827dbc24f433320
    resource: repo://packages/llm/llm-pi-ai/README.md
  - id: openwiki-source-e28ce0fcdf9696975f068d7c
    resource: repo://packages/llm/llm-retry/README.md
  - id: openwiki-source-63d44ba0619b86f70e7b950e
    resource: repo://packages/llm/llm/README.md
  - id: openwiki-source-8ba8064206a9b769f5572dfb
    resource: repo://packages/llm/README.md
  - id: openwiki-source-0ea6db138a083b7369169518
    resource: repo://packages/llm/token-meter/README.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# LLM Capability Family

The llm group provides the harness's model-call capability: one provider-neutral service through which any composition streams requests to a model provider, plus adapters, provider-specific request metadata, retry execution, and measurement. The core `llm` package defines the message, content-block, and stream-chunk vocabulary every plugin and the session log use; provider adapters translate a provider's wire format into that vocabulary; DeepSeek request-extension plugins contribute lifecycle-owned metadata outside model input; `llm-retry` re-runs failed requests at durable agent-step boundaries; and `token-meter` measures request and context pressure from the durable log.

## Packages

| Package | Role | ctx key |
| --- | --- | --- |
| `llm/` | Streams one model call through a registered provider adapter and shares the harness message, block, and chunk vocabulary | `ctx.llm` |
| `llm-deepseek/` | Serves the `deepseek-official` route with direct DeepSeek chat-completions, thinking, and image input | registers on `ctx.llm` |
| `llm-pi-ai/` | Serves configured provider routes through pi-ai catalogs and wire protocols, including hand-declared gateways | registers on `ctx.llm` |
| `deepseek-llm-api-extensions/` | Registers lifecycle-owned top-level fields on official DeepSeek requests | `ctx.deepseekLlmApiExtensions` |
| `plugin-package-inventory-deepseek/` | Contributes the active Loader package inventory to official DeepSeek requests | contributes `dsh_plugin_packages` |
| `llm-retry/` | Retries failed model requests under each provider's policy at durable agent-step boundaries | listens to `agent/request-error` |
| `token-meter/` | Measures request and context pressure from the durable session log with a fixed heuristic | `ctx.tokenMeter` |

## The service and vocabulary

`dsh-llm` is the provider-neutral model-call service at the center of the harness's LLM capability: every composition that streams a request to a model provider goes through it, and it owns the shared vocabulary — messages, content blocks, and raw stream chunks — that the agent loop, session log, and every plugin speak. With it you can register provider adapters, stream one model call, list and discover models, resolve exact-model metadata and call defaults, and capture each provider's retry policy. It executes no retries and owns no provider wire logic; adapters translate their provider's format, and the optional `dsh-llm-retry` package re-runs failed requests at durable step boundaries. Requests are deep-frozen before dispatch, so middleware and adapters can read them but never rewrite them, and every request is logged so it stays reconstructable from the session log.

A conversation is `Message`s; a message is an array of typed **content blocks**. The block union is merge-extensible and currently covers `text`, `reasoning` (thinking, distinct from visible text), `image` (a durable image attachment), `tool-call`, and `tool-result`. A new modality belongs in the merge-extensible map only when its adapter, UI, compaction, and durable replay paths honor it.

## The streaming protocol

A streaming response interleaves typed deltas (text, reasoning, multiple tool calls) over a **closed** discriminated union `StreamChunk`: `block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `block-end` (carrying the fully assembled `ContentBlock`), `usage`, and `finish`. `index` ties each delta to its block. Adapters emit usage before the terminal finish and nothing afterward; tool arguments remain raw JSON strings. An adapter may throw, but `LlmRuntime.stream()` normalizes that failure to a terminal `error` or `aborted` finish before exposing it to consumers.

## Provider adapters

`llm-pi-ai` is the pi-ai-backed multi-provider adapter: one plugin instance owns a dictionary of provider routes, each served through pi-ai. A route naming an installed pi-ai provider inherits its endpoint, wire protocol, and model catalog as defaults; a route pi-ai does not ship is declared outright, so an OpenAI-compatible gateway or self-hosted server is configuration, not a code change. Profiles and credentials resolve per request over the optional settings and credential seams, so editing the user settings document changes the next request without a restart. The plugin can mount dormant with zero routes and activate them the moment a settings section supplies profiles. `llm-deepseek` serves the direct `deepseek-official` route with chat-completions, thinking, and image input.

## Retry and measurement

`llm-retry` applies each provider's resolved retry policy at the agent loop's open-step `agent/request-error` extension point, so every retry re-runs the same step inside the same open turn over the same durable history. It does not wrap the streaming call itself — every adapter call remains one provider attempt. Retry scheduling is durable: the plugin appends `llm/retry` events to the session log before waiting, and cancellation during backoff leaves the log consistent. Normal mode retries a bounded set of failure codes up to `maxRetries` with exponential backoff; always mode asks downstream recovery first, then retries every failure without an attempt limit.

`token-meter` is the replay-aware token measurement service: `ctx.tokenMeter` advances one isolated fold per session from the durable event log, so compaction and other pressure-sensitive plugins share one accounting. It measures current request and context pressure, prices a single message, uses a fixed heuristic for text and routes without image pricing, applies adapter-declared visual-token pricing when available, and reuses provider-reported usage only when the request envelope matches exactly. It adds no prompt, message, schema, or tool of its own, and never makes decisions for the loop.

The seam surface is complete with the `llm/stream` waterfall (dispatched by `llm`, listened to by the loop and others) and the `llm/adapters-updated` emit.

## Related pages

- [Capability Seams](../architecture/seams.md) — the seam pattern behind `ctx.llm`.
- [Session, Step and Turn Lifecycle](../architecture/turn-flow.md) — how the loop consumes the stream.
- [Sandbox, Subprocess and Terminal Execution](sandbox-execution.md) — the execution world beside routing.
