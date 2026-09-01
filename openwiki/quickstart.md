---
type: Guide
title: DeepSeek Harness Overview
description: What DeepSeek Harness is, how the everything-is-a-plugin architecture works on Cordis, how to run it from npm or from source, the monorepo layout, and where to go deeper.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-115b2dad781e2a2c5b5a980d
    resource: repo://docs/architecture.md
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# DeepSeek Harness Overview

DeepSeek Harness (`dsh`) is an open-source agent harness developed by DeepSeek AI. It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in *A Programming Paradigm for Spatiotemporal Composability*. It is in developer preview and iterating rapidly — compatibility-breaking changes are expected.

## Everything is a plugin

Cordis is the framework under `dsh`: plugins contribute services, typed events, and reversible effects to a shared context. Every part of the product is a plugin — including the model adapter, the tool registry, the session log, and the agent loop itself — so each is replaceable from configuration. There is no privileged core to patch: you extend `dsh` by mounting a plugin beside the others, and registrations are effects that unwind when their plugin unloads.

A **profile** is a named composition stored in the Harness home: it lists the bundles it stacks, holds any out-of-tree plugins it installs, and keeps the user's own `cordis.patch.yml`; `web`, `headless`, `sdk`, `sdk-minimal`, and `acp` ship as templates. A **bundle** is a distribution format for Cordis config rows and the code they mount, so whatever it inserts stays patchable by the layers above it. Layers apply to an empty entry list in order: each bundle in the profile's listed order, then the profile's `cordis.patch.yml`, then the home-level one, then any `--patch` overlay. `dsh-base` is the shared first layer of the `web`, `headless`, `sdk`, and `acp` profiles (model adapters, tools, persistence, sandbox and approval policy, settings, credentials, telemetry).

To see the tree your machine boots: `dsh --profile web --dump-config` — any row it prints can be replaced by a patch of your own.

## Run from npm

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser.

## Run from source

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts; `pnpm dsh web` uses those built artifacts without rebuilding. Every supported Node application starts at the `dsh` CLI with a named profile: `dsh web` is the deliberate alias for `--profile web`, and the other shipped applications are `--profile headless`, `--profile sdk`, `--profile sdk-minimal`, and `--profile acp`.

## Monorepo layout

- `vendor/` — vendored Cordis source; manifest + sync procedure in `vendor/README.md`.
- `packages/` — `@deepseek-ai/dsh-<pkg>` workspaces at `packages/<group>/<pkg>/`, starting with `core/` (product API spine: session, system-prompt, tools, agent, agent-loop), then the capability families (`llm/`, `fs/`, `shell/`, `ast/`, `lsp/`, `web/`, `subagent/`, `sandbox/`, `terminal/`, and more), `bundle/` (installable `dsh --profile` patch-layer bundles), and the surfaces (`boot/`, `host/`, `client/`, `sdk/`, `acp/`).
- `apps/` — the `dsh` CLI bin and the web frontend shell.
- `docs/` — architecture and subsystem references, starting with `docs/architecture.md`, `docs/development.md`, and the generated catalogs.

For agents, `AGENTS.md` is the entry point; for users, start with the Web UI guide under `docs/user/guide/`.

## Navigation

- [Plugin Architecture and Composition](architecture/overview.md) — profiles, bundles, scopes, and the agent preset plane.
- [Capability Seams](architecture/seams.md) — the seam pattern behind the capability families.
- [Session, Step and Turn Lifecycle](architecture/turn-flow.md) — how a run actually unfolds.
- [Event Domains and Lifecycle Events](architecture/events.md) — the typed event vocabulary.
- [Build, Test and Verification](development/build-test.md) — toolchain, scripts, and gates.
- [The Package Workspace Map](platform/packages.md) — every group under `packages/`.
- [Platform capabilities](platform/filesystem.md), [LLM](platform/llm.md), [Memory](platform/memory.md), [Sandbox and Execution](platform/sandbox-execution.md), [Tools Pipeline](platform/tools-pipeline.md), [Session Data Plane](platform/session-data-plane.md), [Subagents](platform/subagents.md), [Web GUI](platform/web-gui.md), [SDK & ACP](platform/sdk-acp.md), [OpenWiki Engine](platform/openwiki.md), [Codebase Memory](platform/codebase-memory.md).

## License

MIT. Third-party dependencies and their licenses are disclosed in `THIRD_PARTY_NOTICES.md`.
