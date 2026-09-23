---
description: "The model-facing structural code tools ast_grep and ast_edit: packaged ast-grep native binary, subprocess-spawned, with preview-first rewrite through the filesystem seam — for agents choosing where textual grep or literal edit falls short."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ast

English | [中文](README.zh.md)

## Summary

`ast_grep` and `ast_edit` give an agent exact, syntax-aware access to a codebase: find every function, call, or class matching a tree pattern, or rewrite every match to a template after previewing the precise hunks. Both run the packaged ast-grep native binary — no host install, one bounded subprocess per call. Use `ast_grep` when the shape matters and textual grep would be noise; use `ast_edit` for 1:1 structural substitution through the filesystem seam's observation and version guard. The boundary is grammar scope: a capture cannot expand into sibling nodes unless the grammar permits it.

## Table of Contents

- [The two tools](#the-two-tools)
- [Exit-code classification](#exit-code-classification)
- [Config](#config)
- [Engine ownership](#engine-ownership)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

The **model-facing structural code tools**—`ast_grep`, `ast_edit`—are backed by the **packaged ast-grep native binary** (`@ast-grep/cli`), ported from the [@oh-my-pi](https://github.com/oh-my-pi) coding-agent tool suite. Rather than textual grep or literal edit, these tools operate on the syntax tree of the target file: patterns use tree metavariables (`$NAME` binds one node, `$_` matches any single node, `$$$NAME` captures zero+ nodes) so "every call to `foo()`" or "rename every `old` field to `new`" can be expressed exactly.

There is no host `ast-grep` install: the binary ships inside the npm dependency (its postinstall hard-links the matching platform optional package's executable — macOS/Linux/Windows, x64/arm64), so registration is unconditional and the tools work on every supported platform. Each call spawns the binary through the `ctx.subprocess` seam with a fixed argv vector — model-controlled values are plain argv elements; there is no shell layer, so no quoting or injection applies. The package injects `tools`, `systemPrompt`, `subprocess`, and `fs` (the last for `ast_edit` apply, which writes through the filesystem seam with observation + version guard + sandbox policy instead of letting ast-grep touch disk directly).

```ts ignore-check
// A deployment adds the engine (already an npm dependency) and the two tools.
await ctx.plugin(LocalSubprocessRuntime)                     // @deepseek-ai/dsh-subprocess-local
await ctx.plugin(LocalFileSystem)                            // @deepseek-ai/dsh-fs-local
await ctx.plugin(ToolAst)                                    // @deepseek-ai/dsh-tool-ast
```

Why spawn-backed: structural analysis needs the full grammar set — the `@ast-grep/cli` distribution covers dozens of languages including TypeScript, Python, Rust, Go, Java, C/C++ and Ruby — which a pure-TS parser cannot cheaply match; and rewriting is safest as a preview-verify-apply flow through the existing file mutation seam, not a raw `-U` file write. The subprocess seam owns spawn execution, process-tree termination, environment scrubbing, and bounded output capture; this package owns schemas, validation, argv construction, JSON-stream parsing, byte-offset reconciliation for apply, result caps/presentation, and timeout declaration. Neither tool exposes a background job — a call returns only after ast-grep exits, is terminated by the cooperative timeout, is aborted, or fails.

## The two tools

- `ast_grep` — read-only structural **search**. `pat` is required; `path` (defaults to the session workspace; multiple roots separated by `;`), `include` (one glob filter), `lang`, and `strictness` refine the scope. Returns matches with 1-based line/column, the matched node text, and its `$NAME` captures — grouped by file.
- `ast_edit` — structural **rewrite**. `pat` + `rewrite` (`$NAME` substitutions from the pattern; an empty rewrite deletes the matched node). **Preview by default** — `apply: false` returns per-file `before`/`after` hunks without touching disk; pass `apply: true` to write. Writes go through `ctx.fs` (`readText` → `fs/edit-intent` → `writeText` with `replaceIfVersion` + sandbox policy), so the observation/version guard and the deployment's sandbox mode apply exactly as they would to a normal edit.

## Exit-code classification

ast-grep's exit codes are mapped into a stable `AST_*` vocabulary:

| ast-grep exit | stderr | Tool result |
|---|---|---|
| 0 | any | success; matches parsed from the JSON stream |
| 1 | empty | success with zero matches |
| 1 | `ERROR: <path>: ...` | `AST_FIND_ERROR` (missing/invalid target) |
| 2 | `error: ...` | `AST_USAGE_ERROR` (unsupported lang, invalid pattern syntax) |
| other | any | `AST_FAILED`; a killed tree becomes `AST_ABORTED` when the cooperative timeout or caller cancellation fired |

Large raw output (> 8 MiB by default) fails `AST_RAW_OUTPUT_OVERFLOW` so a runaway match stream surfaces loudly instead of silently truncating.

## Config

All keys are optional with the defaults below.

| Key | Default | Meaning |
|---|---|---|
| `astGrepMaxMatches` | `100` | Largest number of matches one `ast_grep` call returns inline; later matches are omitted with a notice. |
| `astGrepMaxNodeBytes` | `2000` | Byte cap per previewed matched-node text (the cut preserves UTF-8 boundaries and is marked). |
| `astEditMaxHunkBytes` | `4000` | Byte cap per `ast_edit` before/after hunk side. |
| `astEditMaxFiles` | `200` | Largest number of files one `ast_edit` run reports (and, in apply mode, writes). |
| `searchMetaMaxBytes` | `65536` | Largest serialized `presentationMeta` for one result (the UI search/diff card payload). |
| `rawOutputMaxBytes` | `8388608` | Largest raw engine stdout a run will parse. |
| `graceMs` | `3000` | Terminate-escalation grace for the ast-grep process tree, bounded by the platform max timer delay. |
| `stderrMaxBytes` | `65536` | Max retained stderr tail bytes for failure excerpts. |
| `timeoutMs` | `30000` | Cooperative tool-call timeout budget on both tools. |

## Engine ownership

This package errors with its own stable codes (`AST_*` via `AstError`) so tool results and replay retain failure class without coupling to ripgrep's `SEARCH_*` or the filesystem's `FS_*` vocabularies. The pure pieces — argv building, JSON-stream parsing, byte-to-index conversion — are exported from `./src/core.ts` for direct tests.

## Model Experience

### System prompt

#### What the model sees

Two system-prompt sections independently registered by this plugin — `tool:ast-grep` (order 105) and `tool:ast-edit` (order 106) — position structural search and rewrite. Scoped tool restrictions can hide either schema without removing its prompt section.

##### ast_grep guidance

```markdown
Use ast_grep for STRUCTURAL code search (syntax-aware, not textual): find every function, call, class, or declaration matching a tree pattern. Patterns use metavariables like $NAME (bind one node) or $_ (wildcard); e.g. `console.log($MSG)` finds every console.log call. Prefer ast_grep over grep when the shape matters (e.g. "all calls to foo()", "every class implementing X"). A pattern that is only "kinda text-like" is often better served by grep.
```

##### ast_edit guidance

```markdown
Use ast_edit for STRUCTURAL rewrite: replace every node matching an AST pattern with a template that can reference captured metavars ($NAME). It always PREVIEWS first (apply defaults to false) so you can verify the hunks; pass apply: true to actually write the files. Rewrites are 1:1 structural substitutions: a capture cannot expand into sibling nodes unless the grammar permits it at that position.
```

#### Token effect

Fixed guidance cost per request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged; activation or disposal may invalidate reuse from this section.

### Tool schemas

#### What the model sees

The generated [`ast_grep` and `ast_edit` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ast). `ast_grep` requires `pat`; `ast_edit` requires `pat` and `rewrite` and exposes the preview-first `apply` flag.

#### Token effect

Fixed schema cost on every request while enabled; the `timeoutMs` budget is never sent to the model.

#### KV Cache effect

Prefix-stable while the visible tool definitions and order are unchanged; registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

### Results

#### What the model sees

`ast_grep` returns 1-based `path:line:column` rows with each matched node's text and its captures, grouped by file; a capped result ends with its omission notice. `ast_edit` returns per-file `before`/`after` hunks (preview by default) and, in apply mode, the file outcome — hunks render as a diff card in the UI. Empty searches say so distinctly. Presentation caps (`astGrepMaxMatches`, `astGrepMaxNodeBytes`, `astEditMaxFiles`, `astEditMaxHunkBytes`) apply only to model presentation; a raw-output overflow fails `AST_RAW_OUTPUT_OVERFLOW` loudly.

#### Token effect

Capped per tool result by the same presentation caps; the call and retained result remain in history until compaction.

#### KV Cache effect

Tool results append after the cached request prefix and do not directly invalidate it.

### UI presentation

#### What the model sees

Nothing. The client renders a generic search card for `ast_grep` — `{ card: 'generic', kind: 'search', title, locations }` — and a diff card for `ast_edit` with the proposed hunks, both built from persisted `presentationMeta`.

#### Token effect

Zero direct token effect because rendering is client-side only.

#### KV Cache effect

None; UI presentation is outside the model request.

## Known Limitations and Deferred Work

- **Grammar coverage follows ast-grep** — dozens of languages are supported, but a niche or very new grammar may be missing or lag; a syntax error in a pattern may surface as `AST_USAGE_ERROR`.
- **Structural rewrite is 1:1** — a capture cannot expand into sibling nodes the grammar does not permit at that position; multi-node restructuring may need several smaller rewrites or a plain file edit.
- **Preview size caps** — matched-node and hunk previews are byte-capped; an enormous match or hunk is cut (with a marker) rather than silently dropped, and `rawOutputMaxBytes` bounds the whole engine stream.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
