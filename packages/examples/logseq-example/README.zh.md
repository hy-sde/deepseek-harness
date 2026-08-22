# @deepseek-ai/dsh-logseq-example

[English](README.md) | 中文

可运行的示例插件，把 oh-my-pi 的 `logseq-diary.ts` 与 `logseq-work.ts` 扩展移植为 DeepSeek Harness 的 Cordis 插件：在 `ctx.tools` 上提供两个模型工具（`logseq_diary_ingest`、`logseq_work_log_ingest`），并在组合了命令注册表时，在 `ctx.commands` 上提供 `/diary` 和 `/diary-work` 斜杠命令。

通过 [`examples/logseq/cordis.yml`](../../../examples/logseq/cordis.yml) 处的 overlay 挂载它：

```sh
dsh web --patch examples/logseq/cordis.yml
```

工具完全通过 JSON 模式下的 `logseq` CLI（`logseq <args> -o json`）访问 graph，因此二进制必须位于 `PATH` 上。日记工具会先针对 graph 解析提到的每个实体，并链接现有页面或把该名称记录为待创建页面；两个工具都保持 `page`/`graph` 可覆盖，并跳过已存在于当天块下的行。面向用户的约定详见 [`examples/logseq/README.md`](../../../examples/logseq/README.zh.md)。
