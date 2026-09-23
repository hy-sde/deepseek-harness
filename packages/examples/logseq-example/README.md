---
description: "Runnable example plugin porting oh-my-pi's LogSeq diary and work-log extensions: two model tools on ctx.tools plus the /diary and /diary-work slash commands on ctx.commands."
kind: "package-reference"
---

# @deepseek-ai/dsh-logseq-example

English | [中文](README.zh.md)

## Summary

`dsh-logseq-example` ports oh-my-pi's `logseq-diary.ts` and `logseq-work.ts` extensions into a runnable Cordis plugin: two model tools on `ctx.tools` (`logseq_diary_ingest`, `logseq_work_log_ingest`) and, with a command registry, the `/diary` and `/diary-work` slash commands. Mount it through the overlay at `examples/logseq/cordis.yml`. Both tools reach the graph only through the `logseq` CLI in JSON mode (`logseq <args> -o json`), so the binary must be on `PATH`; they link mentions to existing pages or record them as pages to create, and skip lines already under the day block. It pins one shallow Logseq layout and is illustrative, not a supported bundle.

## Table of Contents

- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

Runnable example plugin that ports the oh-my-pi `logseq-diary.ts` and `logseq-work.ts` extensions to a DeepSeek Harness Cordis plugin: two model tools on `ctx.tools` (`logseq_diary_ingest`, `logseq_work_log_ingest`) and, when a command registry is composed, the `/diary` and `/diary-work` slash commands on `ctx.commands`.

Mount it through the overlay at [`examples/logseq/cordis.yml`](../../../examples/logseq/cordis.yml):

```sh
dsh web --patch examples/logseq/cordis.yml
```

The tools reach the graph exclusively through the `logseq` CLI in JSON mode (`logseq <args> -o json`), so the binary must be on `PATH`. The diary tool resolves every mention against the graph first and links an existing page or records the name as a page to create; both tools keep `page`/`graph` overridable and skip lines already present under the day block. See [`examples/logseq/README.md`](../../../examples/logseq/README.md) for the user-facing contract.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

## Known Limitations and Deferred Work

- The example pins one shallow Logseq installation layout; other vault arrangements need config changes.
- It is illustrative, not a supported product bundle.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
