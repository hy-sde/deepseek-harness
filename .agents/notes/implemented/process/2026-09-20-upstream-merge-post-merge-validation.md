# Agent Note: Post-merge validation checklist (learned from the 0.1.5 and 0.1.6-alpha.2 syncs)

Status: implemented

English | [中文](2026-09-20-upstream-merge-post-merge-validation.zh.md)

## Problem

Three consecutive upstream syncs were each validated by the full static gate set and still broke the product at runtime:

- **0.1.2-alpha.1 (2026-08-30):** [upstream-merge-runtime-checklist](2026-08-30-upstream-merge-runtime-checklist.md) documents eight runtime defect classes that hid behind green `tsc -b` + doc gates and cost two days of debugging.
- **0.1.5 (2026-09-12):** the merge looked green, but three fork-side regressions surfaced only later: (a) upstream renamed the persona row config key `text:` to `prefix:`/`suffix:`, silently breaking every USER-authored preset (`~/.dsh/.agent-presets/*/agent.cordis.yml`) at schemastery validation — the session could not send a message and every retry re-mounted the broken preset; (b) a bump that switched a cross-plugin dependency to `workspace:^` broke `file:` consumers with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`; (c) upstream replaced the fork's `configuredCompatEntries` with a version that treated only empty **objects** as "no compat configured" — but schemastery materializes an absent `allowedFallbackModels` as `[]` (empty **array**), so a hand-declared route with no compat was rejected, the provider never registered, and the default model failed `INVALID_CONFIG` every turn. All three were found by inspection after the fact; the fork's own package test suites (which had a regression test for (c)) were never run during merge validation.
- **0.1.6-alpha.2 (2026-09-20):** the 0.1.6-alpha.2 merge passed install, typecheck, config gates, and a full rebuild — and then **every** turn of a running `dsh web` failed with `Cannot read properties of undefined (reading 'prepare')`, surfaced to the user as a bare `UNKNOWN` ("This turn failed"). Root cause (this session's live debugging): the tsx **source** launch loads workspace packages from `src` (tsconfig `paths`) for the CLI bootstrap while the profile loader-tree resolves package `exports` → `lib`; `dsh-tools` ends up in the process twice, and `TOOL_RUNTIME_SCHEDULER` is a module-scoped `unique symbol`, so `dsh-agent-loop` (lib) looked up a different symbol than the `tools` service instance (src) created. The 0.1.6 alpha merge is the first to introduce a cross-package symbol handshake, so the pre-existing plane split became fatal only after this merge. The source-launch loader-tree fix (source-launch detection, per-launch fallback settling, ambient-first row resolution; details in the [source-launch note](../architecture/2026-07-29-dsh-source-launch-tsx-esm.md)).

The pattern across all three: **a green static tree is necessary but never sufficient for an upstream merge in this fork, because fork packages and running profiles bind to upstream runtime semantics (symbol identity, config-schema shapes, loader plane) that static gates cannot observe.**

## Decision

Every upstream sync is a runtime release. After the merge commit is prepared, run the validation checklist below in order and record the results in the merge description. Items in brackets name the incident they exist to catch.

### 0. Workspace hygiene, before starting

1. Commit or stash unrelated in-flight work first; never leave a pending `git add -A` from another task — staged files from an interrupted session (a half-made `apps/cli` dependency bump) rode into the wrong commit and made the checkout's lockfile mismatch look like a test failure. [0.1.6]
2. Note the merge base and the expected merge commit before `git merge`; keep the fork-only commit list queryable afterwards (`git log --first-parent --format='%h %s' <base>..HEAD`).

### 1. Merge mechanics

3. After the merge, run the translation-pairing verification (the automatic merge driver composes records only when Git's text merge succeeds): `pnpm run verify-translation-pairing`, then fix any out-of-sync pair with `pnpm run verify-translation-pairing --write <pair>`.
4. Audit fork-only fix commits for survival: for each `fix`-type fork commit in the range, verify its essence exists at the merged HEAD (`git diff --name-only <commit> HEAD -- <its files>` plus a semantic grep for the marker). The 0.1.5 audit found exactly one lost fix this way (the empty-array compat check, later restored). [0.1.5]

### 2. Static gates (necessary, never sufficient)

5. `pnpm install` with the fresh lockfile and treat every `ERR_PNPM_*` as a blocker: `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` means a cross-dir dependency leaked `workspace:` — cross-repo/registry deps must stay registry ranges (`^x.y.z`), never `workspace:^`, even during a bump. [0.1.5]
6. Freshly published dependencies trip pnpm's 24h minimum-release-age quarantine: `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`. pnpm 11.7.0 honors the workspace file's `minimumReleaseAge` value but ignores its `minimumReleaseAgeExclude` list during lockfile re-verification (the CLI flag `--config.minimumReleaseAgeExclude` works only for that one invocation). Unblock with `minimumReleaseAge: 0` in `pnpm-workspace.yaml` and keep the `@org/dsh-*` glob under `minimumReleaseAgeExclude` as intent documentation. [0.1.6]
7. `npm run typecheck` (or `pnpm -r check`) — in the harness fork and in **every dependent repo** (e.g. dsh-plugins): the fork's own packages compile against the new `@deepseek-ai` ranges and are where upstream API-shape changes show up as TS errors (renamed packages `@deepseek-ai/dsh-code-runtime` → `dsh-ptc-runtime`, `agent/created` listener return type `undefined | Promise<undefined>`, `SubprocessHandle.control`, tool-schema enum widening). Run each dependent repo's **test suites too** — the 0.1.5 fork suite carried a regression test for the empty-array compat bug that merge validation never executed. [0.1.5]
8. Sweep for renamed symbols/package names with grep before trusting typecheck: old package names, old type names (`Code*` vs `Ptc*`), old config keys, old event signatures. Type checks miss imports that still resolve (deprecated npm names keep publishing) and config-schema breaks in USER files. [0.1.5, 0.1.6]
9. `pnpm run verify-cordis-config` (config files, resolution, supply-chain policy) and the doc gates. [0.1.5]
10. `pnpm run clean && pnpm run build` — both tsc **and** tsdown host+client; tsdown entry configs and undeclared runtime imports are invisible to tsc. [0.1.2: defects 1–2]
11. Re-run packaging/publication-level checks for changed plugins: build + pack the plugin workspace (`pnpm -r check/test/build`, then per-package release in dependency order). `pnpm pack` rewrites `workspace:^` to the concrete version, so a workspace-only sibling that is not published yet breaks consumers — publish dependency-first. [0.1.5, 0.1.6]

### 3. Config and preset surfaces (user files are part of the product)

12. Audit `~/.dsh/.agent-presets/*/agent.cordis.yml` against the merged schema **before** booting: renamed or dropped row keys fail schemastery validation at mount time (persona `text:` → `prefix:`/`suffix:` in 0.1.5), and a broken preset re-mounts on every retry so the toast loops. Every preset in the roster must be `healthy`, never "broken", and each configured provider must appear in `routableProviders`. [0.1.5, 0.1.2: defect 8]
13. Settings-layering check: verify the user's `~/.dsh/settings.yaml` provider still validates (the llm-pi-ai `configuredCompatEntries` false positive in 0.1.5 made the provider vanish from the model picker and every turn fail `INVALID_CONFIG`, while the UI showed an unrelated API-key block). [0.1.5]
14. Docs/version references: plugin-list, README/WORKFLOW version strings, THIRD-PARTY notices (the pre-commit hook regenerates them; commit the result).

### 4. Runtime validation (the expensive, mandatory part)

15. Boot the product from **source** exactly the way the user runs it: `pnpm dsh web` (tsx launch) — this is the two-plane setup that 0.1.6 broke. Also verify a **built-bin** launch (`node apps/cli/lib/bin.js web` after a build) still works; both launch modes must end up on one module plane per process. [0.1.6]
16. Drive a real session end to end: create a session, send a message with a tool call, restart the server, and **resume the same session** (the 0.1.6 crash only reproduced on a resumed turn after a rebuild+restart). Watch for "This turn failed" / `UNKNOWN`. [0.1.6]
17. Module-plane assertion for symbol-keyed handshakes: in the warm process, require the same package from the bootstrap and the loader graph and assert one instance — e.g. no process may hold both `packages/core/tools/src/index.ts` and `.../lib/index.js`, and `ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare` must be a function. The fix note's probe (`loader.import('@deepseek-ai/dsh-tools')`) reproduces the check in seconds. [0.1.6]
18. When a turn fails, decode the session record first (`~/.dsh/sessions/<workspace>/<session>/session.v3.jsonl.zstd`) instead of trusting the flattened `code: 'UNKNOWN'`; the underlying throw (e.g. `undefined.prepare`) is what identifies the class. [0.1.6]
19. Rebuild **after** every source fix before judging a rerun — stale `lib/` and `dist/` bundles have misled three separate debugging sessions. The 0.1.6 crash appeared only after a rebuild of the merged HEAD; before it, the stale pre-merge lib masked the plane split. [0.1.2: defect 3, 0.1.6]
20. Re-run targeted package suites + typecheck, then commit only the intended files (`git add` by path, review `git diff --cached`); lefthook lints only the staged subset, so always run `npm run typecheck` separately. [0.1.2, 0.1.6]

### 5. Release follow-through

21. Publish changed plugins in dependency order (zstd-frame before session-intelligence each release); afterwards switch registry-range deps to the published version and re-install. Then bump the harness's `apps/cli` `@hy-sde-org/*` ranges and re-run step 5–7. [0.1.6]

## Testing

This note is the accumulated result of three merges. The 0.1.6 evidence chain: the 0.1.6-alpha.2 merge green on all static gates → user session failed with `UNKNOWN` → session log showed `Cannot read properties of undefined (reading 'prepare')` at `agent-loop/lib/index.js:586` → live inspector proved two module instances of `dsh-tools` and `Object.is(srcSymbol, libSymbol) === false` → the source-launch loader-tree fix made the source launch single-plane and the same resumed turn then ran its tool call normally. Applying the checklist in order is what catches each class; future merges must run it and record the result in the merge description, as the 0.1.2 checklist note already requires.

## Consequences

The cost of the checklist is a real boot per merge (steps 15–17) against two days of serial debugging or a user-visible broken session. The static gates stay mandatory but are no longer treated as merge-readiness: "typecheck green" is only the start of validation. The 0.1.2 checklist remains authoritative for its eight classes; this note adds the 0.1.5/0.1.6 classes (config-schema renames of USER presets, cross-repo dependency protocol, empty-array compat, and module-plane identity) and the operational discipline they required (unrelated staged changes, session-log decoding, per-launch fallback settling).

## Alternatives considered

- Making the module fallback always resolve `src` for dev checkouts — rejected: an installed or packaged runtime must keep its no-write `lib` lookup, and a built-bin launch on the same checkout must heal back to `lib`; the fallback is settled per launch instead.
- Reordering the vendored loader's internal-first precedence — rejected: the config-shadow contract (`user-patches` tests) pins that order; the ambient-first path is gated on the tsx hook so vitest/installed bins keep the original fast path.
- Automating a full browser E2E as the sole runtime gate — deferred: the manual steps 15–16 are today's gate; an automated session-create/resume E2E can be layered on top later.
