---
description: "并行优先的编排策略：配置驱动的扇出规则、fail-closed 的任务隔离守卫，以及由同一配置渲染的 `orchestration:policy` 系统提示段（firstmate 分发配置形态，P1）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-orchestration-policy

[English](README.md) | 中文

## 摘要

`dsh-orchestration-policy` 是「默认并行」工作方式的 P1 策略层：当请求可以分解为相互独立的任务块时，代理将它们扇出为隔离的任务子代理（`worktree acquire --branch` → `subagent { workspace }`），上限为已配置的并发数，并且只在存在真实依赖时才串行化。该策略由三部分组成，其中只有两部分是强制执行：

1. **策略文案** —— `orchestration:policy` [系统提示段](#model-experience)，由**启用守卫的同一份配置**渲染，因此文案与强制执行不会漂移。
2. **配置旋钮** —— `cordis.yml` 配置行（每个旋钮均可选，默认值见下）。整个策略在 `enabled: true` 之前**完全不生效**：默认关闭可保持当前「由模型自由裁量」的行为字节级稳定，直到某个部署显式开启。
3. **接口守卫** —— 可选的 `ctx.orchestrationPolicy` 服务。`tool-subagent` 通过 `ctx.get`（而非 `inject`）读取它，因此**挂载本插件是启用强制执行的唯一途径**；服务不存在即保持当前行为。在 `isolation: required` 下，未携带隔离 `workspace` 启动的任务子代理会被**拒绝**并返回可操作的修复提示（fail-closed）；无法支持 `workspace` 的提供方（进程外后端）则**降级为可见警告，绝不静默忽略**。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

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
| `maxFanOut` | `6` | 单个扇出波次的上限；超出部分作为后续波次。 |
| `isolation` | `required` | `required` = fail-closed 隔离；`suggested` = 仅提示。 |
| `enforceWorkspace` | `true` | 在 `isolation: required` 时是否由接口守卫强制执行隔离。 |
| `serializeReasons` | 全部四项 | 允许串行化的原因：`same-file-edit`、`semantic-dependency`、`shared-mutable-state`、`incompatible-concurrency`。 |
| `announcePlan` | `true` | 派发波次前向船长展示一次计划摘要。 |

**优先级固定**（沿用 firstmate 优先级）：当下船长的明确指示 > 已配置规则 > 已配置默认值 > 内置默认值。**配置错误在加载时即失败**并给出可操作信息（`maxFanOut` 必须为正整数；未知的隔离模式；未知的串行化原因）——绝不静默忽略或绕行。

### 策略带来的变化

1. **先分类，再扇出**：相互独立的任务块（不同文件/子系统、无共享可变状态、无顺序依赖）并行派发——每个任务一个隔离工作副本。**仅当命中 `serializeReasons` 中的真实依赖才串行化**；*仅同文件编辑不构成串行化理由*（按意图拆分后合并即可）。
2. **隔离是强制而非请求**：`isolation: required` + `enforceWorkspace` 意味着未携带 `workspace` 的 `subagent` 启动会被拒绝并提示修复方法（传入 `worktree acquire` 返回的 `path`）。无法支持 `workspace` 的提供方降级为可见警告，而不是静默地非隔离运行。
3. **先公告，再操控**：波次前一次计划摘要（`announcePlan`），`send_message` 在最近的步骤边界操控，`interrupt_agent` 取消，子代理结束后释放租约（未经船长明确同意绝不 `force`）。

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

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- 隔离要求背后的引擎：[`@deepseek-ai/dsh-git`](../git/README.md) 工作树池与持久租约，以及 [`@deepseek-ai/dsh-tool-git`](../git/tool-git/README.md) 中的 `worktree` 工具——`acquire --branch`、`release`、`list`、`prune`、`destroy`。
- 子代理边界：[`@deepseek-ai/dsh-tool-subagent`](../subagent/tool-subagent/README.md) 的 `workspace` 参数与 [`@deepseek-ai/dsh-tool-subagent-control`](../subagent/tool-subagent-control/README.md) 中的 `send_message`/`interrupt_agent` 操控工具。
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
3. Fan out: per chunk `worktree acquire --branch <task>` then `subagent { workspace: <lease path> }` — parallel, up to 6 per wave; beyond that announce the rest as a follow-up wave.
One task = one isolated working copy. A task child MUST be started with `workspace` set to a `worktree acquire` path — the guard rejects a start without one (this is fail-closed, not a preference).
4. Steer with `send_message` at the nearest step boundary; `interrupt_agent` cancels; `list_agents` shows the fleet. Collect every child before merging; release each lease after its child settles — never `force` a release without the captain's explicit word.
Announce the plan once before dispatch: N isolated tasks, what each owns, expected overlap (rare), who merges. One summary — never per-child chatter in the captain-facing thread.
```

#### Token 影响

`enabled: true` 时固定一段；禁用时文本为空（零 token）。段长度与波次规模无关——每个子代理的细节留在各自的回合中，不进入父代前缀。

#### KV 缓存影响

配置（模式、上限、原因、隔离）不变时前缀稳定；更改任一旋钮会改变渲染文本并使对应前缀失效。

## 已知限制与待办

- **只有隔离守卫是 fail-closed 的。** 分类、扇出上限、计划公告与操控步骤属于提示层引导——模型仍是执行者；不存在调度守护进程。
- **无能力的提供方仅警告、不失败。** 进程外后端（无 `workspace` 能力）降级为可见警告；若部署希望硬失败，请改为在组合层强制（`isolation: required` + 进程内提供方）。
- **推迟到 P2/P3：** 审查门（`review-gated` 姿态下 `ship` 结论阻止 `commit_apply --push`）与「结果而非机制」报告。

**运行时不变式：** 不发布伴生进程。本包除工具接口处的可选服务查找外，不持有同进程不变式可观察的持续运行时关系；其行为由包内测试套件保证（守卫矩阵、配置校验、提示渲染以及真实 git 波次 E2E）。

### 开发者注记

<details>
<summary>维护者工作上下文 — 点击展开</summary>

直接 `apply()` + `Service`（无 Schemastery 配置类）：`resolvePolicyConfig()` 在 `apply` 中急切执行，因此错误配置在**加载时**即失败（未满足 `systemPrompt` 注入的裸 `ctx.plugin` 会永久 pending——这也是加载失败测试先挂载 `SystemPrompt` 的原因）。守卫在 `tool-subagent` 的 spec 中经由真实工具路径验证（setup 之后再挂载策略——守卫在执行时惰性读取），并在此包的波次 E2E 中基于真实临时 git 仓库验证。

</details>
