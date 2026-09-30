---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-25-fork-session-source-attributions

[English](2026-09-25-fork-session-source-attributions.md) | 中文

## 概述

分支的内存抽取管线注册了一个新的会话来源归属 kind（`dsh-memory-extraction`），其消息进入 `user/message`、`developer/message`、`agent/inbox/spliced` 与 `session/title-llm-request` 事件；分支还新增了一个宿主本地的图监督事件根（`event:graph/change`）。新 wire kind 通过 `@persistenceAttribution` 声明为可增量处理，读取方无需改变时序或既有载荷的兼容性即可保留它。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-25-fork-session-source-attributions
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "fde027b4b6f27abc1082db9a06cfeb7f3a0ecce294ffccb6e6209f18426e8b84"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "6d5239db992a5a47322b39a91bc6b2dfd335693835002bb6c8cce53894ce9230"
    decision: same-version
  - root: "event:graph/change"
    previous: null
    after: "d38454ae5ba07b11a92a88ce553df6781853437d4913f4a4020298af3b8e3263"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "187a88a7492775d7108d3323c31b31f979f86bd12ab564af90fa82ba596d751a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "6123dc94139968b7a71e40718ac36a3575943a6dcdabd039deb3d76af8ce45fe"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

全部五个转换均确认为 same-version。新来源 kind 凭归属限定：保留未知 kind 的既有读取方可继续接受新 kind；`event:graph/change` 根是 `surface: false` 的新事件根，与 `event:goal/change` 等已接受的增量宿主事件模式一致。没有既有模式形状变化；不要求格式版本升级。

<a id="verification"></a>
## 验证

记录后 `pnpm run persistence-changes --check` 报告零个要求版本升级的变化；`pnpm run verify-persistence-formats` 报告 v0 至 v4 完整引用；合并工作区类型检查与会话格式语料在此类型下均通过。

<a id="dev-note"></a>
## 开发备注

无。
