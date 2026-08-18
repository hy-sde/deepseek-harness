# LogSeq diary and work-log extension

English | [中文](README.zh.md)

This overlay opts one `dsh web` process into LogSeq diary and work-log logging without changing the shipped default Web composition:

```sh
dsh web --patch examples/logseq/cordis.yml
```

It needs the `logseq` CLI on `PATH` (the same binary the oh-my-pi extensions invoke) and a graph such as the default `logseq`:

```sh
logseq graph list -o json
```

Once mounted, the model can ingest entries with two tools and the agent has two slash commands:

| Surface | Name | Purpose |
|---|---|---|
| Tool | `logseq_diary_ingest` | Append diary text to the **Life Logs** page under year → month → day, linking each mentioned restaurant/place/person to an existing page or creating a new one. |
| Tool | `logseq_work_log_ingest` | Append work-log text to the **Work logs** page under year → month → day, storing the text as-is without linking. |
| Command | `/diary <text>` | Queue a diary entry for ingest; accepts optional leading `YYYY-MM-DD` and defaults the page/graph to `Life Logs` / `logseq`. |
| Command | `/diary-work <text>` | Queue a work-log entry for ingest; same optional leading date, defaults the page/graph to `Work logs` / `logseq`. |

Both tools accept optional `page` and `graph` parameters and are idempotent per day: lines already present under the day block are not appended twice. The slash commands do not call LogSeq themselves — they steer a user message to the agent instructing it to run the corresponding tool, matching the source oh-my-pi extension's behavior.
