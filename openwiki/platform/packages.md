---
type: Reference
title: Package Workspace Map
description: The DeepSeek Harness package workspace — npm groups under packages/, the @deepseek-ai/dsh-* naming convention, group READMEs as the authoritative package map, and the pnpm workspace configuration.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-5c455dc44cb2e95e07f59207
    resource: repo://packages/README.md
  - id: openwiki-source-40275cb92c3610938f16ade3
    resource: repo://pnpm-workspace.yaml
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# Package Workspace Map

The harness is assembled from npm packages under `packages/`, grouped by capability family: sessions and the agent loop, model-facing tools, shell and filesystem execution, web access, subagents, and the rest. This page is the top-level map: find the owning group, then open its README for the package list. Every package is scoped `@deepseek-ai/dsh-*` and lives in exactly one group; each group README is the authoritative package map for its family.

## Package groups

Every package lives in exactly one group; new packages join existing groups, and a new group updates its own README and this table. The canonical table (abridged here) covers:

- **Product API spine** — `core/` (sessions, prompts, tools, agent services, the concrete loop), `typert/`, `goal/`, `schedule/`, `feedback/`, `identity/`, `settings/`, `credentials/`, `storage/`, `workspace/`.
- **Capability families (seam + provider + consumer)** — `llm/`, `e2b/`, `subprocess/`, `shell/`, `terminal/`, `code-runtime/`, `sandbox/`, `fs/`, `lsp/`, `skill/`, `compaction/`, `context/`, `subagent/`, `web/`, `attachment/`, `spill/`, `session/`, `session-query/`, `interaction/`.
- **Loop hygiene and extension** — `guard/` (repeat-call reminders + the `tools/execute` deadline enforcer), `extensions/` (live plugin/service inspection and model-written mount/unmount), `hooks/`, `workflow/`, `webhook/`, `todo/`, `plan/`, `preset/`, `job/`, `schedule/`, `experimental/`.
- **Assembly and surfaces** — `bundle/` (installable `dsh --profile` patch layers), `boot/` (shared app-bin boot glue), `host/` (Web-GUI host half), `client/` (Web-GUI browser half with `ui-*` plugins), `sdk/`, `acp/`, `examples/`, `test-support/`, `runtime-diagnostics/`, `util/`.

## Release expectations

Most groups are product — stable API. The exceptions: `e2b/` is a POC, `experimental/` is unreleased, and `examples/`, `test-support/`, `runtime-diagnostics/`, and `util/` are support with lower compatibility expectations.

## Dependencies

The dependency graph is generated: `docs/module-graph.md` (`pnpm run gen-module-graph`, freshness-gated in CI). Extension plugins depend on Service Definitions, never concrete providers: `dsh-agent-loop` is swappable, and UI, hook, and tool plugins use `dsh-agent`. Capabilities separate Service Definition / Service Provider / Consumer roles when they evolve independently.

## Package README contracts

Every package README covers purpose, configuration, extension points, and Model Experience unless the model-agnostic omission allowlist exempts it, and carries `## Known Limitations and Deferred Work` or uses its limitations allowlist. Package conventions — exports, service access, invariants, tests — live in `packages/AGENTS.md`.

## Workspace configuration

The `pnpm-workspace.yaml` defines the packages: `vendor/*`, `packages/*/*`, the native Landlock launcher plus its packages, `apps/*`, and the website, with `linkWorkspacePackages: true`. Vendored framework packages keep upstream semver ranges but resolve to the workspace's pinned sources through `overrides`: `@deepseek-ai/cosmokit` links to `vendor/cosmokit` and `@deepseek-ai/schemastery` links to `vendor/schemastery`. Build scripts are reviewed explicitly: `allowBuilds` permits only the packages that genuinely need install scripts (esbuild, lefthook, node-pty, `@ast-grep/cli`, koffi, and the subprocess-local workspace postinstall), while denying `@google/genai` and `protobufjs` no-op scripts.

## Related pages

- [Plugin Architecture and Composition](../architecture/overview.md) — how the packages stack into profiles.
- [Build, Test and Verification](../development/build-test.md) — the toolchain that builds them.
- [Quickstart](../quickstart.md) — running the assembled harness.
