---
type: Reference
title: Build, Test and Verification
description: The DeepSeek Harness development workflow — pnpm install, host/client/web build stages, vitest suites, the run-gates gate runner, lefthook pre-commit hooks, and the CI job matrix.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-72b816a72bb5f72d95b334ea
    resource: repo://lefthook.yml
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-47b9b8ed41f96205285a4386
    resource: repo://scripts/run-gates.ts
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# Build, Test and Verification

DeepSeek Harness is a pnpm workspace whose root `package.json` owns the build, test, and verification surface, backed by `scripts/run-gates.ts` (the gate runner), lefthook Git hooks, and a layered GitHub Actions matrix.

## Install and build

```sh
pnpm install
pnpm run build
pnpm dsh web
```

- `build` runs `tsx scripts/build.ts` (repository artifact preparation).
- `build:lib` is `build:lib:host && build:lib:client`:
  - `build:lib:host` — `tsc -b tsconfig.host.json` plus `tsdown --env.DSH_BUILD_FACE host`.
  - `build:lib:client` — `tsc -b tsconfig.client.json` plus `tsdown --env.DSH_BUILD_FACE client`.
- `build:web` — `pnpm --filter @deepseek-ai/dsh-web-frontend run build`.
- `dsh` — `node --import tsx/esm apps/cli/src/bin.ts` (the dev CLI launcher).
- `dev:web` — `tsx scripts/dev-web.ts --poll` (live Web dev with polling).

`typecheck` runs `build:lib:host` then `typecheck:contracts-ready`; `lint` similarly gates on the contracts-ready build first.

## Test suites

| Script | Command |
| --- | --- |
| `test` | `vitest run` — unit suite |
| `test:snapshot` | `vitest run --config vitest.snapshot.config.ts` (record/refresh via `DSH_SNAPSHOT`) |
| `test:e2e` | `vitest run --config vitest.e2e.config.ts` |
| `test:expected` | `vitest run --config vitest.expected.config.ts` |
| `test:web:built` | `vitest run --config vitest.web.config.ts` — web snapshots against the built app |
| `test:gui` | `vitest run packages/client packages/host` |

## Gate runner

Public aggregates are owned by package scripts and executed by `scripts/run-gates.ts`, which runs the named aggregate's validated gate graph with bounded in-process scheduling (concurrency configurable via `DSH_GATE_CONCURRENCY`). Aggregates include `ci-primary` (`check:ci`), `ci-static`, `ci-linux-primary`, `ci-lint-contracts-ready`, `ci-coverage`, `ci-snapshot`, `ci-artifacts`, `ci-consumers`, `ci-windows-blocking`, `ci-windows-complete`, `ci-windows-observational`, `node-compat`, `check-all`, `hygiene`, `doc-sync`, and the build-free `doc-quick` (used by `test:docs`).

## Git hooks (lefthook)

Keep local checkpoints fast; CI owns the full repository-wide matrix. `postinstall` runs `node scripts/install-lefthook.mjs`.

- **pre-commit**: translation pairing on staged `*.i18n.yaml` records, archived agent notes check, staged lint (`run-oxlint.ts --config .oxlintrc.staged.json --fix`, `stage_fixed: true`), third-party notices regeneration (`gen-third-party-notices.ts` + `git add THIRD_PARTY_NOTICES.md`), whitespace check (`git diff --cached --check`), and the vendor manifest guard.
- **pre-merge-commit**: translation pairing and archived agent notes.
- **pre-push**: `pnpm run typecheck`.

## CI split

The repository uses a layered CI matrix:

- **node 24 / static** — `pnpm run check:ci:static`.
- **node 24 / coverage** — `pnpm run check:ci:coverage` (with bubblewrap prepared).
- **node 24 / snapshots and artifacts** — `pnpm run check:ci:consumers`, including Playwright Chromium for web tests.
- **node-compat** — install and `pnpm run check:node-compat` across a Node 22.19 / Node 26 matrix.
- **python-sdk / python-runtime** — the keyless Python SDK suite and a release-shaped runtime matrix.
- **Windows lanes** — `windows` (Wine-driven blocking gates), `windows-build` (`check:ci:windows-blocking`), and `windows-coverage`, so Windows-only behavior is exercised in CI.

## Related pages

- [Documentation System and i18n](docs-system.md) — the documentation verification gates.
- [Package Workspace Map](../platform/packages.md) — what is being built.
- [Quickstart](../quickstart.md) — running the harness.
