# @deepseek-ai/dsh-tool-edit

Model-facing rich edit tool for the DeepSeek Harness: one `edit` tool with four
edit modes, ported from [oh-my-pi](https://github.com/can1357/oh-my-pi)'s
coding agent (`packages/coding-agent/src/edit`).

- `replace` — literal `old_string` → `new_string` with a progressive fuzzy-match
  fallback ladder (exact → trim → comment-prefix → unicode → prefix → substring →
  Levenshtein fuzzy) and occurrence-preview errors.
- `patch` — structured JSON hunks: `{ path, edits: [{ op: create|update|delete,
  rename?, diff? }] }`, one call per file.
- `apply_patch` — OpenAI-Codex-style `*** Begin Patch … *** End Patch` envelopes,
  multi-file in one call.
- `hashline` — the default mode: a compact, line-anchored patch language backed by
  [`@deepseek-ai/dsh-hashline`](../hashline).

It executes over the harness filesystem seam (`ctx.fs`), so sandbox policy,
fs-observation (read-before-edit) and diff-card presentation apply as with the
other fs tools. When `ctx.lsp` is mounted it performs LSP writethrough —
`formatOnWrite` and `diagnosticsOnEdit` — through the harness LSP seam
(`@deepseek-ai/dsh-lsp` / `@deepseek-ai/dsh-lsp-stdio`).

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

Both packages register a tool named `edit`, so a preset mounts one or the other.
Mount `tool-fs` with `enableEdit: false` for `read`/`write` and this package for
the rich `edit`, e.g.:

```yaml
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    enableEdit: false

- id: tool-edit
  name: '@deepseek-ai/dsh-tool-edit'
  config:
    mode: auto
```

## License / provenance

Ported from @oh-my-pi/pi-coding-agent (MIT). Original copyright:
`Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük`.
Per-file attribution headers are preserved in the sources.
