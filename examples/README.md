# Examples

English | [中文](README.zh.md)

Runnable demonstrations of the main DeepSeek Harness interfaces and extension points. Each child directory owns its configuration, prerequisites, commands, and detailed behavior.

## mcp-memory

Optional overlays that connect supported third-party memory servers through the generic MCP client. See the [memory example reference](mcp-memory/README.md).

## headless-agent

A non-interactive agent that accepts one task, runs it, and emits a selected machine-readable or human-readable output format. See the [headless example reference](headless-agent/README.md).

## jsonrpc-agent

An unattended coding agent driven through the Python SDK and JSON-RPC. See the [JSON-RPC example reference](jsonrpc-agent/README.md).

## web-cordis

A self-referential agent that can inspect and change its in-memory Cordis plugin tree. See the [web-cordis example reference](web-cordis/README.md).

## web-schedule

An opt-in Web overlay for durable, Session-local reminders. It supports positive whole-second `after_seconds` delays and absolute `at` targets through `schedule_create`, `schedule_list`, and `schedule_delete`; active reminders persist in the original Session, resume when that Session becomes live again, and do not run while it is cold. Run `dsh web --patch examples/web-schedule/cordis.yml`; see [web-schedule/README.md](web-schedule/README.md) for absolute-time authority, delivery, and recovery boundaries.

## logseq

An opt-in Web overlay that ports the oh-my-pi `logseq-diary.ts` and `logseq-work.ts` extensions: the `logseq_diary_ingest` and `logseq_work_log_ingest` model tools plus `/diary` and `/diary-work` slash commands, driving the `logseq` CLI against a graph. Run `dsh web --patch examples/logseq/cordis.yml`; see [logseq/README.md](logseq/README.md).

## acp-agent

An Agent Client Protocol automation server for programmatic clients, with session, permission, and cancellation support. See the [ACP example reference](acp-agent/README.md).
