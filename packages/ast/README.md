---
description: "The ast/ package group: syntax-aware structural search and rewrite over the packaged ast-grep native binary, for readers choosing or navigating the family."
kind: "package-group"
---

# ast/ - structural code capability family

English | [中文](README.zh.md)

## Summary

The `ast/` group provides [`tool-ast/`](tool-ast/README.md). Together with the rich editor (`edit/`) and the language-server capability (`lsp/`), it completes the text → AST → semantics ladder for model-driven code work: `ast_grep` finds nodes by tree pattern with metavariables (`$NAME` binds one node, `$_` matches any single node, `$$$NAME` captures zero+ nodes), and `ast_edit` rewrites every match to a template after previewing the hunks. All packages are **product** packages, ported from the @oh-my-pi coding-agent tool suite.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| `tool-ast/` | Model-facing `ast_grep` (structural search) and `ast_edit` (preview / apply structural rewrite) tools backed by the packaged `@ast-grep/cli` binary spawned through `ctx.subprocess` | (registers on `ctx.tools`) |

`ast_grep` finds nodes by tree pattern with metavariables; `ast_edit` rewrites matches to a template and always previews before `apply: true` writes through `ctx.fs` (observation + version guard + sandbox policy). Designed to sit beside the rich editor (`edit/`) and the language-server capability (`lsp/`): textual shape → ast structural power → semantic navigation.

<a id="related-documentation"></a>
## Related documentation

- [Structural AST search and rewrite Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-structural-ast-search-and-rewrite-tools.md) — the design rationale, including why rewrites go through the filesystem seam instead of `-U` in-place updates and how exit codes map to the stable `AST_*` vocabulary.
