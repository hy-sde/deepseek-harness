# Agent Note: Session 打开时可能永远停留在“载入历史…”状态

Status: implemented

[English](2026-09-23-session-open-stuck-loading.md) | 中文

## 问题

在 Web GUI 中切换回某个会话时，聊天面板可能一直停留在“载入历史…”处，既不报错、也没有重试入口，从侧边栏重新打开会话也无济于事。同一会话还显示过期的“深度求索中…”运行状态，用户无法判断代理是否仍在工作。

## 根因

客户端 `Session.open()` 是一个单向闩锁：`openState` 只会 `cold → loading → open | error` 前进，而永不结束的打开会留下一个永久的 `openPromise`，使之后每次 `open()` 调用都返回同一个挂起的 Promise。存在两条路径：

1. **首帧发布路径中的非 Remote 异常会逃出 `open()`。** `SessionEventStream.open()`（一个 `RemoteJournalStream`）会在 `open()` 内部同步发布开窗快照——经过 `replaceGeneration → publish → installWindow → ClientAssistantStream.replace → expandAssistantStream → validateRecord`。如果开窗的 `assistantStream` 基线不合法（例如 `text-chunks` 记录的 `dt` 长度不等于 `members - 1`），这里会抛出普通 `TypeError`。`doOpen` 的 catch 里是 `if (!isRemoteFailure(error)) throw error`，于是这个原始异常直接逃逸，`openState` 停留在 `loading`，`openPromise` 永不结算。
2. **`failEventStream` 有同样的再次抛出漏洞。** 通过流的 `failed` 回调投递的非 Remote 失败会从回调里抛出，形成未处理的拒绝——Session 永远不会得到通知。

另外也没有墙钟保护：第一帧永远不来（网络边沿、网关卡死）时，`loading` 会无限期挂起。

## 决策

在 [session.ts](../../../../packages/api/session-controller/src/client/sessions/session.ts) 中：

- `doOpen` 的 catch 现在把**任何**错误都归一化为 `openState = 'error'` 且 `openError` 为 `isRemoteFailure(error) ? error : remoteFailureOf(error)`，其中 `remoteFailureOf` 把非 Remote 异常包装成 `new RemoteError('gateway/internal', message, {}, { cause })`（与 `remote-stream.ts` 的 `terminalStreamFailure` 一致）。catch 中也调用 `events.dispose()`。
- `failEventStream` 不再重新抛出；同样归一化。
- 新增墙钟保护：`openWithTimeout` 将 `events.open()` 与 `SessionOptions.openTimeoutMs`（默认 `DEFAULT_OPEN_TIMEOUT_MS = 30_000`；`0` 关闭）竞争。超时抛出 `RemoteError('gateway/internal', 'session open did not settle within …ms …')`，落入同一错误路径。
- 新增 `Session.reopen()`（及 `ISession.reopen`）：重置 `openGeneration`、释放过期流、清空 `openPromise`/`openState`/`openError`，然后重跑尾部页打开。`resync()` 改为委托给它（语义相同）。`open()` 在 `openPromise` 为空时本就可从 `error` 重试；卡死正是来自永不结算的 Promise。
- 聊天面板的错误状态现在渲染**重试**按钮（公共 `t('retry')`），通过 `ChatViewInjected.retryOpen` → `session.reopen()` 接线。

## 考虑过的替代方案

- **只归一化 Remote 失败。** 仍留下不合法基线和回调抛出两个漏洞，且没有超时——报告的卡死依旧。
- **让 `open()` 拒绝。** 服务的 `attachOpening` 只要结算就会解析引用，与状态无关；让 `open()` 拒绝会改变这一契约，而且面板仍没有重试入口。
- **自动重试。** 打开重试循环可能掩盖永久损坏的会话并放大网关流量；显式按钮让失败可见且由用户驱动。

## 后果

- 任何打开失败（不合法基线、非 Remote 流错误、永不到达的首帧）现在都落入 `openState = 'error'`，而不是挂起的 `loading`——并且带重试按钮。
- `openError` 始终报告 `RemoteError`；读取 `openError.code` 的快照继续工作（包装错误时 code 总是 `gateway/internal`）。
- `reopen()` 是新的公共 `ISession` 动词：所有测试夹具的 `SessionFace` 字面量与手写的 `api-catalog.ts` 声明都要镜像它；`FixtureSession` 增加标准的 fail-loud 桩。
- 过期的“深度求索中…”运行位是另一个症状（新 `Session` 从过期的 `summary.running` 派生）；本修复不改变运行状态的清除逻辑。

## 验证

- `session.client.spec.ts`：不合法开窗基线 → `openState = 'error'` 且 `gateway/internal`（原先：卡在 `loading`）；永不产出的首帧配合 `openTimeoutMs: 25` → 错误“did not settle within 25ms”；`reopen()` 在失败打开后落地新窗口。
- `chat-view.client.spec.tsx`：错误状态渲染重试按钮，点击调用 `retryOpen`。
- `apply-inject.client.spec.tsx`：`injected.retryOpen()` 调用 `session.reopen()`。
- 既有套件（`reference-ownership`、`assistant-stream`、`conversation-registry` 及完整 session spec）全部通过；完整客户端类型检查（`tsc -b tsconfig.client.json`）与 oxlint 干净。
