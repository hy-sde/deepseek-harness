# Agent Note: Drop str_replace_editor entirely; `minimal` is the rich two-tool preset

Status: implemented

English | [中文](2026-08-18-drop-str-replace-editor-tool.zh.md)

## Problem

The shipped `minimal` preset exposed persistent `bash` plus `str_replace_editor`
(`@deepseek-ai/dsh-tool-str-replace-editor`) as its exact two-tool roster, and a
second variant `minimal-code-edit` mounted the rich editor (`tool-fs` with
`enableEdit: false`, plus `tool-edit` in `mode: auto`) under the same two-tool
contract. Two presets that advertised nearly identical carriers made the shipped
surface ambiguous: which one is "the" minimal agent? The standalone
`str-replace-editor` plugin also duplicated the read/write/edit seam that the
rich editor owns, so keeping it shipped (even unmounted) left a third editing
schema in the package catalog and in generated documentation.

## Decision

- Remove the `minimal` and `minimal-code-edit` duplication: delete the old
  `minimal` preset and rename `minimal-code-edit` to `minimal`. The renamed
  preset keeps its original composition contract — persistent `bash` plus the
  rich `edit` tool (replace / patch / apply_patch / hashline) over `tool-fs`
  read/write — and takes over the `极简模式` display name and roster order.
- Delete `packages/fs/tool-str-replace-editor` and the `str_replace_editor`
  schema entirely: package directory, bundle rows (base and web-app),
  workspace dependencies, `tsconfig.host.json` project reference, the
  benchmark/smoke script special-cases, the generated tool/config catalogs and
  their Chinese mirrors, and the documentation that described the standalone
  editor as a shipped capability.
- Ship no string-replacement editor at all. Read, write, and `edit` from
  `tool-fs` + `tool-edit` are the only model-facing mutation surface.

This supersedes the earlier [single-editor decision](
2026-08-10-default-presets-single-editor.md), which kept the `minimal` preset on
`str_replace_editor` beside persistent `bash`; that note's exception no longer
applies because the plugin is gone, not merely unmounted.

## Alternatives considered

**Keep `str_replace_editor` as an optional standalone package.** Rejected: an
unmounted shipped package still appears in catalogs, module graphs, and release
artifacts, and its view/create/str_replace/insert vocabulary overlaps the rich
`edit` without the diff-rendering, observation-policy integration, and patch
formats the editor provides.

**Keep `minimal` and `minimal-code-edit` as two presets.** Rejected: the two-tool
carrier became identical once `minimal`'s editor slot switched to the rich tool;
two presets with byte-similar compositions and different display names only
confused the Web preset picker.

## Consequences

- The packed `minimal` preset now mounts bash (`dsh-tool-bash-persistent`) and
  read/write + `edit` (`tool-fs` with `enableEdit: false`, `tool-edit` in
  `mode: auto`), plus the PTY and bare `fs-local` backends behind their isolated
  realms. Its persona remains the complete system prompt with runtime-context
  suppressed, and context compaction stays absent.
- `examples/jsonrpc-agent/minimal.cordis.yml` (the standalone SDK twin) uses the
  same rich-editor rows; the Python SDK model-visible snapshot and the SDK smoke
  follow-up now drive `write` instead of `str_replace_editor` `create`.
- Tool-catalog, config-catalog, module-graph, event-producer-consumer, and
  subsystem pages no longer list `str_replace_editor` in either language.
- The oh-my-pi edit-benchmark driver moved out of the harness: with the
  standalone string-replacement editor gone, `scripts/run-edit-benchmark.ts`
  and `scripts/summarize-edit-benchmark.ts` were deleted (the benchmark now
  lives in a separate plugin repo) and nothing in the repo references them.
- Preset composition tests pin the minimal roster as
  `bash`, `edit`, `read`, `read_image`, `write` and assert no search/ask/todo
  rows; the web minimal snapshot and the preset-authoring goldens were updated
  to match. The 2026-08-10 [single-editor note](
  2026-08-10-default-presets-single-editor.md) keeps its rationale but its
  minimal-preset exception is superseded by this note; both are cross-linked.
