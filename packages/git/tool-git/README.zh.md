# @deepseek-ai/dsh-tool-git

[English](README.md) | 中文

面向模型方的 `commit`、`commit_apply`、`review` 三个工具——agent 化 git 提交与评审工作流，移植自 omp (oh-my-pi)。其底层宿主服务为 [`@deepseek-ai/dsh-git`](../git/README.zh.md)（`ctx.git`）。

## 功能

在 `ctx.tools` 上注册三个工具，一个带提交／评审协商语法的 `git:` 系统提示词 section，并注入 `ctx.git`：

- **`commit`（分析，只读）** — 快照已暂存 diff（在无暂存内容且 `stagedOnly: false` 时自动暂存工作区），报告按文件的增删计数、有界 diff、`trivial` 分类、`lockFilesPending` 与 `suggestedPlan` 骨架。它从不写入仓库。
- **`commit_apply`（执行）** — 对照实际暂存状态校验 `SplitCommitPlan`，然后确定性提交：每个已暂存文件恰好规划一次，hunk 选择对照真实 diff 解析，分组按拓扑排序（环在任何写入前被拒绝），锁文件自动归位到拥有其兄弟 manifest 的分组。`dryRun: true` 预览确切的提交消息而不提交；`cwd` 选择仓库。
- **`review`** — 按权重把已暂存 diff 切成至多 `maxReviewers` 份子代理运行，采用结构化评审者契约，按评审者置信度的最小值聚合 `ship`／`reject` 结论，按严重度排序 findings，并把传输失败报告为 errors（绝不静默批准未受评审的变更）。

## 两阶段契约

流程刻意由模型驱动但确定：`commit` 返回地面真值加计划骨架与指引，模型编写精确的 `SplitCommitPlan`（类型、作用域、摘要、详情、依赖、可选 hunk 选择），`commit_apply` 校验并无隐藏模型会话地执行。失败会重置索引，因此不会丢失任何变更，其余编辑都以可检查状态保留在工作区。

## 配置

- `reviewProvider` — 评审扇出的子代理提供方 id（默认 `spawn`）。
- `maxReviewers` — 最大并行评审者运行数（默认 4）。
- `maxReviewerDiffChars` — 每个评审者的 diff 窗口上限（默认 25k）。
- `maxDiffChars` — 分析 diff 上限（默认 60k）。

本部署的 agent preset 行挂载 `reviewProvider: spawn` 与 `maxReviewers: 4`。

## 导出形状

函数／命名空间插件，导出 `name`／`inject`／`apply` 且无默认导出（多余的 default 会让 Loader 的 `unwrapExports` 折叠模块并丢弃 `inject`）。辅助函数与类型（`resolveCwd`、`toPriority`、`sliceByWeight`、`gitDiffSection`、`buildReviewerPrompt`、`SliceResult`、`ReviewerFinding` 及通用提交类型）从 `/commit` 与 `/review` 再导出，供测试与其他消费方使用。

## Model Experience

### 工具 schema

#### What the model sees

生成的 [`commit`、`commit_apply`、`review` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-git)，以及系统提示词中的 `git:` section。

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

## 已知限制与待办

- **工具内部无隐藏模型会话** — 提交评审质量是模型自身的协商；工具面只强制结构，不评判摘要的语义。
- **覆盖按文件粒度，hunks 可选** — 计划必须把每个已暂存文件计划一次；hunk 选择是文件*内*的细化，不放松覆盖要求。
- **锁文件自动归位，不可规划** — 它们从不进入骨架；`commit_apply` 依据所属 manifest 决定归入哪一组。
- **`review` 把未评审视为 reject** — 评审者传输失败（或空切片）拒绝批准，而非猜测。
- **无 force-push、amend、rebase 动词** — 服务面是提交／评审子集；编辑器与交互式历史改写仍在界外。
