# @deepseek-ai/dsh-hashline

English | [中文](README.zh.md)

Hashline: a compact, line-anchored patch language and applier, ported from
[@oh-my-pi/hashline](https://github.com/can1357/oh-my-pi/tree/main/packages/hashline).

Original package description still applies:

> Hashline: a compact, line-anchored patch language and applier. Pluggable
> FS/IO so it works over disk, in-memory, or any custom backend.

## License

Port of MIT-licensed code. Original copyright:
`Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük`.
Derived files carry header attribution; see the inline file headers.

## Port differences

- Native tree-sitter (`enclosingBlockBoundaries` / parse probing) is stubbed:
  `syntax.ts` returns `[]` / `false`, the documented graceful-degradation path.
- `diffLineRuns` and the xxHash utilities are reimplemented in plain JS
  (`src/line-diff.ts`, `src/hash.ts`), matching the original native semantics.
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
