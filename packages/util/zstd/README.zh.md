# zstd/ — Zstandard 帧原语

[English](README.md) | 中文

`@deepseek-ai/dsh-zstd-frame` 提供 JSONL 会话持久化后端与项目记忆银行共享的
Zstandard 帧原语：

- `scanZstdFrames` — 在不解压其块的情况下定位完整帧（校验结构；文件结尾处于某一帧内部时上报其 `tornStart` 以供修复）；
- `compressZstdFrame` / `decompressZstdFrame` — 各自生成一个可独立解码的、带校验和的帧（解压可选用上限）；
- `decompressZstdPrefix` — 从结构不完整的末尾帧中恢复可用的明文字节；
- `createZstdFrameDecoder` — 可互换的多帧解码器（当前 Node 暴露私有流形态时使用 `NodePrivateZstdFrameDecoder`，否则退化到一次性 `PublicZstdFrameDecoder`）。

完全基于 `node:zlib` — 无原生模块，进程内即可工作。`engines.node >= 22`（Node 的 zstd API）。
