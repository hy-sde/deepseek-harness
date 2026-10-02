---
description: "面向模型方的 commit、commit_apply、review 工具——agent 化 git 提交与评审工作流，外加 worktree 工作树池工具（持久租约的隔离工作树），读取在 ctx.vcs 与 ctx.git 之间按偏好路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-git

[English](README.md) | 中文

## 概述

`commit`、`commit_apply` 与 `review` 驱动 agent 化 git 提交与评审工作流，`worktree` 提供面向模型的工作树池与持久租约，使并行任务获得同一仓库的隔离、重启安全的工作目录。读取在 `ctx.vcs` 的 `pi-vcs` 探测干净时路由到它，否则回退 `ctx.git`；变更输入始终留在 `ctx.git`，因此写入路径不变。组合需要让模型编写确定性的拆分提交计划、并对已暂存 diff 做有界评审扇出时选用本包。成本是每次提交一次分析调用，外加由 `maxReviewers` 与 `maxReviewerDiffChars` 封顶的评审者扇出；评审质量仍由模型自行协商。

## 目录

- [读取偏好路由](#read-preference-routing)
- [功能](#what-it-does)
- [两阶段契约](#two-phase-contract)
- [Worktree 工具](#worktree-tool)
- [配置](#configuration)
- [导出形状](#export-shape)
- [Model Experience](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

面向模型方的 `commit`、`commit_apply`、`review` 三个工具——agent 化 git 提交与评审工作流，移植自 omp (oh-my-pi)。其底层宿主服务为 [`@deepseek-ai/dsh-git`](../git/README.zh.md)（`ctx.git`）。

<a id="read-preference-routing"></a>
## 读取偏好路由

`commit` 分析与 `review` 的每一项**读取**（仓库检查、变更文件、状态计数、numstat、diff 文本、分支）在宿主 bundle 注册了 [`@deepseek-ai/dsh-vcs`](../../vcs/vcs/README.zh.md)（`ctx.vcs`）且其 `pi-vcs` 探测干净时，都通过它解析——每次调用按需解析，每次工具执行只探测一次——否则回退到 `ctx.git`。**变更输入始终留在 `ctx.git`**（`addAll` 自动暂存、`commit_apply` 供 `stageHunks` 使用的原始暂存 diff），因此写入路径逐字节不变。门面位于 `./reads.ts`（`openReads` → `ReadSurface`），测试通过临时真实仓库旁的假 `pi-vcs` shim 加以验证（读取走 vcs 动词，自动暂存仍走 git）。


<a id="what-it-does"></a>
## 功能

在 `ctx.tools` 上注册三个工具，一个带提交／评审协商语法的 `git:` 系统提示词 section，并注入 `ctx.git`：

- **`commit`（分析，只读）** — 快照已暂存 diff（在无暂存内容且 `stagedOnly: false` 时自动暂存工作区），报告按文件的增删计数、有界 diff、`trivial` 分类、`lockFilesPending` 与 `suggestedPlan` 骨架。它从不写入仓库。
- **`commit_apply`（执行）** — 对照实际暂存状态校验 `SplitCommitPlan`，然后确定性提交：每个已暂存文件恰好规划一次，hunk 选择对照真实 diff 解析，分组按拓扑排序（环在任何写入前被拒绝），锁文件自动归位到拥有其兄弟 manifest 的分组。`dryRun: true` 预览确切的提交消息而不提交；`cwd` 选择仓库。`push: true` 把当前分支推送到 `origin` 并记录上游（`git push --set-upstream origin <branch>`），供 PR 工具取用；detached HEAD（默认工作树槽位）会被拒绝并给出指向 `worktree acquire --branch` 的指引——该命名分支组合就是发布路径。当挂载了 [`@deepseek-ai/dsh-orchestration-policy`](../../orchestration/policy/README.zh.md) 且其 `reviewGate` 生效时，推送还需要 `review --target staged` 对**完全相同**的暂存范围返回当前 `ship` 结论（身份 = 提交前 HEAD + 索引树）——否则 `commit_apply --push` 被拒绝并给出修复方法；结论由 `review` 工具按仓库记录，且只存在于宿主进程内。
- **`review`** — 按权重把已暂存 diff 切成至多 `maxReviewers` 份子代理运行，采用结构化评审者契约，按评审者置信度的最小值聚合 `ship`／`reject` 结论，按严重度排序 findings，并把传输失败报告为 errors（绝不静默批准未受评审的变更）。
- **`worktree`** — 池管理器：`acquire` 切出或复用隔离的 git 工作树（`--branch` 得到命名分支 HEAD，供 `commit_apply --push`／PR 流程使用），并返回持久 `leaseId`；`release` 归还槽位（以精确租约 id 为条件；非 `force` 时拒绝脏工作）；`list` 显示池的实时状态；`prune` 与 `destroy` 在 `yes` 前都是 dry-run，绝不自动触碰租借或脏槽位。切勿管理你不拥有的槽位——池是共享基础设施，清除或销毁兄弟槽位会毁掉另一任务的进行中工作。见 [Worktree 工具](#worktree-tool)。

<a id="two-phase-contract"></a>
## 两阶段契约

流程刻意由模型驱动但确定：`commit` 返回地面真值加计划骨架与指引，模型编写精确的 `SplitCommitPlan`（类型、作用域、摘要、详情、依赖、可选 hunk 选择），`commit_apply` 校验并无隐藏模型会话地执行。失败会重置索引，因此不会丢失任何变更，其余编辑都以可检查状态保留在工作区。

<a id="worktree-tool"></a>
## Worktree 工具

`worktree` 把 treehouse CLI 的动词面（acquire／release／list／prune／destroy）映射到 [`@deepseek-ai/dsh-git`](../git/README.zh.md#worktree-pool)（`./worktree`）的池引擎：

- **`acquire`** — 先 fetch（除非 `noFetch`），然后仅在可证明空闲（未租借、含未跟踪文件在内干净、HEAD 已并入精确重置目标）时复用槽位，否则在默认／推断基底分支上切出新槽位。返回 `path` ＋ `leaseId` ＋ 持有者／基底——持久所有权记录。`branch` 切出命名分支 HEAD（`commit_apply --push` 路径——`--push` 会记录 `origin/<branch>` 上游，PR 流程可接着取用）；`base` 覆盖切出点。
- **`release`** — 要求精确 `leaseId`（过期调用方永远无法释放他人的槽位），把槽位归还为 detached 于其基底待复用，非 `force` 时拒绝脏工作（`force` 则 `git clean -fdqx`）。
- **`list`** — 每槽位实时池状态：`leased`／`idle`／`damaged`，附干净／已并入／存在标志与持有者。
- **`prune`** — 默认 dry-run；`yes` 只移除未租借＋干净＋已并入槽位（`all` 遍历配置根下的所有池）。其余一律报告，从不猜测。
- **`destroy`** — 默认 dry-run；`includeLeased`／`includeUnlanded` 是不可逆场景的显式覆盖。

为什么用租约而非进程：DSH agent 是宿主子进程，因此在 `treehouse-state.json` 中的持久租约——而非 PID 扫描——才是宿主重启后仍然有效的东西；引擎从不终止进程。池根可配置（`worktreeRoot`，默认 `~/.treehouse`），每个工作区或机器可选择自己的池宿目录。

<a id="configuration"></a>
## 配置

- `reviewProvider` — 评审扇出的子代理提供方 id（默认 `spawn`）。
- `maxReviewers` — 最大并行评审者运行数（默认 4）。
- `maxReviewerDiffChars` — 每个评审者的 diff 窗口上限（默认 25k）。
- `maxDiffChars` — 分析 diff 上限（默认 60k）。
- `worktreeRoot` — `worktree` 的池根目录（默认 `~/.treehouse`）。
- `worktreeBaseBranch` — `worktree acquire` 的默认切出分支（默认：从 origin HEAD／当前分支推断）。
- `worktreeFetchBeforeAcquire` — acquire 前是否 fetch origin（默认 true；仓库无 origin 时跳过）。
- `worktreeLockWaitMs` — 池状态锁的最长等待（默认 30 秒）。
- `worktreeMaxSlots` — 每个仓库工作树池的总槽位上限（默认 0 = 不限制；达到上限后仍可复用可证明空闲的槽位，仅拒绝新建槽位）。

本部署的 agent preset 行挂载 `reviewProvider: spawn` 与 `maxReviewers: 4`。

<a id="export-shape"></a>
## 导出形状

函数／命名空间插件，导出 `name`／`inject`／`apply` 且无默认导出（多余的 default 会让 Loader 的 `unwrapExports` 折叠模块并丢弃 `inject`）。辅助函数与类型（`resolveCwd`、`toPriority`、`sliceByWeight`、`gitDiffSection`、`buildReviewerPrompt`、`SliceResult`、`ReviewerFinding` 及通用提交类型）从 `/commit` 与 `/review` 再导出，供测试与其他消费方使用。

<a id="model-experience"></a>
## Model Experience

### 工具 schema

#### What the model sees

生成的 [`commit`、`commit_apply`、`review`、`worktree` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-git)，以及系统提示词中的 `git:` section。

#### Token effect

工具可见时每个请求有固定的 schema 成本。`commit` 返回有界 diff（以 `maxDiffChars` 封顶）；评审者提示携带受 `maxReviewerDiffChars` 约束的有界 diff 窗口，因此扇出上下文不会无限增长。

#### KV Cache effect

工具定义、`git:` 提示词 section 与所配置预算不变时前缀稳定。`commit_apply` 与 `review` 的结果追加在可复用请求前缀之后，不会使较早条目失效。

### 工具调用历史与结果

#### What the model sees

每次 `commit` 调用把分析结果（文件、diff、计划骨架）保留在调用参数中。`commit_apply` 返回 `{ mode, created: [{ hash, message, changes }], messages, warnings }`——确定、小巧、可作回放权威。`review` 返回紧凑 JSON：结论、排序后的 findings、置信度、文件与错误。稳定失败在任何写入前抛出并给出可读消息：`Split commit plan missing staged files: <...>`、`Split commit plan assigns files to multiple groups: <...>`、`Invalid hunk selections: …`、`Circular dependency…`、以及索引为空时的 `nothing is staged; run `commit`…`。

#### Token effect

Token 增长随 diff 与 `commit_apply` 的 `created` 列表扩大；两者均受上述上限约束。评审者 findings 是摘要而非回显。

#### KV Cache effect

仅追加；新可见内容跟在可复用请求前缀之后，不会使既有 KV-cache 条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **工具内部无隐藏模型会话** — 提交评审质量是模型自身的协商；工具面只强制结构，不评判摘要的语义。
- **覆盖按文件粒度，hunks 可选** — 计划必须把每个已暂存文件计划一次；hunk 选择是文件*内*的细化，不放松覆盖要求。
- **锁文件自动归位，不可规划** — 它们从不进入骨架；`commit_apply` 依据所属 manifest 决定归入哪一组。
- **`review` 把未评审视为 reject** — 评审者传输失败（或空切片）拒绝批准，而非猜测。
- **无 force-push、amend、rebase 动词** — 服务面是提交／评审子集；编辑器与交互式历史改写仍在界外。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
