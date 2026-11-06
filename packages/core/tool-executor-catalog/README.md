---
description: "Catalog presentation: device tools stay out of the prompt and are reached through the dyn bridge."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-executor-catalog

English | [中文](README.zh.md)

## Summary

The catalog tool executor mounts the fork's device-catalog mode as a `ToolExecutor` plugin: device tools keep their full schemas out of the prompt and become reachable only through the reserved `dyn` bridge tool.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the executor where catalog presentation is wanted, with the fork's `dyn` bridge mounted beside it. The nearest scoped executor selects tool behavior; one scope permits only one executor.

```yaml
- name: '@deepseek-ai/dsh-tool-executor-catalog'
```

Device tools declare `device: true`; the executor rejects direct calls to them and serves them through `dyn` `search` / `docs` / `invoke`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The executor wraps a `ToolExecutionPipeline` whose source admits only the `dyn` bridge and rejects direct device calls with a `ToolNotFoundError`. Its prompt section lists mounted devices in `CATALOG_ONLY` order with the fork's catalog guidance; `dyn` invocations dispatch into the pipeline as nested executions of the target device tool.

- [`src/index.ts`](src/index.ts) — Catalog executor registration, bridge transport wiring, device listing.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Tool registry](../tools/README.md)
- [Native executor](../tool-executor-native/README.md)
- [PTC executor](../tool-executor-ptc/README.md)

-----

<a id="model-experience"></a>
## Model Experience

### Catalog presentation

#### What the model sees

One `dyn` bridge tool plus the catalog guidance section; device schemas appear only on demand through `dyn` `docs`.

#### Token effect

Request cost is bounded by the bridge schema and the catalog listing rather than the sum of device schemas; a newly mounted device adds one listing line, not its JSON Schema.

#### KV Cache effect

Stable while the mounted device set is stable; mounting or unmounting a device rewrites the catalog listing line but not the bridge schema.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints apply to catalog deployments.

- The executor requires a `dyn` transport mounted through `createDynTool` (the fork's `catalog.ts` bridge); a catalog deployment without that bridge fails `dyn` calls rather than degrading to direct execution.
- Device discovery and docs rendering reflect the fork's catalog summary format; upstream stock harness has no catalog executor, so executor-shape changes upstream must be re-ported by hand.
- Nested `dyn` invocations reuse the parent execution's call identity with a `:catalog:` suffix; trace tooling that assumes globally unique call ids may render them oddly.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Fork-only package: upstream stock harness has no catalog executor.

</details>
