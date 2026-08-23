# @deepseek-ai/dsh-fs-archive

[English](README.md) | 中文

一种纯 TypeScript 的多格式归档引擎——zip、tar、tar.gz、rar、7z、iso、deb、rpm、cpio、cab、arj、asar——以及其背后的编解码层（gzip、bzip2、ncompress LZW、xz、deflate、zstd）。移植自 [@oh-my-pi/pi-utils](https://github.com/can1357/oh-my-pi/tree/main/packages/utils/src/ar)。

该引擎是 harness `read` 工具多格式读取能力的核心：`foo.zip` 列出归档根目录，`foo.zip:dir` 列出子目录，`foo.zip:dir/file.txt` 以文本读取某个成员。

格式检测通过内容特征嗅探（`sniffArchiveFormat`），并回退到扩展名推断（`archiveFormatFromPath`）；成员读取受 `ArchiveLimits` 限制（条目数、索引大小、内存大小、成员大小、路径字节数、链接深度），因此恶意构造的归档无法驱动无界内存分配。

## 移植差异

- 无 `Bun` 运行时：`Bun.hash.crc32` 改为表驱动 CRC-32，`Bun.CryptoHasher` 改为 `node:crypto` SHA-256，`Bun.file` / `Bun.write` 改为 `node:fs` / `node:fs/promises` 等价实现。
- 所有相对导入携带 `.ts` 扩展名（仓库 `rewriteRelativeImportExtensions`）。
- `formatBytes`、小型 `LRUCache` 和公开的 `index.ts` 导出面取代了上游包级再导出；测试从一个打包的 `tar.gz` 加载夹具（与上游保持检出状态安静的布局一致）。

除此之外，该移植与原始源码在算法上为 1:1。

## 已知限制与待办工作

- `read` 工具的成员读取通过 `ctx.fs.readBytes` 并受限于 `readMaxArchiveBytes`（默认 256 MiB）：归档文件会整体载入内存进行索引。目前尚未将流式/本地 `fileByteSource` 路径接入工具，因此即使引擎本身支持惰性源码读取，超大归档仍会超出上限。
- `read` 工具仅提供成员文本与目录列表；归档*写入*不暴露（无工具、归档内无编辑路径）——成员不可变。
- 检测要么依赖内容嗅探，要么依赖路径上的归档扩展名；指向容器内、名称带受支持归档扩展名的成员时，由 `parseArchivePathCandidates` 的最长前缀规则解释。

包 API：

```ts
import {
  openArchive,
  parseArchivePathCandidates,
  sniffArchiveFormat,
  formatArchiveEntryLines,
} from '@deepseek-ai/dsh-fs-archive'
```

- `openArchive(source, options)` — 将文件路径或 `{ bytes, format }` 打开为 `ArchiveReader`；`getNode` 解析成员，`listDirectory` 列出目录，`readFile` 读取单个成员的字节，`indexEntries` 枚举全部条目。
- `parseArchivePathCandidates(filePath)` — 将 `archive.ext:member/path` 拆分为解析候选（最长的归档前缀优先）。
- `sniffArchiveFormat(bytes)` / `archiveFormatFromPath(path)` — 格式判定规则。
- `formatArchiveEntryLines(entries)` — 每行一个成员，目录以 `name/` 表示，文件以 `name (size)` 表示。
- 完整导出面见 `src/index.ts`。

## 许可证

MIT 许可代码的移植。原始版权：`Copyright (c) 2025-2026 Can Bölük` 及贡献者。派生文件带有文件头署名；详见各文件头部。
