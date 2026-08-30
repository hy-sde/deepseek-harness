# Examples

English | [中文](README.zh.md)

Runnable demonstrations of the main DeepSeek Harness interfaces and extension points. Each child directory owns its configuration, prerequisites, commands, and detailed behavior.

## jsonrpc-agent

An unattended coding agent driven through the Python SDK and JSON-RPC. See the [JSON-RPC example reference](jsonrpc-agent/README.md).

## logseq

An opt-in Web overlay that ports the oh-my-pi `logseq-diary.ts` and `logseq-work.ts` extensions: the `logseq_diary_ingest` and `logseq_work_log_ingest` model tools plus `/diary` and `/diary-work` slash commands, driving the `logseq` CLI against a graph. Run `dsh web --patch examples/logseq/cordis.yml`; see [logseq/README.md](logseq/README.md).
