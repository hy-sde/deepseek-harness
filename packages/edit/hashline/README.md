---
description: "A compact, line-anchored patch language and applier with pluggable filesystem I/O, ported from @oh-my-pi/hashline."
kind: "package-reference"
---

# @deepseek-ai/dsh-hashline

English | [中文](README.zh.md)

## Summary

`dsh-hashline` implements the compact, line-anchored hashline patch language: parse a patch into sections and apply it with snapshot/recovery support over a pluggable `Filesystem` — disk, in-memory, or any custom backend. Choose it when a model-facing tool needs the line-anchored edit protocol whose guidance `dsh-tool-edit` registers. It is a 1:1 algorithmic port of the MIT-licensed original, with native tree-sitter probing stubbed and `diffLineRuns`/xxHash reimplemented in plain JS, so syntax probing degrades gracefully. The main boundary: patches must be anchored to a prior read snapshot, and per-line hashing cost grows with file size.

## Table of Contents

- [License](#license)
- [Port differences](#port-differences)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Hashline: a compact, line-anchored patch language and applier, ported from [@oh-my-pi/hashline](https://github.com/can1357/oh-my-pi/tree/main/packages/edit/hashline).

Original package description still applies:

> > Hashline: a compact, line-anchored patch language and applier. Pluggable FS/IO so it works over disk, in-memory, or any custom backend.

## License

Port of MIT-licensed code. Original copyright: `Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük`. Derived files carry header attribution; see the inline file headers.

## Port differences

- - Native tree-sitter (`enclosingBlockBoundaries` / parse probing) is stubbed: `syntax.ts` returns `[]` / `false`, the documented graceful-degradation path.
- - `diffLineRuns` and the xxHash utilities are reimplemented in plain JS (`src/line-diff.ts`, `src/hash.ts`), matching the original native semantics.
- The small LRU cache is reimplemented inline (`src/lru.ts`).

Otherwise the port is algorithmically 1:1 with the original source.

Package API:

```ts
import { Patch, Patcher, applyEdits, InMemoryFilesystem } from '@deepseek-ai/dsh-hashline'
```

- `Patch.parse(input, { cwd })` — parse a hashline patch into sections.
- `Patcher` — apply sections with snapshot/recovery support.
- `Filesystem` — pluggable file IO (implement `writeText`/`readText`/… yourself for harness integration).
- See `src/index.ts` for the full export surface.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

## Model Experience

### Edit protocol guidance

#### What the model sees

`hashline` defines the hashline edit protocol with line-anchored patches; the read/write/edit guidance the model consumes is registered by `dsh-tool-edit`; its documented protocol is described in the tool catalog under `dsh-tool-edit`.

#### Token effect

No own per-request schema; the guidance it feeds the edit tool adds a small fixed paragraph.

#### KV Cache effect

The guidance paragraph is request-prefix text; unchanged patches preserve the reusable prefix.

## Known Limitations and Deferred Work

- Hashline patches require a prior read snapshot; AI-written content that is not line-anchored falls back to literal or patch modes.
- Very large files trade off against per-line hashing cost.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
