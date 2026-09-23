---
description: "The edit package group: the Hashline line-anchored patch language and the model-facing rich edit tool, for deployments choosing or wiring the editor capability family."
kind: "package-group"
---
# edit/ - rich editor capability family

English | [中文](README.zh.md)

A compact, line-anchored patch language and a model-facing rich `edit` tool over the filesystem seam. Ported from the @oh-my-pi coding-agent tool suite. All **product** packages.

## Summary

The edit group gives deployments the rich editor capability family: a compact line-anchored patch language and a model-facing `edit` tool over the filesystem seam, ported from the @oh-my-pi coding-agent tool suite. All packages in the group are **product** packages. `hashline/` is the pure computation library behind line-anchored patches; `tool-edit/` owns the model-facing tool with replace / patch / apply_patch / hashline modes and optional LSP format-on-write.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The `edit` name is deployment-owned: mount `tool-edit` alongside `tool-fs` and disable `tool-fs`'s `edit` registration (`enableEdit: false`) so the rich editor owns the name. Writes go through `ctx.fs` with observation and sandbox policy, exactly like ordinary edits.

| Package | Role | ctx key |
|---|---|---|
| `hashline/` | Hashline: compact line-anchored patch language and applier (pure computation library) | (none) |
| `tool-edit/` | Model-facing `edit` tool (replace / patch / apply_patch / hashline modes) over `ctx.fs`, with optional LSP format-on-write and diagnostics | (registers on `ctx.tools`) |

<a id="related-documentation"></a>
## Related documentation

- [Filesystem subsystem](../../docs/subsystems/filesystem.md) — read/search/snapshot semantics the editor's seen-line checks build on.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
