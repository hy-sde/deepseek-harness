# @deepseek-ai/dsh-logseq-example

Runnable example plugin that ports the oh-my-pi `logseq-diary.ts` and `logseq-work.ts` extensions to a DeepSeek Harness Cordis plugin: two model tools on `ctx.tools` (`logseq_diary_ingest`, `logseq_work_log_ingest`) and, when a command registry is composed, the `/diary` and `/diary-work` slash commands on `ctx.commands`.

Mount it through the overlay at [`examples/logseq/cordis.yml`](../../../examples/logseq/cordis.yml):

```sh
dsh web --patch examples/logseq/cordis.yml
```

The tools reach the graph exclusively through the `logseq` CLI in JSON mode (`logseq <args> -o json`), so the binary must be on `PATH`. The diary tool resolves every mention against the graph first and links an existing page or records the name as a page to create; both tools keep `page`/`graph` overridable and skip lines already present under the day block. See [`examples/logseq/README.md`](../../../examples/logseq/README.md) for the user-facing contract.
