# 示例

[English](README.md) | 中文

展示 DeepSeek Harness 主要接口和扩展点的可运行演示。每个子目录负责自己的配置、前置条件、命令和详细行为。

## jsonrpc-agent

由 Python SDK 和 JSON-RPC 驱动的无人值守编码 agent。详见 [JSON-RPC 示例参考](jsonrpc-agent/README.zh.md)。

## logseq

可选的 Web overlay，移植了 oh-my-pi 的 `logseq-diary.ts` 与 `logseq-work.ts` 扩展：提供 `logseq_diary_ingest` 和 `logseq_work_log_ingest` 两个模型工具，以及 `/diary` 和 `/diary-work` 斜杠命令，驱动 `logseq` CLI 操作一个 graph。使用 `dsh web --patch examples/logseq/cordis.yml` 启动；详见 [logseq/README.md](logseq/README.zh.md)。
