---
description: "Model-facing rich edit tool with replace, patch, apply_patch, and hashline modes over ctx.fs, plus optional LSP format-on-write and diagnostics, ported from oh-my-pi's coding agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-edit

English | [中文](README.zh.md)

## Summary

`dsh-tool-edit` gives the model one `edit` tool with four modes — literal `replace` with a progressive fuzzy-match ladder, structured `patch` hunks, Codex-style `apply_patch` envelopes, and the default line-anchored `hashline` mode. It executes over the harness `ctx.fs` seam, so sandbox policy, read-before-edit observation, and diff-card presentation apply, and it supports optional LSP writethrough when `ctx.lsp` is mounted. Choose it over the `tool-fs` edit variant when the rich four-mode editor is wanted; mount one or the other, since both register a tool named `edit`.

## Table of Contents

- [Configuration](#configuration)
- [Coexistence with `tool-fs`](#coexistence-with-tool-fs)
- [License / attribution](#license--attribution)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Model-facing rich edit tool for the DeepSeek Harness: one `edit` tool with four edit modes, ported from [oh-my-pi](https://github.com/can1357/oh-my-pi)'s coding agent (`packages/coding-agent/src/edit`).

- `replace` — literal `old_string` → `new_string` with a progressive fuzzy-match fallback ladder (exact → trim → comment-prefix → unicode → prefix → substring → Levenshtein fuzzy) and occurrence-preview errors.
- `patch` — structured JSON hunks: `{ path, edits: [{ op: create|update|delete, rename?, diff? }] }`, one call per file.
- `apply_patch` — OpenAI-Codex-style `*** Begin Patch … *** End Patch` envelopes, multi-file in one call.
- `hashline` — the default mode: a compact, line-anchored patch language backed by [`@deepseek-ai/dsh-hashline`](../hashline).

It executes over the harness filesystem seam (`ctx.fs`), so sandbox policy, fs-observation (read-before-edit) and diff-card presentation apply as with the other fs tools. When `ctx.lsp` is mounted it performs LSP writethrough — `formatOnWrite` and `diagnosticsOnEdit` — through the harness LSP seam (`@deepseek-ai/dsh-lsp` / `@deepseek-ai/dsh-lsp-stdio`).

## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `mode` | `auto` | Edit variant: `auto`/`hashline`/`replace`/`patch`/`apply_patch`. |
| `fuzzyMatch` | `true` | Allow high-confidence fuzzy replacement matching. |
| `fuzzyThreshold` | `0.95` | Similarity threshold for fuzzy matches. |
| `enforceSeenLines` | `false` | Hashline: require sealed/seen lines in patches. |
| `formatOnWrite` | `false` | LSP-format the file after writing. |
| `diagnosticsOnEdit` | `false` | Collect LSP diagnostics after writing and surface them. |
| `diagnosticsDeduplicate` | `true` | Suppress diagnostics already surfaced for a file. |
| `description` | mode guide | Optional model-facing description override. |

## Coexistence with `tool-fs`

Both packages register a tool named `edit`, so a preset mounts one or the other. Mount `tool-fs` with `enableEdit: false` for `read`/`write` and this package for the rich `edit`, e.g.:

```yaml
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    enableEdit: false

- id: tool-edit
  name: '@deepseek-ai/dsh-tool-edit'
  config:
    mode: hashline
```

## License / attribution

Ported from @oh-my-pi/pi-coding-agent (MIT). Original copyright: `Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük`. Per-file attribution headers are preserved in the sources.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

## Model Experience

### Tool schema

#### What the model sees

`dsh-tool-edit` owns the read/write/edit tool schemas and result rendering; see [`@deepseek-ai/dsh-tool-edit`](../../../docs/tool-catalog.md#deepseek-aidsh-tool-edit) for the registered entry points.

#### Token effect

Tool schemas plus the bundled guidance paragraphs per request while the plugin is mounted.

#### KV Cache effect

The guidance paragraphs are stable request-prefix text; reissued requests reuse the same prefix when the edit mode is unchanged.

## Known Limitations and Deferred Work

- Fuzzy replacement can misapply when old strings are short or repetitive; enforcers mitigate but cannot eliminate this.
- LSP diagnostics formatting depends on the workspace having a diagnosed language server.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
