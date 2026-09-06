---
description: "Internal URL grammar and resolver for harness-owned references such as conflicts, issue-PR links, and workspace paths read and written by the read/grep tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-internal-urls

English | [中文](README.zh.md)

## Summary

`dsh-fs-internal-urls` defines the grammar the harness uses for internal references and resolves them against the open workspace: `conflict://` spans, `pr://owner/repo/…` issue and pull-request links, and the read/grep-tool URL forms. It is a lexical resolver — it normalizes and opens the referenced resource, but makes no content decisions; the read/grep tools own every model-facing effect of these references.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load this plugin when the host should accept harness-internal references from model calls to `read`, `write`, and `search`. Each registered scheme maps a reference string to a resolved file span or external document.

### Registered schemes

| Scheme | Resolves to | Registered by |
|---|---|---|
| `conflict://<source>/<line>` | A conflict span in the working tree, with source attribution. | this package |
| `issue://owner/repo/<kind>/<num>` / `pr://owner/repo/<kind>/<num>` | The GitHub issue or pull request document for the open repo. | this package |
| `session://<id>` | A session transcript or one event (see `dsh-session-url`). | `dsh-session-url` |
| `memory://root` / `memory://<id>` | The calling project's memory overview, or one stored entry by recall id (see `dsh-memory`). | `dsh-memory` |
| `rule://<name>` | One active stream rule of the calling session (see `dsh-stream-rules`). | `dsh-stream-rules` |
| `agent://<id>` / `agent://<id>/<child>` | A session-backed subagent's final output (see `dsh-subagent`). | `dsh-subagent` |
| `fs://…` | A workspace or host path, normalized against the current working directory. | this package |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Resolution is purely lexical: the plugin matches a scheme, normalizes the path, and hands the resolved reference to the consuming tool. It never touches network credentials or host secrets; the upstream document fetch is delegated to the tool that owns the scheme.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Reading and searching](../../fs/tool-fs/README.md) — the tools that consume these resolved references.
- [Git history](../../git/git/README.md) — the working-tree sources behind `conflict://` spans.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Resolution is lexical; symlinks and non-UTF-8 paths can make the resolved reference diverge from the real file.
- The grammar is tuned for the harness's own refs; third-party URL conventions need new patterns.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
