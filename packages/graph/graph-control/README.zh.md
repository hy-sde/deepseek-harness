---
description: "Agent Graph 的持久化决策存储：调度更新、恰好一次的意图声明、操作员预置与主管唤醒。"
kind: "package-reference"
---

# @deepseek-ai/dsh-graph-control

[English](README.md) | 中文

## 概述

`dsh-graph-control` 是 Agent Graph 背后的持久化决策存储。它在同一个 `KvUnit` 中记录调度更新、恰好一次的意图声明、操作员预置与主管唤醒，因此重放天然幂等、重试复用同一激活身份。每个进程装载一次：取得存储后端后打开 `agent_graph` 单元，然后在观察到的修订号上提交调度更新并声明意图。所有变更串在一条写链上，派生唯一性索引在打开时重建，撕裂写入可自愈而非损坏。本包不提供任何工具、提示词或插件行；由图协调器、执行器适配器与主管工具消费。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

```ts ignore-check
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import { GraphControlStore } from '@deepseek-ai/dsh-graph-control'

const backend = await ctx[storageBackendServiceKey('sqlite')]
const unit = await backend.kv.open(GraphControlStore.descriptor)
const store = await GraphControlStore.open(unit)

const { update, created } = await store.commitScheduleUpdate(request)
const { claim } = await store.claimIntentAtScheduleRevision(claimRequest, update.revision)
```

每个进程只打开该单元一次：存储层拒绝重复打开，且本存储是该单元上的唯一写链。

<a id="understand-the-implementation"></a>
## 理解实现

- **调度日志**（`schedule`）：只追加决策，修订号 = max+1，按 `updateId` 与源三元组 `(session, run, toolCall)` 幂等；`finish` 不能与 `add_work` 合并；一旦提交 finish，图即关闭。
- **意图声明**（`claims`）：键为 `graphId:intentId`，激活身份唯一性（`(targetSessionId, targetTurnId)` 与 `(targetSessionId, targetRunId)`）由派生索引约束；`claimed → executing → cancelled` 转换以修订号为条件；关闭后拒绝新声明，但既有声明仍可派发。
- **操作员预置**（`provisions`）：确定性 `provisionId`/`operatorId` 使重试采用同一操作员；与声明一样受修订号约束并在关闭后拦截。
- **主管唤醒**（`wakes` + `wake_attempts`）：声明一次后开始尝试（已投递/已替代则拒绝）；以 `waiting_permission | delivered | superseded | retryable_failed` 完成；按根会话（可选图过滤）替代；`recoverSupervisorWakes()` 刻意为空操作——中断的尝试是否真正完成属于运行时事实，协调器（P5）检查运行事实后完成之。本存储从不猜测。

<a id="further-exploration"></a>
## 运行时不变式

未发布运行时不变式伴生包：graph-control 拥有图工具持久化与读取的持久行，伴生包会重新实现存储，而不是对比独立维护的观测。

## 进一步探索

- Maka 设计说明：`~/Documents/workspace/port_maka.md` —— 移植设计说明与阶段清单。
- Maka 参考：Maka 检出中的 `docs/architecture/agent-graph-stream-scheduling-draft.md`（第 7 章）。

<a id="model-experience"></a>
## 模型体验

### 图调度记录

#### 模型看到什么

无。本包是主机侧机制，模型不会直接收到其行记录。P4 切片的主管工具才是把图事实（`调度更新`、`意图声明`、`操作员预置`、`主管唤醒`）暴露给模型的地方。

#### Token 影响

无——主机侧行记录从不进入模型上下文，因此本包不增加也不消耗任何 token。

#### KV Cache 影响

无 KV Cache 影响：本存储写入持久化主机行，对模型上下文无任何贡献。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 无 epoch 表：按设计决策，一个 DSH 会话拥有一个图（每根多图推迟）。
- 多行 CAS 为进程原子（单写链）而非事务原子；崩溃后序列中撕裂的写入在打开时自愈，因为索引是派生的。撕裂写入的声明由协调器检查运行事实恢复，与 Maka 一致。
- 派生工作状态（`requested/stopped/superseded`）、记录、路由、就绪与客户端快照属于后续切片，不在此存储。

<a id="dev-note"></a>
### 开发备注

<details><summary>维护者的工作上下文——点击展开</summary>无。</details>
