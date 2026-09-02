---
description: "Zstandard frame primitives shared by the JSONL session persistence backend and the project memory bank: frame scanning without decompression, checksummed compress/decompress, torn-frame prefix recovery, and the interchangeable multi-frame decoder over node:zlib."
kind: "package-reference"
---

# zstd/ — Zstandard frame primitives

English | [中文](README.zh.md)

## Summary

`dsh-zstd-frame` provides the Zstandard frame primitives shared by the JSONL session persistence backend and the project memory bank — complete-frame scanning without decompressing their blocks, one independently decodable checksummed frame per compress/decompress call, plaintext recovery from a structurally incomplete final frame, and an interchangeable multi-frame decoder. Choose it when a caller needs self-contained zstd frames on Node 22+ without a native module: it is backed entirely by `node:zlib`. Its boundary is zstd only — gzip/bzip2 inputs must be decompressed by the caller first, and the high compression levels are CPU-heavy, so the defaults trade speed for ratio.

## Table of Contents

- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

`@deepseek-ai/dsh-zstd-frame` provides the Zstandard frame primitives shared by the JSONL session persistence backend and the project memory bank:

- `scanZstdFrames` — locate complete frames without decompressing their blocks (validates structure; EOF inside a final frame reports its `tornStart` for repair);
- `compressZstdFrame` / `decompressZstdFrame` — one independently decodable, checksummed frame each (with an optional decompress bound);
- `decompressZstdPrefix` — recover available plaintext from a structurally incomplete final frame;
- `createZstdFrameDecoder` — the interchangeable multi-frame decoder (`NodePrivateZstdFrameDecoder` where the running Node exposes the private stream shape, otherwise one-shot `PublicZstdFrameDecoder`).

Backed entirely by `node:zlib` — no native module, works in-process. `engines.node >= 22` (Node's zstd API).

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

## Known Limitations and Deferred Work

- Only zstd frames are supported; gzip/bzip2 inputs must be decompressed first by the caller.
- The high compression levels are CPU-heavy; defaults trade speed for ratio.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
