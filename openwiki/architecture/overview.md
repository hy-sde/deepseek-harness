---
type: Reference
title: Plugin Architecture and Composition
description: The Cordis everything-is-a-plugin foundation of DeepSeek Harness, profiles and bundles layering, host vs agent-preset composition planes, and the singleton application launcher.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-115b2dad781e2a2c5b5a980d
    resource: repo://docs/architecture.md
  - id: openwiki-source-e15dee62c5f483e1d2a2f22b
    resource: repo://docs/cordis-primer.md
  - id: openwiki-source-4d071d0f31e54f5199a81511
    resource: repo://packages/boot/app-boot/README.md
  - id: openwiki-source-b9d92b2a940a4ee7e20a230b
    resource: repo://packages/preset/README.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# Plugin Architecture and Composition

DeepSeek Harness is built on an everything-is-a-plugin architecture powered by the vendored [Cordis](https://github.com/cordiverse/cordis) framework: plugins contribute services, typed events, and reversible effects to a shared context. There is no privileged core to patch — you extend dsh by mounting a plugin beside the others, and registrations unwind when their plugin unloads.

## Cordis foundation

Cordis is the vendored plugin framework underneath DeepSeek Harness. Its five ideas: a plugin is an object that implements `Service` (a function with optional `inject` and `apply(ctx)`, or a `Service` subclass); a context is a repository of services claiming stable `ctx.<key>` slots such as `ctx.tools`, `ctx.llm`, or `ctx.sessions`; service dependencies are declared via `inject` so load order follows service requirements; events are typed and dispatched as `emit`, `waterfall`, `parallel`, `serial`, or `bail`; and registrations are reversible effects installed through `ctx.effect()` or `ctx.on()` so reload and teardown unwind them predictably.

Every part of the product is a plugin, including the model adapter, the tool registry, the session log, and the agent loop itself, so each is replaceable from configuration. Registrations are effects that unwind when their plugin unloads.

## Profiles and bundles

A running `dsh` is a plugin tree composed at boot from ordered layers:

- A **profile** is a named composition stored in the Harness home. It lists the bundles it stacks, holds any out-of-tree plugins it installs, and keeps the user's own `cordis.patch.yml`. `web`, `headless`, `sdk`, `sdk-minimal`, and `acp` ship as templates.
- A **bundle** is a distribution format for Cordis config rows and the code they mount, so whatever it inserts stays patchable by the layers above it.
- Each declares itself in its own `package.json` under a `dsh` field: `dsh.profile` lists a profile's bundles, and `dsh.bundle` points at a bundle's patch file.

Layers apply to an empty entry list in this order: each bundle in the profile's listed order, then the profile's `cordis.patch.yml`, then the home-level one, then any `--patch` overlay. A patch targets a row by id and replaces its whole config, or inserts new rows. `dsh --profile web --dump-config` prints the exact composed entry list.

`dsh-base` is the shared first layer of the `web`, `headless`, `sdk`, and `acp` profiles: model adapters, tools, persistence, sandbox and approval policy, settings, credentials, telemetry. `dsh-sdk-minimal` is the deliberate exception: one bundle owns its complete explicit SDK tree and does not apply `dsh-base`.

Custom profiles default to live patch reload. The shipped `web` profile is live; `headless`, `sdk`, `sdk-minimal`, and `acp` apply all layers once at startup. A profile lives at `$DSH_HOME/profiles/<name>` and combines installable bundles, its own `cordis.patch.yml`, and a `patchReload: live | startup` policy.

## Application launch

Every supported Node application starts at the `dsh` CLI with a named profile: `dsh web` (the deliberate alias for `--profile web`), `dsh --profile headless`, `dsh --profile sdk`, `dsh --profile sdk-minimal`, and `dsh --profile acp`. The TypeScript SDK resolves its same-version `dsh` dependency and selects `sdk`; custom plugin composition remains a profile plus ordered patch files, not another executable. `verify-application-entrypoints` keeps every package bin and executable source in an explicit class and rejects a Node application path that bypasses `dsh`.

## Composition planes: host and agent presets

Composition happens in two planes. The **host composition** (profiles and bundles, plus any shared services) constitutes the process. Per-session composition is done through **agent presets**: a preset is a directory holding one `agent.cordis.yml`, and a session composed from a preset runs that preset's tools, prompt sections, and skills while every other session keeps its own. The `agent-presets` package owns the roster — discovery over configured roots plus the harness home, the guarded per-agent mount, and copy-only authoring — and `persona` supplies the composable row that lets a preset change an agent's identity and not only its tools. One process can therefore run several differently composed agents at once.

A service row in an agent preset needs an `isolate` realm. Behind the scenes, `mountRootInclude` registers `cordis:include` and `cordis:group` as Loader builtins: a group row gives one `isolate` realm to a provider and its consumers together, and an agent preset outside the workspace cannot resolve `@deepseek-ai/cordis-plugin-group` by name.

## Event dispatch modes

Event dispatch mode is part of an event's public contract. The Cordis modes are `emit` (observe in registration order, no return), `waterfall` (around-middleware: listeners call `next()` to delegate), `parallel` (all listeners in parallel, awaited), `serial` (in order, awaited), and `bail` (stop at the first bail value). New harness events document their mode with an `@mode` tag so the generated catalog can check declarations against dispatch sites.

## Related pages

- [Session, Step and Turn Lifecycle](turn-flow.md) — what the composed plugin tree drives at runtime.
- [Event Domains and Lifecycle Events](events.md) — the event vocabulary and modes.
- [Package Workspace Map](../platform/packages.md) — the packages that stack into the bundles.
- [Quickstart](../quickstart.md) — running the harness.
