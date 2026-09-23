---
description: "Pure-TS multi-format archive engine (zip, tar, tar.gz, rar, 7z, iso, deb, rpm, cpio, cab, arj, asar) plus codecs, listing and reading members behind the read tool, ported from @oh-my-pi/pi-utils."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-archive

English | [中文](README.zh.md)

## Summary

`dsh-fs-archive` is the pure-TS multi-format archive engine behind the harness `read` tool: it sniffs or infers the format of zip, tar, tar.gz, rar, 7z, iso, deb, rpm, cpio, cab, arj, and asar containers, and lists roots, directories, and members as text via `openArchive`. Choose it when a tool must resolve `archive.ext:member/path` references; bounded `ArchiveLimits` keep attacker-controlled archives from driving unbounded allocation. Main costs: indexing loads the archive into memory up to `readMaxArchiveBytes` (default 256 MiB), and archive writing is not exposed. It is an algorithmically 1:1 port of an MIT-licensed original, reimplemented on Node.

## Table of Contents

- [Port differences](#port-differences)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [License](#license)
- [Dev Note](#dev-note)

-----

A pure-TS multi-format archive engine — zip, tar, tar.gz, rar, 7z, iso, deb, rpm, cpio, cab, arj, asar — plus the codec layer (gzip, bzip2, ncompress LZW, xz, deflate, zstd) behind them. Ported from [@oh-my-pi/pi-utils](https://github.com/can1357/oh-my-pi/tree/main/packages/utils/src/ar).

The engine is the durable core of the harness `read` tool's multi-format support: `foo.zip` lists an archive's root, `foo.zip:dir` lists a directory, and `foo.zip:dir/file.txt` reads one member as text.

Format detection sniffs content signatures (`sniffArchiveFormat`) and falls back to extension inference (`archiveFormatFromPath`); member reads are bounded by `ArchiveLimits` (entry count, index size, in-memory size, member size, path bytes, link depth) so attacker-controlled archives cannot drive unbounded allocation.

## Port differences

- No `Bun` runtime: `Bun.hash.crc32` is table-driven CRC-32, `Bun.CryptoHasher` is `node:crypto` SHA-256, and `Bun.file` / `Bun.write` are `node:fs` / `node:fs/promises` equivalents.
- All relative imports carry the `.ts` extension (repo `rewriteRelativeImportExtensions`).
- `formatBytes`, the small `LRUCache`, and the public `index.ts` surface replace the upstream package-level re-exports; tests load fixtures from one bundled `tar.gz` (the same layout upstream uses to keep checkout state quiet).

Otherwise the port is algorithmically 1:1 with the original source.

## Known Limitations and Deferred Work

- `read` tool member reads go through `ctx.fs.readBytes` with a bounded `readMaxArchiveBytes` (default 256 MiB): the archive file is loaded into memory for indexing. No streaming/local `fileByteSource` path is wired into the tool yet, so very large archives stay beyond the cap even though the engine itself supports lazy source reads.
- The `read` tool serves member text and listings only; archive *writing* is not exposed (no tool, no edit path inside archives) — members are immutable.
- Detection needs either content sniffing or an archive extension on the path; a member named with a supported archive extension inside a container is interpreted by longest-prefix rules from `parseArchivePathCandidates`.

Package API:

```ts
import {
  openArchive,
  parseArchivePathCandidates,
  sniffArchiveFormat,
  formatArchiveEntryLines,
} from '@deepseek-ai/dsh-fs-archive'
```

- `openArchive(source, options)` — open a file path or `{ bytes, format }` into an `ArchiveReader`; `getNode` resolves members, `listDirectory` lists, `readFile` reads one member's bytes, `indexEntries` enumerates.
- `parseArchivePathCandidates(filePath)` — split `archive.ext:member/path` into resolution candidates (longest archive prefix first).
- `sniffArchiveFormat(bytes)` / `archiveFormatFromPath(path)` — format rules.
- `formatArchiveEntryLines(entries)` — one line per member, `name/` for directories and `name (size)` for files.
- See `src/index.ts` for the full export surface.

## License

Port of MIT-licensed code. Original copyright: `Copyright (c) 2025-2026 Can Bölük` and contributors. Derived files carry header attribution; see the inline file headers.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
