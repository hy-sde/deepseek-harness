---
description: "并行优先的编排策略：配置驱动的扇出规则、fail-closed 的任务隔离守卫，以及由同一配置渲染的 `orchestration:policy` 系统提示段（firstmate 分发配置形态，P1）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-orchestration-policy

[English](README.md) | 中文

## 概述

`dsh-orchestration-policy` 让「默认并行」的工作方式变得可预测：当请求可分解为相互独立的任务块时，代理将它们扇出为隔离的任务子代理（每个 `worktree acquire` 租约一个），上限为已配置的并发数，并只在存在真实依赖时串行化。它从启用可选 `orchestrationPolicy` 接口守卫的同一份配置渲染 `orchestration:policy` 系统提示段，因此提示文案与强制执行不会漂移。在 subagent 与 worktree 工具旁挂载它；每个旋钮均可选，且在 `enabled: true` 之前策略保持惰性。它还接入暂存审查推送门与「结果而非机制」报告契约。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在需要「默认并行」的部署中，与 `dsh-tool-subagent` 以及 `worktree` 工具（`dsh-tool-git`）一同挂载：

```yaml
- name: '@deepseek-ai/dsh-subagent'
- name: '@deepseek-ai/dsh-subagent-spawn-in-process'
- name: '@deepseek-ai/dsh-git'
- name: '@deepseek-ai/dsh-tool-git'
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
- name: '@deepseek-ai/dsh-orchestration-policy'
  config:
    enabled: true
```

### 配置旋钮（全部可选）

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `false` | 总开关：为 `true` 之前守卫与提示文案均不生效。 |
| `defaultMode` | `parallel` | 可分解工作的姿态：`parallel`（默认）或 `serial`。 |
| `maxFanOut` | `3` | 单个扇出波次的上限；超出部分作为后续波次。 |
| `isolation` | `required` | `required` = fail-closed 隔离；`suggested` = 仅提示。 |
| `enforceWorkspace` | `true` | 在 `isolation: required` 时是否由接口守卫强制执行隔离。 |
| `serializeReasons` | 全部四项 | 允许串行化的原因：`same-file-edit`、`semantic-dependency`、`shared-mutable-state`、`incompatible-concurrency`。 |
| `announcePlan` | `true` | 派发波次前向船长展示一次计划摘要。 |
| `reviewGate.enabled` | 生效 | 策略启用时审查门即生效；`false` 退出。 |
| `reviewGate.default` | `review-gated` | 无显式条目仓库的常设姿态。 |
| `reviewGate.posture` | `{}` | 按仓库根前缀的显式常设姿态（`*` = 全局；最长匹配前缀获胜）。宿主自有配置——绝不使用仓库文件。 |
| `reviewGate.requireVerdict` | `ship` | 当前唯一可释放推送的结论。 |
| `reviewGate.onUnavailable` | `block` | 无当前 `ship` 结论时：`block`（fail-closed 拒绝）或 `warn`（明确的降级）。两种模式下 `reject` 结论都始终阻止。 |
| `scoutPolicy.knowledgeOnly` | 五个标签 | 输出为「侦察」而非 PR 形态的意图标签（提示层引导）。 |
| `reporting.mode` | `outcomes` | 船长可见文案遵循结果契约；`verbose` = 今日行为（调试）。 |
| `reporting.includePerTask` | `summary` | 单块波次总结中的逐任务细节：`summary`（每任务一行）或 `detail`（细节块）。 |
| `reporting.forbiddenTerms` | 七个词 | 船长可见文本中需翻译或省略的机制词汇（默认：subagent、workspace、lease、worktree、pool、continuation、provider）。 |

**优先级固定**（沿用 firstmate 优先级）：当下船长的明确指示 > 已配置规则 > 已配置默认值 > 内置默认值。**配置错误在加载时即失败**并给出可操作信息（`maxFanOut` 必须为正整数；未知的隔离模式；未知的串行化原因）——绝不静默忽略或绕行。

### 策略带来的变化

1. **先分类，再扇出**：相互独立的任务块（不同文件/子系统、无共享可变状态、无顺序依赖）并行派发——每个任务一个隔离工作副本。**仅当命中 `serializeReasons` 中的真实依赖才串行化**；*仅同文件编辑不构成串行化理由*（按意图拆分后合并即可）。
2. **隔离是强制而非请求**：`isolation: required` + `enforceWorkspace` 意味着未携带 `workspace` 的 `subagent` 启动会被拒绝并提示修复方法（传入 `worktree acquire` 返回的 `path`）。无法支持 `workspace` 的提供方降级为可见警告，而不是静默地非隔离运行。
3. **先公告，再操控**：波次前一次计划摘要（`announcePlan`），`send_message` 在最近的步骤边界操控，`interrupt_agent` 取消，子代理结束后释放租约（未经船长明确同意绝不 `force`）。
4. **在边界把关**：在 `review-gated` 姿态下，没有对同一暂存范围的当前 `ship` 结论就推送会被拒绝并给出修复方法（`review --target staged`）；审查后重新暂存/amend 得出的结论为**过期**，需重新审查。结论存于宿主进程——宿主重启即清空，这是刻意的 fail-closed。
5. **报告结果而非机制**：船长每波读到一个块（已决定／已交付／已阻塞／需要船长），而不是 N 份子代理转录；机制词汇被翻译或省略；每个「需要你」都是决策、阻塞、凭据需求或待评审结果。细节按需提供。

配套引擎旋钮：`dsh-tool-git` 的 `worktreeMaxSlots` 限制每个仓库的工作树池（默认 `0` = 不限制）；达到上限时 `acquire` 拒绝**新建**槽位（`MaxSlots` 错误，仍然允许复用可证明空闲的槽位）——可执行 `release`/`prune`/`destroy` 或提高上限。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

本节说明守卫机制；可观察行为见 [使用本包](#use-this-package)。

### 三部分，同一事实来源

`resolvePolicyConfig()` 校验并解析部分配置（在加载时抛出可操作的错误），提示段由该已解析配置渲染——与守卫读取的是同一对象。因此配置与提示文案不可能漂移。

### 服务注册即启用开关

`OrchestrationPolicyService extends Service`，以 `orchestrationPolicy` 注册（随所属 fiber 自动移除）。`tool-subagent` 在每次执行时通过 `ctx.get('orchestrationPolicy')` 读取——可选服务查找，而非 `inject`，因此**「不存在」是一等状态**：即当前字节级稳定的行为。`ctx.get` 不要求注入声明，守卫不会破坏任何从未挂载本包的组合。

### 守卫语义矩阵

| 策略状态 | 提供方可隔离 | 给定 `workspace` | 结果 |
|---|---|---|---|
| 未挂载 / `enabled: false` | 任意 | 任意 | 无操作（当前行为） |
| `required` + `enforceWorkspace` | 是 | 否 | **抛出** `OrchestrationPolicyError`（修复：`worktree acquire` → 传入 `path`） |
| `required` + `enforceWorkspace` | 否 | 否 | **返回警告字符串**（调用方在工具输出中呈现） |
| `required` + `enforceWorkspace` | 任意 | 是 | 允许 |
| `suggested` 或 `enforceWorkspace: false` | 任意 | 任意 | 无操作（仅提示性引导） |

守卫位于面向模型的 `tool-subagent` 接口（一次性与续接启动均覆盖）。SDK/ACP/API 路径不经过该工具，永远不会看到守卫。

### 推送门机制（P2）

`review --target staged` 按仓库记录 `{ root, beforeHead, indexTree, verdict }`（每个目标一条记录，因此后续 worktree 审查不会遮蔽暂存结论）。`commit_apply --push` 在**任何暂存/提交之前**快照同一对身份，解析仓库姿态（`resolvePosture`：最长前缀匹配 → `*` → 配置默认 → `review-gated`），并查阅记录：缺失 → 按 `onUnavailable` 执行 `block`/`warn`；身份不匹配 → 过期（始终阻止）；`reject` → 始终阻止；`ship` 且身份匹配 → 放行并记录提示。本地提交（`push: false`）永不过门——门只守边界。

### 报告契约（P3）

`buildReportingRules` 从已解析配置（`mode`、`includePerTask`、`forbiddenTerms`）渲染结果契约——`mode: 'verbose'` 时为空，因此今日行为只需一个旋钮。该段是纯提示文本：模型拥有最终消息；没有工具侧渲染接缝。契约（每波一块、需要你分类、逐任务旋钮、禁用词汇）以纯函数契约固定于测试，而非金色样本散文。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- 隔离要求背后的引擎：[`@deepseek-ai/dsh-git`](../../git/git/README.zh.md) 工作树池与持久租约，以及 [`@deepseek-ai/dsh-tool-git`](../../git/tool-git/README.zh.md) 中的 `worktree` 工具——`acquire --branch`、`release`、`list`、`prune`、`destroy`。
- 子代理边界：[`@deepseek-ai/dsh-tool-subagent`](../../subagent/tool-subagent/README.zh.md) 的 `workspace` 参数与 [`@deepseek-ai/dsh-tool-subagent-control`](../../subagent/tool-subagent-control/README.zh.md) 中的 `send_message`/`interrupt_agent` 操控工具。
- 移植计划：P1 范围说明 `firstmate-policy-scope.md`（与 `port_firstmate.md` 一同保存在 fork 工作区），P2 审查门与 P3「结果而非机制」报告。

-----

<a id="model-experience"></a>
## 模型体验

### 系统提示段

#### 模型看到的内容

`orchestration:policy`（优先级 129）——挂载时由**已解析配置**渲染；`enabled: false` 时文本为空。该段以「隔离工作副本 / 任务子代理」的口吻表述，绝不暴露策略内部术语（firstmate §9 形态）。

##### 段模板

```markdown
# Orchestration policy (parallelize-by-default)
Goal: same quality, more velocity, less captain cognitive load. Fan out independent chunks as isolated task children; today's serial behavior is the exception.
1. Classify before doing: independent chunks (different files/subsystems, no shared mutable state, no ordering) or one unit of work.
2. Serialize ONLY for a true dependency — the accepted reasons are:
- same-file-edit: two chunks edit the same file
- semantic-dependency: one change is an input to the next
- shared-mutable-state: lockfiles, migrations, generated code, credentials
- incompatible-concurrency: both rework the same subsystem in conflicting ways
   Same-file edits ALONE are not a reason to serialize: split by intent and merge; a shared-file edit with conflicting intent is `incompatible-concurrency`.
3. Fan out: per chunk `worktree acquire --branch <task>` then `subagent { workspace: <lease path> }` — parallel, up to 3 per wave; beyond that announce the rest as a follow-up wave.
One task = one isolated working copy. A task child MUST be started with `workspace` set to a `worktree acquire` path — the guard rejects a start without one (this is fail-closed, not a preference).
4. Steer with `send_message` at the nearest step boundary; `interrupt_agent` cancels; `list_agents` shows the fleet. Collect every child before merging; release each lease after its child settles — never `force` a release without the captain's explicit word.
5. Quality gate: under the `review-gated` posture (the default for any repository without an explicit `fast` entry), a push is REFUSED until `review --target staged` returns `ship` for the CURRENT staged range — run `review` after staging, before `commit_apply --push`. Any change after the review makes the verdict stale and a re-review is required; a `reject` verdict always blocks (even under `onUnavailable: warn`). Only an explicit `fast` posture skips the gate — never infer trust.
6. Report OUTCOMES, not mechanics: after each wave, give the captain ONE block — what was decided, what shipped, what is blocked, and what needs the captain.
Every "needs you" item is one of: a decision, a blocker, a credential need, or a review-ready result — never a child transcript.
Per-task detail: one line per task in the wave summary (detail stays available on request).
Translate or omit mechanics vocabulary in captain-facing text: subagent, workspace, lease, worktree, pool, continuation, provider. When the captain asks for details, give them (escrow, don't dump).
Knowledge-only intents (investigate, diagnose, plan, audit, reproduce) produce investigation notes, not PR-shaped changes.
Announce the plan once before dispatch: N isolated tasks, what each owns, expected overlap (rare), who merges. One summary — never per-child chatter in the captain-facing thread.
```

#### Token 影响

`enabled: true` 时固定一段；禁用时文本为空（零 token）。段长度与波次规模无关——每个子代理的细节留在各自的回合中，不进入父代前缀。

#### KV 缓存影响

配置（模式、上限、原因、隔离）不变时前缀稳定；更改任一旋钮会改变渲染文本并使对应前缀失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **只有隔离守卫是 fail-closed 的。** 分类、扇出上限、计划公告与操控步骤属于提示层引导——模型仍是执行者；不存在调度守护进程。
- **无能力的提供方仅警告、不失败。** 进程外后端（无 `workspace` 能力）降级为可见警告；若部署希望硬失败，请改为在组合层强制（`isolation: required` + 进程内提供方）。
- **结论存于进程内。** 宿主重启即清空，因此被把关的部署在重启后必须先重新审查，门才会释放推送——刻意的 fail-closed，绝不推断。
- **姿态是宿主自有配置。** 逐仓库的 `fast` 退出项位于策略配置行；支持仓库可写的姿态文件属于注入面，不予支持。
- **报告只是策略文本。** 结果契约塑造船长可见的最终消息；没有渲染接缝（工具输出对代理自身保持原样，按范围文档的诚实边界）。若简报跑偏，收紧 `forbiddenTerms` / `includePerTask`——或一旦违约率证明提示契约太软，再引入真正的接缝。

**运行时不变式：** 不发布伴生进程。本包除工具接口处的可选服务查找外，不持有同进程不变式可观察的持续运行时关系；其行为由包内测试套件保证（守卫矩阵、配置校验、提示渲染以及真实 git 波次 E2E）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

直接 `apply()` + `Service`（无 Schemastery 配置类）：`resolvePolicyConfig()` 在 `apply` 中急切执行，因此错误配置在**加载时**即失败（未满足 `systemPrompt` 注入的裸 `ctx.plugin` 会永久 pending——这也是加载失败测试先挂载 `SystemPrompt` 的原因）。守卫在 `tool-subagent` 的 spec 中经由真实工具路径验证（setup 之后再挂载策略——守卫在执行时惰性读取），并在此包的波次 E2E 中基于真实临时 git 仓库验证。

</details>
