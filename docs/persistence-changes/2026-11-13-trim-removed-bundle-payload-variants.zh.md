---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-13-trim-removed-bundle-payload-variants

[English](2026-11-13-trim-removed-bundle-payload-variants.md) | 中文

## 概述

移除由已删除的 LiveShare share-viewer 客户端与已删除 session-titles bundle 贡献的载荷联合变体：`user` 类消息来源上的可选 `principal` 收窄、不再包含 `share-viewer` 对象，`session/title-llm-request` 的消息列表失去该 bundle 的请求变体。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-13-trim-removed-bundle-payload-variants
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "3633c9d355bf1a8d4bfbbc4709adbfb39e83342677e8a8a32a1bda5de4bf3039"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "e35448e7c5d74e6be8a17c036585bd19e55b18d27dbde4180e8f2d2e272e6a35"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "e01be48a725f4c8de1b8e3589573e2d5f7c4c21398331742cfe8dcb184817c20"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "7ccc21809887f205941219fd96631b439f05051495b0474002b79ba4c5dbfc67"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

此变更只收窄编译期联合类型；来源与 title-llm 消息列表的运行时解析保持结构化，不枚举 principal 种类或消息变体。当前读取器打开携带 `share-viewer` principal 或被移除 title-llm 变体的旧 Session 日志时，该行按原样加载：source 的 `kind` 仍为 'user'，多余字段作为惰性数据随行保留。唯一识别 `share-viewer` principal 的组件（已删除的 LiveShare 客户端）与唯一写入被移除 title-llm 变体的组件（已删除的 session-titles bundle）均已不存在，因此当前代码不再基于被移除的变体分支，新日志也不会写入它们。SESSION_FORMAT_VERSION 不变。

<a id="verification"></a>

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests packages/session/session-persistence/tests：20 个文件、405 个测试通过，覆盖已发布格式迁移中的来源与消息往返。pnpm run persistence-changes --check 确认四个收窄的根与本记录匹配，且没有其他根发生变化。

<a id="dev-note"></a>

<a id="dev-note"></a>
## 开发备注

无。
