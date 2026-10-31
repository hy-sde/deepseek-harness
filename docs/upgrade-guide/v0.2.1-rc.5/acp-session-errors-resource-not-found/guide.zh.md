---
kind: upgrade-guide
description: "ACP 对未知或正在关闭的会话 id 的请求以 JSON-RPC -32002 resourceNotFound 拒绝，替代原来的 -32602。"
---

# ACP 会话错误改用 resourceNotFound

[English](guide.md) | 中文

## 变更

automation-only ACP bridge 对指定未知会话 id 的请求——`session/prompt`、`session/setSessionConfigOption`、`session/closeSession`——以及与会话关闭过程竞争的请求，现在以 JSON-RPC 代码 `-32002`、消息 `Resource not found: <sessionId>` 拒绝，`data.uri` 携带该 id。此前它们以代码 `-32602` 及消息 `unknown session: <sessionId>` / `session is closing: <sessionId>` 拒绝。未知配置选项仍保持 `-32602`，对未知会话的 `session/cancel` 仍为无操作。按数字代码或消息文本分类这些失败的 ACP 客户端会观察到此变化。

## 迁移

1. 在基于 `@agentclientprotocol/sdk` 构建的客户端中，把原来匹配 `-32602` / `unknown session` 的失败分类改为检查 `error.code === -32002`（或匹配 `Resource not found` 消息）。
2. 向一个从未创建的会话 id 发送 prompt，确认拒绝以 `-32002` 到达。
