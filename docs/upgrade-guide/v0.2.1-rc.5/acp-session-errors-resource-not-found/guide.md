---
kind: upgrade-guide
description: "ACP requests against unknown or closing session ids reject with JSON-RPC -32002 resourceNotFound instead of -32602."
---

# ACP session errors use resourceNotFound

English | [中文](guide.zh.md)

## Change

The automation-only ACP bridge rejects requests that name an unknown session id — `session/prompt`, `session/setSessionConfigOption`, and `session/closeSession` — and requests that race an in-flight session close with JSON-RPC code `-32002`, message `Resource not found: <sessionId>`, and `data.uri` carrying the id. They previously rejected with code `-32602` and messages `unknown session: <sessionId>` / `session is closing: <sessionId>`. Unknown config-option choices keep `-32602`, and `session/cancel` for an unknown session stays a no-op. ACP clients that classify these failures by numeric code or message text observe the change.

## Migration

1. In clients built on `@agentclientprotocol/sdk`, classify these failures by `error.code === -32002` (or a `Resource not found` message match) where they previously matched `-32602` / `unknown session`.
2. Send a prompt to a session id that was never created and confirm the rejection arrives as `-32002`.
