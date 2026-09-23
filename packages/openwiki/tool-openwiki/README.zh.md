---
description: "面向模型的仓库 wiki 生命周期工具（openwiki_begin … openwiki_finish），在进程内驱动移植的确定性 openwiki 0.4 引擎核心。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-openwiki

[English](README.md) | 中文

## 概述

`dsh-tool-openwiki` 为 agent 提供仓库 wiki 生命周期：`openwiki_begin`、`openwiki_submit_plan`、`openwiki_next_page`、`openwiki_submit_page` 与 `openwiki_finish` 在进程内驱动移植的确定性 openwiki 0.4 核心，采用与上游一致的可恢复、以 Claim 为锚的协议。当 agent 需要在没有外部 `openwiki` CLI 的情况下、借助 codebase-memory 做结构化发现来维护仓库 wiki 时，在预设中选择它。它是注入 `tools` + `systemPrompt`、不注册自身服务的 Cordis agent 平面插件；主要边界是与移植核心格式的紧密绑定，以及每个挂载会话同时只能有一个活动运行。

## 目录

- [工具面](#surface)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

模型侧的仓库 wiki 生命周期工具——`openwiki_begin`、`openwiki_submit_plan`、`openwiki_next_page`、`openwiki_submit_page`、`openwiki_finish`——驱动移植的确定性 openwiki 0.4 引擎核心（`@deepseek-ai/dsh-openwiki-core`）**在进程内运行**。五工具契约与每条模型侧描述都与上游 openwiki 0.4 一致，因此 harness agent 以同样的可恢复、以 Claim 为锚的 wiki 生成方式工作，无需外部 `openwiki` CLI，并借助 `codebase-memory` 做结构化发现。

<a id="surface"></a>
## 工具面

一个 Cordis agent 平面插件（作为 preset 或 profile 补丁行挂载，注入 `tools` + `systemPrompt`，不注册自己的服务）：

- `openwiki_begin` — 启动或恢复一个持久的运行（`.run.json`），覆盖 Git 仓库根；干净的更新返回 `status=noop`。
- `openwiki_submit_plan` — 校验并持久化有序的 PageJob 队列；init 需要 `/openwiki/quickstart.md`，路径会被归一化。
- `openwiki_next_page` — 返回第一个待办的 job，附带既有 Markdown 与 Claims。
- `openwiki_submit_page` — 用针对已写页面的完整 Claim 集来证明当前 job 完成（先修复前言，再做 Claims 解析与持久验证）。
- `openwiki_finish` — 确定性收尾：计划内/放弃的删除、Mermaid 校验、wiki 索引同步、链接校验、生成事件来源、Claims 收尾 + manifest 替换、运行元数据，以及 `.run.json` 移除。

<a id="configuration"></a>
## 配置

```yaml
- id: tool-openwiki
  name: '@deepseek-ai/dsh-tool-openwiki'
  config:
    host: harness          # stable host identity recorded in run metadata
    producerActor: harness # origin actor for engine-owned finalizers
```

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

五个生命周期 schema（[目录条目](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-openwiki)）编码了精确的可恢复协议：显式 `root`+`mode` 的 begin、最终不可替换的有序计划、带 `id` 复用/撤回约定的逐 job Claim，以及要求每个 job 都完成的 finish。

#### Token 影响

一次向请求前缀添加五个紧凑 schema（合计约 1–2 KB）；结果是小的 JSON 视图（`changedPaths`、`claimIssues`、完成状态、noop 状态），因此 wiki 生成成本按页有界，而不是与仓库规模成正比。

#### KV 缓存影响

所有 schema 都是静态的；每次调用的参数有变化，但绝不会影响请求前缀。缓存的请求前缀在多次调用间保持有效。

### 提示节

#### 模型看到什么

一张 `openwiki:tools` 卡片：必需的生命周期顺序、持久/可恢复的运行语义、每条实质 Claim 都必须带仓库证据资源的规则、精确的 Claim 调和（保留未变 Claim 的 id/statement/evidence，修订时复用 id，省略即撤回），以及这个钩子：用 `codebase-memory` 做结构化发现，而不是逐文件扫描仓库。

#### Token 影响

一次向请求前缀添加七行短文本；每轮开销可忽略。

#### KV 缓存影响

静态节文本——不会失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **与移植核心紧密绑定** — 行为（`.run.json`、`.page-manifest.json`、`.claims/` 侧车、OKF 前言、证据 URI）当前与 openwiki 0.4 完全一致；未来上游格式变更需要同步升级核心。
- **Mermaid/jsdom 可选** — 权威的 Mermaid 校验需要宿主进程中的可选 `mermaid` + `jsdom` 对等依赖；缺失时校验退化为启发式（与上游一致）。
- **每个挂载会话一个活动运行** — `HostSessionManager` 是单运行适配器；并发 wiki 运行需要分开的 agent 会话，或把 manager 重构为按运行持有。
- **无 CI 工作流** — 上游的定时 GitHub Actions 工作流与 code-mode 连接器刻意不移植；harness 正是通过这些工具在进程内运行 wiki。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
