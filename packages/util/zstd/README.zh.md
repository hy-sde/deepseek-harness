---
description: "JSONL 会话持久化后端与项目记忆银行共享的 Zstandard 帧原语：不解压即可扫描帧、带校验和的压缩/解压、撕裂帧前缀恢复，以及基于 node:zlib 的可互换多帧解码器。"
kind: "package-reference"
---

# zstd/ — Zstandard 帧原语

[English](README.md) | 中文

## 概述

`dsh-zstd-frame` 提供 JSONL 会话持久化后端与项目记忆银行共享的 Zstandard 帧原语——不解压其数据块即可定位完整帧、每次压缩/解压各自生成一个可独立解码的带校验和帧、从结构不完整的末尾帧恢复可用明文，以及可互换的多帧解码器。当调用方需要在 Node 22+ 上使用自包含 zstd 帧且不引入原生模块时选择它：它完全基于 `node:zlib`。其边界是仅支持 zstd——gzip/bzip2 输入需调用方先解压，且高压缩级别 CPU 开销大，默认值在速度与压缩比之间取舍。

## 目录

- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

`@deepseek-ai/dsh-zstd-frame` 提供 JSONL 会话持久化后端与项目记忆银行共享的Zstandard 帧原语：

- `scanZstdFrames` — 在不解压其块的情况下定位完整帧（校验结构；文件结尾处于某一帧内部时上报其 `tornStart` 以供修复）；
- `compressZstdFrame` / `decompressZstdFrame` — 各自生成一个可独立解码的、带校验和的帧（解压可选用上限）；
- `decompressZstdPrefix` — 从结构不完整的末尾帧中恢复可用的明文字节；
- `createZstdFrameDecoder` — 可互换的多帧解码器（当前 Node 暴露私有流形态时使用 `NodePrivateZstdFrameDecoder`，否则退化到一次性 `PublicZstdFrameDecoder`）。

完全基于 `node:zlib` — 无原生模块，进程内即可工作。`engines.node >= 22`（Node 的 zstd API）。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 仅支持 zstd 帧；gzip/bzip2 输入需调用方先解压。
- 高压缩级别 CPU 开销大；默认值在速度与压缩比之间取舍。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
