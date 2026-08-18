# Agent Note: Structural AST search and rewrite tools

Status: implemented

English | [中文](2026-08-18-structural-ast-search-and-rewrite-tools.zh.md)

## Problem

The harness's `grep` and `glob` tools match text, not syntax. An agent cannot reliably ask "every call to `foo()`" without also matching comments or strings, cannot express "every class that implements `X`", and cannot rename an identifier at only its declaration sites. Literal string replacement (`str_replace_editor`) is fragile across multi-line rewrites and silently misses nodes that differ in trivia, ordering, or nesting. Porting these structural operations needs a syntax-aware engine with broad grammar coverage and no host install.

A rewrite capability also needs mutation discipline. Raw in-place rewriting (`-U` style) would bypass the harness's filesystem seam, so observation rules, version guards, and sandbox policy would not apply to structural edits.

## Decision

Add `@deepseek-ai/dsh-tool-ast` at `packages/ast/tool-ast` as a two-tool model-facing package over the **packaged ast-grep native binary** (`@ast-grep/cli`), ported from the @oh-my-pi coding-agent tool suite:

1. `ast_grep` — read-only structural search on a tree pattern with metavariables (`$NAME` binds one node, `$_` matches any single node, `$$$NAME` captures zero+ nodes). Returns matches with one-based line/column, the matched node text, and its `$NAME` captures, grouped by file.
2. `ast_edit` — structural rewrite from `pat` to `rewrite` (`$NAME` substitutions from the pattern; an empty rewrite deletes the matched node). **Preview by default** (`apply: false` returns per-file `before`/`after` hunks); `apply: true` writes through `ctx.fs` (`readText` → `fs/edit-intent` → `writeText` with `replaceIfVersion` + sandbox policy).

There is no host `ast-grep` install: the binary ships inside the npm dependency (its postinstall hard-links the matching platform optional package's executable — macOS/Linux/Windows, x64/arm64). Each call spawns the binary through the `ctx.subprocess` seam with a fixed argv vector; model-controlled values are plain argv elements with no shell layer, so no quoting or injection applies. The package injects `tools`, `systemPrompt`, `subprocess`, and `fs`.

## Engine boundary

The seam spawns `ast-grep` CLI with `--json=stream` output; the package owns argv construction, JSON-stream parsing, byte-offset reconciliation, and exit-code classification. Exit codes map to a stable `AST_*` vocabulary via `AstError`:

| ast-grep exit | stderr | Tool result |
|---|---|---|
| 0 | any | success; matches parsed from the JSON stream |
| 1 | empty | success with zero matches |
| 1 | `ERROR: <path>: ...` | `AST_FIND_ERROR` (missing/invalid target) |
| 2 | `error: ...` | `AST_USAGE_ERROR` (unsupported lang, invalid pattern syntax) |
| other | any | `AST_FAILED`; a killed tree becomes `AST_ABORTED` when the cooperative timeout or caller cancellation fired |

Large raw output (> 8 MiB by default) fails `AST_RAW_OUTPUT_OVERFLOW` so a runaway match stream surfaces loudly instead of silently truncating. The package does not expose a background job; a call returns only after ast-grep exits, is terminated by the cooperative timeout, is aborted, or fails.

## Mutations stay in the filesystem seam

`ast_edit` apply does not let ast-grep write files. It reconstructs new file text by applying rewrite hunks in descending byte-offset order, then mutates through `ctx.fs`: emits `fs/observed` then `fs/edit-intent` (the observation watermark, so a write-after-unobserved-read failure is impossible), and writes with `replaceIfVersion` under the deployment's sandbox policy. The engine's `-U/--update-all` flag is never used (it also conflicts with `--json`). This mirrors the [filesystem capability seam](2026-06-17-filesystem-capability-seam.md) decision: structural edits inherit the same observation/version/sandbox guarantees as ordinary edits.

## Config and caps

All config is optional, defaults: `astGrepMaxMatches` 100, `astGrepMaxNodeBytes` 2000, `astEditMaxHunkBytes` 4000, `astEditMaxFiles` 200, `searchMetaMaxBytes` 65536, `rawOutputMaxBytes` 8388608, `graceMs` 3000, `stderrMaxBytes` 65536, `timeoutMs` 30000. The `timeoutMs` budget is enforced by `dsh-tool-call-timeout-policy`.

## Alternatives considered

**Use a pure-TS parser.** Structural analysis needs the full grammar set — the `@ast-grep/cli` distribution covers dozens of languages including TypeScript, Python, Rust, Go, Java, C/C++ and Ruby — which a pure-TS parser cannot cheaply match.

**Let ast-grep write in place (`-U`).** Fast, but bypasses observation, version guards, and sandbox policy, and `-U` conflicts with `--json`. Rewriting as a preview-verify-apply flow through the existing file mutation seam keeps structural edits on the same discipline as ordinary edits.

**Combine into one tool.** Separate search and rewrite keep the read-only tool free of mutation surface and keep the `apply` flag explicit and preview-first.

## Testing

- Engine tests pin argv construction, exit-code classification, JSON-stream parsing, and byte-offset reconciliation (pure pieces exported from `./src/core.ts`).
- Integration tests exercise the packaged binary: preview hunks, apply flow with observation/version guard, abort/timeout classification, and cap behavior. 23 tests total in `packages/ast/tool-ast/tests/`.
- The shipped `code-edit` preset smoke test asserts `ast_grep`, `ast_edit`, and the LSP tool mount.

## Consequences

Structural edits are 1:1: a capture cannot expand into sibling nodes the grammar does not permit at that position, so multi-node restructuring may need several smaller rewrites or a plain file edit. Grammar coverage follows ast-grep, so a niche or very new grammar may be missing or lag. Matches and hunks are byte-capped for preview (with markers, not silent truncation), bounded by `rawOutputMaxBytes` for the whole engine stream. The binary spawn is per call: no persistent server, no cross-call state, at the cost of process spawn latency per invocation.
