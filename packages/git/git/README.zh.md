---
description: "面向 agent 化提交与评审工作流的宿主 ctx.git 服务：经 ctx.subprocess 通道的无状态 git CLI 包装，外加 diff 解析原语与拆分提交执行动词。"
kind: "package-reference"
---

# @deepseek-ai/dsh-git

[English](README.md) | 中文

## 概述

宿主 `ctx.git` 服务为 agent 化提交与评审工作流提供经 `ctx.subprocess` 通道的无状态 `git` CLI 包装，外加面向模型方工具所需的 diff 解析原语与拆分提交执行动词。它读取仓库状态与捕获的 diff（以 `--binary` 捕获，因此二进制变更能安然通过暂存往返），按 hunk 选择把记录的 `--cached` diff 切回索引，并通过同一条有界子进程路径提交、推送与记录日志。组合需要 git 管线时选用它来支撑 `@deepseek-ai/dsh-tool-git`；模型从不直接消费它。边界是提交／评审子集，无交互式 history 重写或凭据管线。

## 目录

- [功能](#what-it-does)
- [执行模型](#execution-model)
- [部分 hunk 暂存](#partial-hunk-staging)
- [工作树池](#worktree-pool)
- [配置](#configuration)
- [Model Experience](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

agent 化提交＋评审工作流（移植自 omp / oh-my-pi）的宿主 `ctx.git` 服务：经 [`ctx.subprocess`](../../subprocess/subprocess/README.zh.md) seam 对 `git` CLI 的轻量、无状态包装，外加面向模型方工具所需的 diff 解析原语与拆分提交执行动词。由 [`@deepseek-ai/dsh-tool-git`](../tool-git/README.zh.md) 消费，模型不直接调用。

<a id="what-it-does"></a>
## 功能

在组合上注册一个宿主服务（`ctx.git`）。其面：

- **仓库状态** — `isRepo`、`root`、`branch`、`status`、`hasStaged`。
- **Diff 读取** — `diffText`、`fileDiffs`，以及包含派生读形状（`changedFiles`、`numstat`、`has`）的 `diff` 命名空间。diff 以 `--binary` 捕获，因此二进制变更能安然通过暂存往返。
- **暂存** — `addAll`（`git add -A`）、`resetIndex`（`git reset`）、以及 `stageHunks`：把记录的 `--cached` diff 按 hunk 选择切回索引（omp `stage.hunks` 移植）。
- **提交／推送／日志** — `commit`（消息经 stdin）、`push`（`--no-follow-tags`；可选 `remote`／`branch`／`setUpstream`，让新命名分支能够记录 `origin/<branch>` 上游跟踪）、`log`。

`./worktree` 子路径另提供带**持久租约的工作树池** — 用 TypeScript 原生实现 firstmate／treehouse 的 `get --lease` 模型（每仓库的隔离工作树池，池根可配置、默认 `~/.treehouse`，租约所有权重启安全，prune／destroy 默认 dry-run，损坏状态可恢复）。见 [工作树池](#worktree-pool)。

diff 词汇位于 [`types.ts`](src/types.ts) 与 `diff.ts`（带重命名处理的 numstat、hunk 解析／选择／校验）；拆分机制对应 omp（拓扑提交排序、锁文件自动归位）。

<a id="execution-model"></a>
## 执行模型

每条 git 调用都经 `ctx.subprocess`：独立的 wall-clock 超时（`timeoutMs`，默认 120 秒）、`SIGTERM→SIGKILL` 宽限（`graceMs`，默认 5 秒）、有界收集的 stdout／stderr（`maxStdoutBytes`／`maxStderrBytes`），以及转发给所派生进程的中止信号。非零退出对 probe 命令作为数据返回，对其他命令以可读的 [`GitCommandError`](src/service.ts) 抛出。

<a id="partial-hunk-staging"></a>
## 部分 hunk 暂存

`stageHunks` 依据记录的 diff 重建补丁，并以 `git apply --cached` **不加** `--binary` 的方式应用于文本补丁：对携带 `index <old>..<new>` 的头部传入 `--binary`，会使 `git apply` 找到两个 blob 并暂存*整个*新 blob，静默破坏 hunk 粒度。内嵌二进制的补丁仍以 `--binary` 应用。

<a id="worktree-pool"></a>
## 工作树池

`import { acquireWorktree, releaseWorktree, listWorktrees, pruneWorktrees, destroyWorktree } from '@deepseek-ai/dsh-git/worktree'` — 仿照 treehouse（`get --lease`）的每仓库 `git` 工作树池：

- **池布局** — `<root>/<repo>-<hash6>/<n>/<repo>`，其中 `root` 可配置（默认 `~/.treehouse`），hash 为规范主仓库根的 sha256（链接工作树经 `--git-common-dir` 解析到主检出，因此一个仓库 = 一个池，即使 `realpath` 不同）。
- **持久租约** — `acquireWorktree` 返回 `path` 与随机 `leaseId`，持久化到每池的 `treehouse-state.json`（原子 temp+rename 提交、跨进程 `withFileLock`、进程内 `withRepoLock` 于主仓库根）；已租借槽位在 `releaseWorktree` 以匹配 id 清除前绝不再次分配或被 prune。
- **安全** — 仅在未租借＋干净（`--untracked-files=all`）＋HEAD 已并入精确重置目标时复用；release 在非 `force`（`git clean -fdqx`）时拒绝脏工作树；prune／destroy 默认 dry-run，无显式标志时拒绝租借／脏／未并入槽位；损坏／截断状态从 `git worktree list --porcelain` 重建并标记为租借未验证。
- **命名分支（D1）** — `acquireWorktree({ branch })` 以 `git worktree add -b <branch>` 切出分支 HEAD，使 `commit_apply --push`／PR 流程有分支可取（git 拒绝 `--detach -b`）；该槽位仅对同名分支可复用。默认仍为 detached（与 treehouse 兼容）。

所有权按租约记录在状态文件中（持有者标签），而非 PID：DSH 子进程是宿主进程，因此重启安全的所有权记录是租约而非进程扫描。本引擎从不终止进程。完整设计记录、偏差 D1–D5 与安全恒等式见 `firstmate-worktree-scope.md`（workspace）。

<a id="configuration"></a>
## 配置

- `gitPath` — 可执行文件名（默认 `git`），经 subprocess seam 解析。
- `timeoutMs`，受上述上限保护 — 每条命令的 wall-clock 预算。
- `maxStdoutBytes`、`maxStderrBytes` — 收集上限。
- `graceMs` — 进程树终止宽限。

<a id="model-experience"></a>
## Model Experience

间接，经消费方（`@deepseek-ai/dsh-tool-git` 拥有 `commit`／`commit_apply`／`review` schema、`git:` 提示词 section 与结果渲染）。

#### KV Cache effect

无直接失效；已命名的消费方拥有各自的请求前缀变更。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **仅提交／评审子集** — 无交互式 rebase、amend、stash、bisect 或 submodule 动词；编辑器与交互式历史改写留在此 seam 之外。
- **每次调用都 shell-out** — 无持久 git daemon 或进程内索引缓存；每个动词派生 `git` 并收集有界输出。
- **无凭据／存储管线** — 服务假定环境提供 git 认证（SSH agent、credential helper），不管理 remote、密钥或签名。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
