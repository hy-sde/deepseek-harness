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
    after: "1c5e32f989f10dddcc379f5eecd0094f35c027d21849ac138eec91f3ae5d439f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "bf53189b0f8b5b3c98f92551b29a0f2b3024bb44dfd2c3cec5eb23b52420ae4c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "cd23ce25d33666e2cfed7cf084bfbd601cba0e5245115550c78cdac3cab83539"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "c3ffea290e0c23698dfd000d4cf55b7c561065eeead7e8870a5a564f4534246d"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

此变更只收窄编译期联合类型；来源与 title-llm 消息列表的运行时解析保持结构化，不枚举 principal 种类或消息变体。当前读取器打开携带 `share-viewer` principal 或被移除 title-llm 变体的旧 Session 日志时，该行按原样加载：source 的 `kind` 仍为 'user'，多余字段作为惰性数据随行保留。唯一识别 `share-viewer` principal 的组件（已删除的 LiveShare 客户端）与唯一写入被移除 title-llm 变体的组件（已删除的 session-titles bundle）均已不存在，因此当前代码不再基于被移除的变体分支，新日志也不会写入它们。SESSION_FORMAT_VERSION 不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests packages/session/session-persistence/tests：20 个文件、405 个测试通过，覆盖已发布格式迁移中的来源与消息往返。pnpm run persistence-changes --check 确认四个收窄的根与本记录匹配，且没有其他根发生变化。

<a id="dev-note"></a>
## 开发备注

无。
