# zstd/ — Zstandard frame primitives

English | [中文](README.zh.md)

`@deepseek-ai/dsh-zstd-frame` provides the Zstandard frame primitives shared by
the JSONL session persistence backend and the project memory bank:

- `scanZstdFrames` — locate complete frames without decompressing their blocks
  (validates structure; EOF inside a final frame reports its `tornStart` for repair);
- `compressZstdFrame` / `decompressZstdFrame` — one independently decodable,
  checksummed frame each (with an optional decompress bound);
- `decompressZstdPrefix` — recover available plaintext from a structurally
  incomplete final frame;
- `createZstdFrameDecoder` — the interchangeable multi-frame decoder
  (`NodePrivateZstdFrameDecoder` where the running Node exposes the private
  stream shape, otherwise one-shot `PublicZstdFrameDecoder`).

Backed entirely by `node:zlib` — no native module, works in-process.
`engines.node >= 22` (Node's zstd API).
