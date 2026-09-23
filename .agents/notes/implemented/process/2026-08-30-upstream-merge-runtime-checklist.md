# Agent Note: Post-merge runtime checklist (learned from the 0.1.2-alpha.1 sync)

Status: implemented

English | [中文](2026-08-30-upstream-merge-runtime-checklist.zh.md)

## Problem

Merging stock upstream `v0.1.2-alpha.1` into the fork (the 0.1.2-alpha.1 merge) was validated with the doc gates and `tsc -b` — every static gate was green — and the product was still broken end to end. Two days of omp-session debugging (2026-08-29/30) were needed to reach a working state (the post-merge fix commit). The cost came from one structural fact: the fork's own packages were written against pre-merge API semantics, and the upstream API changes that broke them are invisible to type and doc gates. Eight independent regressions surfaced only at runtime, each one hiding the next.

The eight defect classes, in the order they were found:

1. **Client tsdown pass fails to resolve an entry.** the api/wiki-controller `tsdown.config.ts` (since removed) was a wrongly-cloned sibling-controller config declaring a browser-client half (`lib/types/client/index.js`) the host-only package does not have. tsc cannot see tsdown entry configs, so only a full `pnpm run build` fails. Fix: delete the config, matching the `settings-controller` precedent.
2. **Web boot crashes on an undeclared dependency.** The package's generated `typert.host.js` imports `zod`, which was never declared in its `dependencies`. Only actually booting `pnpm dsh web` shows it. Fix: declare `zod` (every typert contributor already did).
3. **Browser plugin-load failures from stale bundles.** Client bundles built before the merge externalized `require("zod")` with no module-table row and no inlined core. A clean rebuild fixed it; only the web UI shows plugin-load errors.
4. **Foreign-slot registration races the declaration.** `ui-countdown` and `ui-wiki` registered directly in `apply()` into `sidebar.footer.action` / `shell.overlay`, whose declaring package defers its children table (a later `ctx.effect`). Upstream's slots API requires the order-safe pattern `ctx.slots.inject(slotName, () => ctx.slots.register(...))`. Only booting the UI shows `slot "..." is not declared`.
5. **A `@Remote` method collides with the namespace service's own surface.** `wiki.remove` collided with `RemoteNamespaceService.prototype.remove` (its internal un-bookkeeping API) and RPC registration rejected it. Only live registration shows `conflicts with its namespace service`. Fix: rename the wire method to `wiki.delete` across controller, client, fixtures, and tests — the seam's `graph.remove` stays unchanged.
6. **Preset rows reference packages outside the install closure.** The fork's tool packages (`dsh-tool-memory`, `dsh-code-runtime-kernels`, `dsh-tool-logseq`, `dsh-tool-openwiki`, `dsh-tool-codebase-memory`, `dsh-tool-session-query`, and earlier `git`/`browser`/`av`) were never declared in the install anchor, so preset resolution and workspace creation failed. Fix: declare fork tool packages in **both** `apps/cli/package.json` and `packages/bundle/base/package.json`, then `pnpm install`. This is the standing rule for fork-added packages.
7. **One handler throw aborts the whole sink chain.** `ui-wiki`'s `ctx.on('connection/reset', bind)` used `ctx.remote.wiki` without declaring `'remote.wiki'` in `inject`, throwing on the very first connect — which aborted the rest of the connection sink so the session-list stream never opened and every past session vanished from the sidebar. Data was 100% intact on disk the whole time. Fix: declare the sub-namespace in `inject` and teach the test bench to provide it.
8. **Empty-array compat defaults block a route at settings validation.** Schemastery materializes absent compat fields as empty values (`allowedFallbackModels: []`, `chatTemplateArgs: {}`, `chatTemplateKwargs: {}`), and `configuredCompatEntries` in `packages/llm/llm-pi-ai/src/catalog.ts` treated an empty **array** as a configured switch (it already handled empty objects). The user's `local` endpoint configured for `openai-completions` was therefore rejected, the provider never registered, and the UI showed a model-unavailable/API-key block that had nothing to do with keys. Fix: filter empty arrays like empty objects, plus a regression test.

Two environment regressions sat on top: the merged toolchain (`tsdown@0.22.2` → `import-without-cache@0.4.0` through `tsx@4.22.4`) crashes the ESM loader-hook chain on Node 22.19/23.x with `ERR_INVALID_RETURN_PROPERTY_VALUE` (the engine warning is a red herring) and works only on Node 24; and git hooks spawned by GUI clients die with `node: not found` under sanitized PATHs, fixed by baking the installing node's bin dir into each lefthook shim.

## Decision

Every upstream sync into this fork is a runtime release, not a doc exercise. The gates below are mandatory before the merge commit is final. Items in brackets name the defect class above they exist to catch.

1. `pnpm install` with the fresh lockfile; verify `node_modules/@deepseek-ai` links for every fork package and every preset row. [2, 6]
2. Full build from clean: `pnpm run clean && pnpm run build` (tsc **and** tsdown host + client). [1]
3. Boot the real product: `pnpm dsh web`, then drive the browser (or an RPC/WS client) through: workspace dropdown pick, session list, session open, a sent message. [2, 3, 4, 5, 6, 7]
4. Warm-real-profile verification: boot the web profile against `$DSH_HOME` with the user's persisted profile, settings, and `~/.dsh/.agent-presets` after `healProfilesModuleFallback`; every preset in the roster must be healthy (not "broken"), and the configured provider (e.g. `local` via `llm-pi-ai`) must appear in `routableProviders`. [6, 7, 8]
5. Assert the API surface of Remote namespaces against `RemoteNamespaceService`'s own members before adding a `@Remote` method. [5]
6. Sweep `ctx.remote.*`, `ctx.slots.register`, and event handlers for the injected-key discipline: sub-namespace use must be declared in `inject`; foreign-slot registration must use `ctx.slots.inject`. [4, 7]
7. Rebuild **after** every source/config fix before judging the UI — stale `lib/` and `dist/` bundles have misled this debugging twice. [3]
8. Run the targeted package tests plus a fresh `pnpm run build` and `pnpm run typecheck` before committing; only then commit with a clean `pnpm run clean && pnpm run build`.

## Testing

This merge is the proof of the checklist: applying the steps in order surfaced defects 1 through 8 exactly as listed, and the post-merge fix commit is the state where every step passes end to end (build, web boot, workspace pick, sessions visible, presets healthy, local provider routable). Future merges must re-run the checklist and record the result in the merge description.

## Consequences

Future upstream syncs start from a running baseline instead of a green static tree. The checklist closes the static-to-runtime gap that cost two days here: none of the eight defect classes survives steps 1-8, the stale-bundle trap is explicit, and the install-closure rule for fork packages prevents preset/workspace breakage by construction. The immediate cost is a real boot (steps 3-4) plus one browser pass per merge — a few minutes against two days of serial debugging. The note also retires the false belief that typecheck + doc gates are merge-readiness: they are necessary but never sufficient, because fork packages bind to upstream runtime semantics that only a running profile exercises.

## Alternatives considered


Delaying the merge until every fork package was rewritten against upstream APIs first — rejected: it does not terminate, because the API surface keeps moving and the failures are only observable in the running system. Automating a full browser E2E as the sole gate — deferred: the checklist's browser step exists today and an automated session-create + session-list E2E can be added on top later; the manual steps 3-4 already catch every defect class above except 5, which is caught by static inspection.
