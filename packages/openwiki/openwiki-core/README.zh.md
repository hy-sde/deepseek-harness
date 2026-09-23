---
description: "确定性 openwiki 0.4.3 引擎核心的进程内移植——可恢复的 wiki 生命周期、Grounded Claims、OKF 前言、校验与 HostSessionManager 协议——无需外部 openwiki CLI。"
kind: "package-reference"
---

# @deepseek-ai/dsh-openwiki-core

[English](README.md) | 中文

## 概述

`dsh-openwiki-core` 在进程内提供移植的 openwiki 0.4.3 确定性引擎核心：可恢复的仓库页面任务生命周期、Grounded Claims、OKF 前言、Mermaid 与 wiki 链接校验，以及与传输无关的 `HostSessionManager` 协议。当流水线需要在无模型参与、且不依赖外部 `openwiki` CLI 的情况下生成或维护仓库 wiki 时选择它；`@deepseek-ai/dsh-tool-openwiki` 消费同一核心提供五个生命周期工具。它是仅依赖 `zod` + `yaml` 的纯 TypeScript 库，任一引擎写出的仓库保持互通；主要边界是：它需要调用 `git`，只有带上可选的 `mermaid` + `jsdom` 对等依赖才能做权威 Mermaid 校验，并且刻意未移植上游的连接器与 CI 工作流。

## 目录

- [表面](#surface)
- [用法](#usage)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

[openwiki](https://github.com/langchain-ai/openwiki) 0.4.3 **确定性引擎核心** 的仓库内移植（MIT 许可；署名保留在各模块头注释中）：上游与 DeepAgents 配对的、无模型依赖的仓库 wiki 机制。本 fork 去掉了 DeepAgents/CLI 耦合——引擎运行在进程内、背后是极小的 `WikiFs` 文件系统接缝，因此不再需要外部 `openwiki` CLI。由于磁盘格式完全一致，任一引擎写出的仓库都可互通。

<a id="surface"></a>
## 表面

纯 TypeScript 库（仅依赖 `zod` + `yaml`），按 `src/*` 组织：

- **生命周期** — 可恢复的仓库页面任务编排（`begin` / `submit_plan` / `next_page` / `submit_page` / `finish`），带持久的 `.run.json` 检查点、git 源指纹、更新无操作检测，以及作为正确性账本的 `.page-manifest.json`（`generation/*`、`agent/utils.ts`）。
- **Claims** — Grounded Claims 核心（add/confirm/update/retract 变更）、带 `.claims/` 侧车持久化与验证的 code-brain 存储/会话/运行时，以及把 `repo://path#L20-L48` 资源映射到带重定位锚点的 `repo-lines-v1:sha256:` 不透明版本的仓库证据解析器（`claims/*`）。
- **OKF** — OKF v0.2 前言校验/修复、生成事件来源、索引标签、递归概念索引同步、claim-sources 与 claims-verification 投影（`okf/*`）。
- **校验** — Mermaid 围栏校验（jsdom/mermaid 可选，优雅回退到启发式）与仓库内链接校验（含坏链盖印）（`mermaid/*`、`agent/wiki-link-validator.ts`）。
- **安装 + fs** — `.openwikiignore` 加载、受管的 AGENTS.md/CLAUDE.md 片段 + `INSTRUCTIONS.md` wiki 目标、可恢复的 init wiki 替换，以及仓库内的 `WikiFs`/`createNodeWikiFs` 接缝（`agent/*`、`fs/*`）。
- **集成** — 与传输无关的 `HostSessionManager` + zod 协议（`openwiki_begin` … `openwiki_finish`），以及 Git 仓库根解析（`integrations/core/*`）。

<a id="usage"></a>
## 用法

引擎由 `@deepseek-ai/dsh-tool-openwiki` 消费，后者注册五个生命周期工具。直接使用（例如自动化流水线）走 `HostSessionManager`：

```ts
import { HostSessionManager, resolveRepositoryRoot } from '@deepseek-ai/dsh-openwiki-core'

const manager = HostSessionManager.create({ host: 'pipeline' })
const outcome = await manager.begin({ root: '/repo', mode: 'init' })
// outcome.runId → submit_plan → next_page → write page → submit_page → finish
```

<a id="model-experience"></a>
## 模型体验

None, as the core library registers no tool schema, prompt section, or result of its own; every model-facing surface lives in `@deepseek-ai/dsh-tool-openwiki` over the same files these exports provide.

#### KV 缓存影响

No prompt-shaping data comes from this package.

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **需要 Git** — 源指纹、更新窗口与根解析都会调用 `git`。非 git 目录无法运行生命周期（引擎仍会按上游行为拒绝）。
- **Mermaid/jsdom 可选** — 权威的 Mermaid 解析需要可选的 `mermaid` + `jsdom` 对等依赖；缺失时校验退化为启发式围栏检查（与上游一致）。
- **无连接器 / CI 工作流** — 上游的 code-mode CI 工作流与源连接器（`runCodeModeConnectors`）刻意不移植：本 fork 的 wiki 通过生命周期工具在进程内运行，连接器摄取属于宿主进程的职责。
- **省略主目录 onboarding** — wiki 目标从仓库自身的 `openwiki/INSTRUCTIONS.md` 读取；没有全局 onboarding 存储。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
