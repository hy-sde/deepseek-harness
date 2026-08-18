# @deepseek-ai/dsh-hashline

[English](README.md) | 中文

Hashline：一种紧凑、以行为锚定的补丁语言与应用器，移植自
[@oh-my-pi/hashline](https://github.com/can1357/oh-my-pi/tree/main/packages/hashline)。

原包的描述仍然适用：

> Hashline：一种紧凑、以行为锚定的补丁语言与应用器。FS/IO 可插拔，因此可以运行在磁盘、内存或任何自定义后端之上。

## 许可证

MIT 许可代码的移植。原始版权：
`Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük`。
派生文件带有头部署名；请参见各文件的头部注释。

## 移植差异

- 原生 tree-sitter（`enclosingBlockBoundaries` / 解析探测）被 stub：
  `syntax.ts` 返回 `[]` / `false`，即文档所述的优雅降级路径。
- `diffLineRuns` 与 xxHash 工具以纯 JS 重新实现
  （`src/line-diff.ts`、`src/hash.ts`），语义与原生实现一致。
- 小型 LRU 缓存以内联方式重新实现（`src/lru.ts`）。

除此之外，该移植与原源代码在算法上保持 1:1 一致。

包 API：

```ts
import { Patch, Patcher, applyEdits, InMemoryFilesystem } from '@deepseek-ai/dsh-hashline'
```

- `Patch.parse(input, { cwd })` — 把 hashline 补丁解析为多个 section。
- `Patcher` — 应用带快照／恢复支持的 section。
- `Filesystem` — 可插拔的文件 IO（自行实现 `writeText`/`readText`/… 以接入 harness）。
- 完整导出面请参见 `src/index.ts`。
