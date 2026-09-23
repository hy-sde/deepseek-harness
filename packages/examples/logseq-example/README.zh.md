---
description: "可运行的示例插件，移植 oh-my-pi 的 LogSeq 日记与工作日志扩展：在 ctx.tools 上提供两个模型工具，并在 ctx.commands 上提供 /diary 与 /diary-work 斜杠命令。"
kind: "package-reference"
---

# @deepseek-ai/dsh-logseq-example

[English](README.md) | 中文

## 概述

`dsh-logseq-example` 把 oh-my-pi 的 `logseq-diary.ts` 与 `logseq-work.ts` 扩展移植为一个可运行的 Cordis 插件：在 `ctx.tools` 上提供两个模型工具（`logseq_diary_ingest`、`logseq_work_log_ingest`），并在组合了命令注册表时于 `ctx.commands` 上提供 `/diary`、`/diary-work` 斜杠命令。通过 `examples/logseq/cordis.yml` 处的 overlay 挂载。两个工具完全经 JSON 模式下的 `logseq` CLI（`logseq <args> -o json`）访问 graph，因此二进制必须位于 `PATH` 上；它们会把提到的实体链接到现有页面，或把名称记录为待创建页面，并跳过当天块下已存在的行。它固定一种浅层 Logseq 安装布局，仅为演示而非受支持的产品捆绑。

## 目录

- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

可运行的示例插件，把 oh-my-pi 的 `logseq-diary.ts` 与 `logseq-work.ts` 扩展移植为 DeepSeek Harness 的 Cordis 插件：在 `ctx.tools` 上提供两个模型工具（`logseq_diary_ingest`、`logseq_work_log_ingest`），并在组合了命令注册表时，在 `ctx.commands` 上提供 `/diary` 和 `/diary-work` 斜杠命令。

通过 [`examples/logseq/cordis.yml`](../../../examples/logseq/cordis.yml) 处的 overlay 挂载它：

```sh
dsh web --patch examples/logseq/cordis.yml
```

工具完全通过 JSON 模式下的 `logseq` CLI（`logseq <args> -o json`）访问 graph，因此二进制必须位于 `PATH` 上。日记工具会先针对 graph 解析提到的每个实体，并链接现有页面或把该名称记录为待创建页面；两个工具都保持 `page`/`graph` 可覆盖，并跳过已存在于当天块下的行。面向用户的约定详见 [`examples/logseq/README.md`](../../../examples/logseq/README.zh.md)。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 示例固定一种浅层 Logseq 安装布局；其他仓库结构需修改配置。
- 它仅为演示，不是受支持的产品捆绑。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
