---
description: "面向模型的 agentsview 访问工具：对本地 agentsview 存档发起一次性查询；该存档由 agentsview CLI 直接从 DeepSeek Harness 会话存储维护——会话智能、统计、成本、语义搜索、recall 与导出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agentsview

[English](README.md) | 中文

## 概述

`dsh-tool-agentsview` 把本地 [agentsview](https://github.com/kenn-io/agentsview) 存档暴露为一个模型侧 `agentsview` 工具，含十个动作。每次调用派发一次 `agentsview <command> --format json` 并解析 JSON 文档。agentsview CLI 本身就解析 DeepSeek Harness 会话日志（多帧、撕裂尾部、压缩去重），因此该接缝对 harness 写出的同一批文件只读。它是 `tool-session-query`（进程内转录翻页器）的分析补充：健康等级、窗口统计、token 成本报告、转录搜索、recall 简报与无内容导出。边界是手工维护的 argv 映射：agentsview 发布改动标志时本包需要更新。

## 目录

- [工具面](#tool-surface)
- [为什么用 CLI 包装而非 DSH 原生会话工具](#why-a-cli-wrapper-over-dsh-native-session-tools)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

面向模型 [agentsview](https://github.com/kenn-io/agentsview) 访问：会话智能、统计、成本、转录搜索、recall 与导出；与 harness 写出的 DeepSeek Harness 会话存储同源。一个工具、每个动作一次派发、JSON 进出。

<a id="tool-surface"></a>
## 工具面

- `agentsview action=list [limit] [project] [agent] [includeAutomated] [includeOneShot] [includeChildren]` —— 近期会话，含健康等级与结局列。
- `agentsview action=get [sessionId]` —— 单个会话的元数据与信号计数。
- `agentsview action=sessionUsage [sessionId] [ownOnly]` —— 归因到会话的 token 用量与成本估算。
- `agentsview action=health [sessionId] [limit]` —— 等级/结局列表，或单个会话的详细信号面板。
- `agentsview action=stats [since] [until] [agent] [includeProjects]` —— 窗口化工作区统计（原型、时长、上下文峰值、工具/模型构成、git 结局）。
- `agentsview action=usage [since] [until] [agent] [all] [breakdown]` —— 每日 token 用量与估算成本报告。
- `agentsview action=search [query] [mode=substring|regex|fts|semantic|hybrid] [limit] [excludeSession]` —— 转录内容搜索（语义/混合需先构建向量索引）。
- `agentsview action=recallQuery [query]` / `action=recallBrief [query]` —— 实验性蒸馏知识查询与打包任务简报（人为可读文本）。
- `agentsview action=exportSessions [limit] [cursor] [project] [outcome] [healthGrade] [minToolFailures] [since] [until]` —— 无内容 JSON 会话摘要导出（schema_version 6）。

<a id="why-a-cli-wrapper-over-dsh-native-session-tools"></a>
## 为什么用 CLI 包装而非 DSH 原生会话工具

`tool-session-query` 在进程内读取实时会话存储，仍是翻页转录、按 DSH 语义搜索消息的正确工具。它不计算的是派生分析：健康等级与结局分类、窗口统计、token/成本记账、基于嵌入索引的语义搜索、recall 语料与无内容导出。AgentsView 用 Go（MIT）实现全部这些，且已理解 DSH 格式——包括多帧 `.zstd` 与压缩重复——因此包装其 CLI 为零移植地给 fork 带来整个分析面，沿用的正是 `tool-codebase-memory` 与 `tool-logseq` 得以成立的 CLI-first 模式。包装器让模型面保持小巧：一个带动作枚举的工具替代十个冗长子命令、一个 JSON schema、可按 preset 配置 `cliPath`/`sessionDirs`，以及二进制缺失时带安装提示快速失败的激活不变量。

<a id="configuration"></a>
## 配置

```ts
import { Context } from '@deepseek-ai/cordis'
import toolAgentsviewPackage from '@deepseek-ai/dsh-tool-agentsview'

const ctx = new Context()
ctx.plugin(toolAgentsviewPackage, {
  cliPath: 'agentsview', // CLI executable (default: on PATH)
  sessionDirs: ['/Users/me/.dsh/sessions'], // optional DSH session roots (DEEPSEEK_HARNESS_SESSIONS_DIR)
  timeoutMs: 120000, // per-call process timeout (first calls sync the archive)
  maxChars: 200000, // cap on rendered JSON payload before explicit truncation
})
```

不设 `sessionDirs` 时 CLI 使用自身默认值：它尊重 `DSH_HOME`（回退 `<home>/sessions`）并相应重定位 DSH 会话路径，因此常规部署无需任何配置。会话放在别处时传入根目录；工具以 `DEEPSEEK_HARNESS_SESSIONS_DIR`（路径分隔符连接）转发。插件激活不变量在 CLI 缺失时快速失败并给出安装提示。可随时用 `agentsview version --json` 验证。

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

一个手写 `agentsview` schema（[目录条目](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-agentsview)），带必填 `action` 枚举与按动作区分的可选字段。描述说明各字段适用于哪个动作，模型按意图选择动作（会话分诊 → `list`/`health`；成本 → `usage`；找证据 → `search`；打包上下文 → `recallBrief`），无需记忆 CLI 标志。

#### Token 影响

一个静态 schema（约 2 KB）替代十个子命令 schema；结果以 JSON 载荷返回并受 `maxChars`（默认 200000）限制，宽 `stats` 或 `exportSessions` 不会撑爆上下文。

#### KV 缓存影响

schema 为静态；每次调用的参数不同但不会改变请求前缀。此前缀跨调用保持有效。

### 结果值

#### 模型看到什么

从 CLI `--format json` 输出解析的结构化 JSON 文档，覆盖八个结构化动作（`list`、`get`、`sessionUsage`、`health`、`stats`、`usage`、`search`、`exportSessions`），因此 `health_grade`、`outcome`、`cost_usd`、`hits` 等字段是一等公民。`recallQuery`/`recallBrief` 原样返回 CLI 的人为可读文本（这些面不承诺 JSON）。CLI 错误以带 argv/退出码的 `AgentsviewCliError` 浮出——绝不会伪装成成功。

#### Token 影响

载荷原样透传，仅在超过 `maxChars` 上限时截断并带显式标记；CLI 自身的 `limit`/`cursor` 分页是主要成本控制。

#### KV 缓存影响

结果为每次调用的快照，无读取回写改变模型的重复运行前缀。

### 提示段

#### 模型看到什么

一张 `agentsview:tools` 卡片：存档是什么、动作列表、首次调用同步延迟、`config.cliPath`/`sessionDirs` 覆盖，以及 `semantic`/`hybrid` 搜索需要向量索引（`agentsview embeddings build`）而 `fts` 始终可用。

#### Token 影响

四行短文本只加入请求前缀一次；每轮成本可忽略。

#### KV 缓存影响

静态段落文本——无失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办工作

- 精选 argv 映射是 agentsview CLI 标志的手工维护镜像；重命名命令或标志的发布需要本包更新（失败模式是每次调用的 CLI 报错，而非静默损坏）。
- 对全新存档的首次调用可能明显更慢：CLI 按需同步会话存储（需要新数据的命令会自动拉起 daemon）。暖存档为本地 SQLite 速度。
- `search` 的 `mode=semantic|hybrid` 需要向量索引与 `[vector]` 配置；缺失时 CLI 报错——请回退 `fts`/`substring`。
- Recall 按上游定义为实验性：语料 schema 可能随升级重建，模型化提取还需 `[recall.extract]`；`recallQuery`/`recallBrief` 仅在语料已填充（已启用提取或导入条目）时可用。
- AgentsView 读取 DSH 默认 JSONL 持久化（纯 `session.jsonl` 与多帧 `session.jsonl.zstd`）；切换到可选 SQLite 持久化后端的部署不会被摄取。
- 无主机面服务或 GUI 面：工具是纯 CLI 访问；agentsview Web UI（`http://127.0.0.1:8080`）仍是面向人的仪表盘。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
