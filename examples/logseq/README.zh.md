# LogSeq 日记与工作日志扩展

[English](README.md) | 中文

此 overlay 让一个 `dsh web` 进程显式启用 LogSeq 日记和工作日志记录，同时不改变交付的默认 Web 组合：

```sh
dsh web --patch examples/logseq/cordis.yml
```

它需要 `PATH` 上的 `logseq` CLI（与 oh-my-pi 扩展调用的同一二进制）以及一个 graph，例如默认的 `logseq`：

```sh
logseq graph list -o json
```

一旦挂载，模型可以通过两个工具摄取条目，agent 有两个斜杠命令：

| 载体 | 名称 | 用途 |
|---|---|---|
| 工具 | `logseq_diary_ingest` | 按 年 → 月 → 日 将日记文本追加到 **Life Logs** 页面，并把提到的每个餐厅／地点／人物链接到现有页面或新建页面。 |
| 工具 | `logseq_work_log_ingest` | 按 年 → 月 → 日 将工作日志文本追加到 **Work logs** 页面，原样保存文本且不做链接。 |
| 命令 | `/diary <text>` | 排入一条待摄取的日记条目；接受可选的前导 `YYYY-MM-DD`，默认页面／graph 为 `Life Logs` / `logseq`。 |
| 命令 | `/diary-work <text>` | 排入一条待摄取的工单日志条目；同样接受可选的前导日期，默认页面／graph 为 `Work logs` / `logseq`。 |

两个工具都接受可选的 `page` 和 `graph` 参数，并且按天幂等：已存在于当天块下的行不会重复追加。斜杠命令本身不调用 LogSeq——它们把用户消息引导给 agent，指示其运行相应的工具，与源 oh-my-pi 扩展的行为一致。
