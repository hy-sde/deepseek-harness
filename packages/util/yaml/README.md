---
description: "Unified YAML parsing with the harness entryList option for !!js expression scalars."
kind: "package-reference"
---

# dsh-yaml

English | [中文](README.zh.md)

## Summary

Unified YAML parsing for the harness built on the npm `yaml` package — `load`/`loadAll`/`dump` wrappers plus the harness `entryList` option that parses `!!js` expression scalars as `{ $js: '…' }` objects without extending the YAML schema.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Import `load`, `loadAll`, or `dump` from `@deepseek-ai/dsh-yaml` wherever harness code parses YAML documents — boot config editing and the vendored `include` fork share this surface instead of depending on `js-yaml` or bespoke schema extensions.

```ts
import { load } from '@deepseek-ai/dsh-yaml'

const config = load('agents:\n  - name: main', { entryList: true })
```

-----

<a id="api"></a>
## API

- `load(text, options?)` / `loadAll(text, options?)` — parse YAML documents; `options.entryList` parses `!!js` expression scalars as `{ $js: '…' }` objects.
- `dump(value, options?)` — serialize back to YAML; `options.entryList` writes `{ $js: '…' }` objects back as `!!js` scalars.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through boot config editing and the vendored `include` fork, which parse harness configuration documents; no YAML content enters prompts as semantic content.

#### KV Cache effect

No direct invalidation; configuration is parsed host-side and never enters a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints apply to the wrapper surface.

- Only the classic `yaml` package v2 surface is wrapped; `js-yaml`-specific options (`JSON_SCHEMA`, `schema`-tag extensions) are not translated — call sites migrated from `js-yaml` must use the `entryList` option or the raw `yaml` package instead.
- `entryList` is an opt-in load/dump behavior shared by the vendored `include` fork and boot config editing; documents parsed without it keep `!!js` scalars as plain strings.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Fork-only package: replaces the upstream `js-yaml` dependency and the vendored `include` package's `jsExprTag` schema extension.

</details>
