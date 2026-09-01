# Agent Note: Device tools over the `dyn` catalog transport

Status: implemented

English | [中文](2026-09-01-catalog-tools.zh.md)

## Problem

A large tool surface costs the model context at every session start: every visible schema lands in the system prompt, and the fork's model-visible tool count already exceeds one hundred. The prompt-scale answer already exists in omp in two generations — `master`'s TypeScript `xd://` discovery transport and `omp2`'s Rust `dyn` device transport — but the fork had no port of either, so a porting ground with a growing catalog had no way to keep long-tail tools out of the prompt without dropping their reachability entirely. The question that framed this work was whether a growing tool list eats context and how discovery-first presentation should work.

## Decision

Catalog presentation is a value of the existing `ToolPresentationMode`, not a new preset: `'native' | 'ptc' | 'both' | 'catalog'`. Tools opt in by declaring `device: true` on their definition; under `catalog` the registry keeps device schemas out of the prompt wire and exposes them through a reserved `dyn` transport (`search` / `docs` / `invoke`), modeled on `omp2`'s `device.rs` budgets (per-device doc cap, external summary cap of 200 bytes) and on `master`'s discovery-plus-invoke shape.

The mechanism, all inside `packages/core/tools`:

- **The mode.** `ctx.tools.presentAs('catalog')` (scoped, one cell per scope, same conflict rule as `ptc`/`native`) plus `Config.mode: 'catalog'` on the tools row. The `agent-tool-presentation` row's `catalog` option applies immediately — it needs no code runtime, unlike `ptc`/`both`.
- **The device flag.** `device: true` on a `ToolDefinition` (and on `DefineToolOptions`) is inert outside an effective `catalog` scope; there it withdraws the schema from the prompt while keeping the tool in the registry and in scoped visibility.
- **The transport.** `DYN_NAME = 'dyn'` is reserved exactly like `RUN_CODE`: un-registrable, un-restrictable, un-shadowable, absent from the global layer, and injected into the visible map after the capability-filtered layers. A `catalog` assembly therefore shows eager tools plus exactly one `dyn` schema instead of N device schemas.
- **The wire.** Prompt assembly under `catalog` wireSchemas projects only eager schemas; device names are excluded from `knownNames`, so naming a device in `toolOrder` fails assembly exactly as naming a native tool fails under `ptc`. The catalog section (`CATALOG_ONLY: 850`, between `PTC_ONLY: 800` and `FILE_REFERENCE: 900`) carries fixed guidance plus one bounded line per device, capped at `DEVICE_SUMMARY_CAP = 200` UTF-8 bytes (`catalogSummary`/`truncateUtf8`).
- **The guard.** Device calls only ever reach a device through `dyn`'s nested dispatch, which re-enters the full guarded pipeline with `callId`/`rootCallId`/`parent`/`signal` from the outer execution. A model-direct call naming a device collapses as an unknown tool (`UNKNOWN_TOOL`) before policy, under any mode — a device schema is never a callable name on the wire.
- **The security contract.** One visibility resolver feeds `get()`/`restrict()`/nested dispatch/catalog, so a device is either visible to a scope or gone from it everywhere — restrict removes it from catalog rows, docs, and dispatch, with the same `nesting`/scope rules as every other tool.

First-party opt-ins: 36 devices across 5 packages — codebase-memory (14), logseq (8), session-query (5), openwiki (5), av (4).

## Alternatives considered

- **A new preset row** for discovery-first agents. Rejected: presentation is one axis of the existing tools row; a preset would have duplicated scope/conflict machinery and made `mode` a cross-preset agreement problem.
- **Filtering by allowlist at registration time.** Rejected: it would have changed the registry contract for every consumer instead of adding an opt-in flag, and would have dropped tools from introspection APIs that legitimately show all schemas.
- **A client-side/environmental mount (like omp's sidecar `xd://`).** Rejected: the fork runs engines in-process; a subprocess transport would have added process supervision with no prompt-size benefit over the in-registry transport.
- **Reusing `rdp`-style dumps or the PTC SDK for discovery.** Rejected: PTC is a different axis (call surface vs. prompt cost), and the catalog keeps eager tools callable directly, which PTC forbids.

## Consequences

Cost: prompt assembly grows only linearly in device count (one summary line per device), plus the budgeted `dyn` guidance; `schemas()` (the introspection API) intentionally still lists collapsed devices, mirroring `ptc`'s behavior for collapsed tools — a caller introspecting must ask `view()` semantics, the same caveat as PTC mode. The reserved `dyn` name is one more name no tool plugin may ever register. Budgets are constants (`DEVICE_SUMMARY_CAP`, `CATALOG_SEARCH_LIMIT = 50`) mirroring omp2; drift from omp's exact values is documented per-constant. The catalog section is empty outside an effective `catalog` scope, so native/prompt-typed assemblies pay nothing.

Bought: long-tail tools stay one `device: true` away from zero prompt cost while remaining discoverable and callable; discovery + docs + invoke now exist as a first-class prompt pattern the fork can teach; the `toolOrder` failure is early (assembly) instead of a silent missing tool at call time.

## Testing

A dedicated `catalog.spec.ts` (18 tests, in `packages/core/tools/tests`) covers the wire (eager + `dyn`, no devices), the section content, the inert flag under native, toolOrder failure, the reserved name, search filter/offset/truncation, the 200-byte cap over UTF-8, docs schema reveal vs. unknown/eager refusal, nested dispatch with value + content, device body failure, restrict withdrawal, model-direct denial with the `dyn` hint, the nested parent-token bypass, `presentAs` shadow/dispose, and scoped withholding. Typert round-trips the `ToolDefinition` shape (including `device`) byte-for-byte into `tool-cordis/src/api-catalog.ts`.

## Deferred

- A mount/session notice when a device is added mid-session (the catalog section is assembled at prompt time; a live add shows up on the next assembly, with no immediate notice).
- `spillStore` overflow seam for catalogs whose device count or docs exceed budgets.
- A device-summary column in the generated tool catalog so opt-ins are reviewable in the docs.
