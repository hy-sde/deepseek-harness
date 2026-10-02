# Agent Note: 合并后验证清单（源自 0.1.5、0.1.6-alpha.2 与 0.2.0-rc.2 同步的经验）

Status: implemented

[English](2026-09-20-upstream-merge-post-merge-validation.md) | 中文

## 问题

连续三次上游同步都通过了全部静态门禁，却仍然在运行时把产品弄坏：

- **0.1.2-alpha.1（2026-08-30）：** [upstream-merge-runtime-checklist](2026-08-30-upstream-merge-runtime-checklist.zh.md) 记录了八类运行时缺陷，它们都藏在绿色的 `tsc -b` + 文档门禁之后，耗费两天调试。
- **0.1.5（2026-09-12）：** 合并看似全绿，但三个 fork 侧回归直到事后才浮出水面： （a）上游把 persona 行配置键从 `text:` 改名为 `prefix:`/`suffix:`，静默打破了每个 用户自建 preset（`~/.dsh/.agent-presets/*/agent.cordis.yml`）的 schemastery 校验 — 会话无法发消息，且每次重试都会重新挂载坏 preset；（b）一次把跨插件依赖改成 `workspace:^` 的升级使 `file:` 消费方以 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` 失败； （c）上游用只把空**对象**视为「未配置兼容」的版本替换了 fork 的 `configuredCompatEntries` — 但 schemastery 会把缺失的 `allowedFallbackModels` 物化为 `[]`（空**数组**），于是手写且无兼容声明的路由被拒绝，provider 从未注册，默认模型 每回合 `INVALID_CONFIG`。三者都是事后排查发现的；fork 自带包测试套件（其中就有 (c) 的回归测试）在合并验证期间从未运行过。
- **0.1.6-alpha.2（2026-09-20）：** 0.1.6-alpha.2 合并通过了安装、类型检查、配置 门禁和一次完整重建 — 然后正在运行的 `dsh web` **每**一回合都报 `Cannot read properties of undefined (reading 'prepare')`，对用户呈现为赤裸的 `UNKNOWN`（「This turn failed」）。根因（本会话的实机调试）：tsx **源码**启动为 CLI 引导从 `src` 加载工作区包（tsconfig `paths`），而 profile 加载器树按 package `exports` 解析到 `lib`；`dsh-tools` 在进程里出现两份，`TOOL_RUNTIME_SCHEDULER` 是模块级 `unique symbol`，于是 `dsh-agent-loop`（lib）查到的符号与 `tools` 服务实例（src） 创建的不是同一个。0.1.6 alpha 合并首次引入了跨包符号握手，所以原本就存在的平面 分裂直到这次合并才变成致命问题。源码启动加载树修复（源码启动检测、按启动 整顿 fallback、ambient 优先的行解析；详见 [source-launch 笔记](../architecture/2026-07-29-dsh-source-launch-tsx-esm.zh.md)）。

三次的共同模式：**在本 fork 中，绿色静态树是上游合并的必要条件，但永远不充分 — fork 包和运行中的 profile 绑定的是上游运行时语义（符号身份、配置 schema 形状、加载器 平面），静态门禁观察不到这些。**

## 决策

每次上游同步都是一次运行时发布。合并提交准备好之后，按下述清单依次验证，并把结果 记录在合并描述里。方括号内是该项要抓的故障来源。

### 0. 开始前的工作区卫生

1. 先提交或暂存无关的在途工作；绝不让别的任务遗留的 `git add -A` 悬着 — 被中断会话 暂存的半成品（未完成的 `apps/cli` 依赖升级）混进了错误的提交，让工作区锁文件 不一致被误判成测试失败。 [0.1.6]
2. 在 `git merge` 前记下合并基线和预期合并提交；之后仍能查询 fork 专有提交列表 （`git log --first-parent --format='%h %s' <base>..HEAD`）。

### 1. 合并机制

3. 合并后先跑翻译配对校验（自动合并驱动只在 Git 文本合并成功时合成记录）： `pnpm run verify-translation-pairing`，再用 `pnpm run verify-translation-pairing --write <pair>` 修复任何失同步对的配对。
4. 审计 fork 专有行为提交（`fix`、`feat`、`perf`）是否存活：对区间内每个这类 fork 提交，确认其本质存在于 合并后的 HEAD（`git diff --name-only <commit> HEAD -- <其文件>` 加针对标记的语义 grep）。0.1.5 审计正是这样找到唯一一个丢失的修复（空数组兼容检查，后已恢复）— 但最初只扫 `fix` 类提交的写法也漏掉了第二个丢失：fork 在 `session-persistence-jsonl` 里的字节感知 live-write 批处理被 0.1.5-rc.1 合并静默丢弃，直到 0.2.0-rc.2 评审才浮出水面并重新移植（9248da21c0d），因为它以 `feat` 提交落地。 [0.1.5, 0.2.0]

### 2. 静态门禁（必要但永不充分）

5. `pnpm install` 用全新锁文件，任何 `ERR_PNPM_*` 都按阻塞处理： `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` 意味着跨目录依赖泄漏了 `workspace:` — 跨仓库/注册表依赖必须保持 registry 区间（`^x.y.z`），升级期间也一样，绝不用 `workspace:^`。 [0.1.5]
6. 刚发布的依赖会触发 pnpm 的 24 小时最小发布龄隔离： `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`。pnpm 11.7.0 会读取工作区文件里的 `minimumReleaseAge` 值，却在锁文件复验时忽略其 `minimumReleaseAgeExclude` 列表 （CLI 参数 `--config.minimumReleaseAgeExclude` 仅对那一次调用有效）。用 `pnpm-workspace.yaml` 里的 `minimumReleaseAge: 0` 解锁，并在 `minimumReleaseAgeExclude` 下保留 `@org/dsh-*` 通配作为意图记录。 [0.1.6]
7. `npm run typecheck`（或 `pnpm -r check`）— 在 harness fork 和**每个依赖仓库** （如 dsh-plugins）里都要跑：fork 自带包按新的 `@deepseek-ai` 区间编译，上游 API 形状变更正是在这里变成 TS 报错（包改名 `@deepseek-ai/dsh-code-runtime` → `dsh-ptc-runtime`、`agent/created` 监听返回类型 `undefined | Promise<undefined>`、 `SubprocessHandle.control`、工具 schema 枚举扩宽）。依赖仓库的**测试套件也要跑** — 0.1.5 的 fork 套件里就有针对空数组兼容 bug 的回归测试，合并验证从未执行过。 [0.1.5]
8. 在相信类型检查之前，用 grep 扫改名符号/包名：旧包名、旧类型名（`Code*` 对 `Ptc*`）、 旧配置键、旧事件签名。类型检查会漏掉仍可解析的导入（废弃 npm 名仍会发布）和 USER 文件里的配置 schema 破坏。 [0.1.5, 0.1.6]
9. `pnpm run verify-cordis-config`（配置文件、解析、供应链策略）和文档门禁。 [0.1.5]
10. `pnpm run clean && pnpm run build` — tsc **和** tsdown 宿主+客户端都要； tsdown 入口配置和未声明的运行时导入对 tsc 不可见。 [0.1.2: 缺陷 1–2]
11. 对变更的插件重跑打包/发布级检查：构建并打包插件工作区 （`pnpm -r check/test/build`，再按依赖顺序逐包发布）。`pnpm pack` 会把 `workspace:^` 改写为具体版本，所以尚未发布的仅工作区兄弟包会破坏消费方 — 发布必须依赖优先。 [0.1.5, 0.1.6]

### 3. 配置与 preset 表面（用户文件也是产品的一部分）

12. 在启动**之前**就对照合并后的 schema 审计 `~/.dsh/.agent-presets/*/agent.cordis.yml`：改名或删掉的行键会在挂载时 schemastery 校验失败（0.1.5 的 persona `text:` → `prefix:`/`suffix:`），而坏 preset 每次重试都会重挂，报错循环。roster 里每个 preset 必须 `healthy` 而非 "broken"，且每个已配置 provider 必须出现在 `routableProviders`。 [0.1.5, 0.1.2: 缺陷 8]
13. 设置分层检查：确认用户的 `~/.dsh/settings.yaml` provider 仍能通过校验 （0.1.5 的 llm-pi-ai `configuredCompatEntries` 误报让 provider 从模型选择器里 消失，每回合 `INVALID_CONFIG`，而 UI 显示的是毫不相关的 API-key 提示块）。 [0.1.5]
14. 文档/版本引用：plugin-list、README/WORKFLOW 版本串、THIRD-PARTY 声明 （pre-commit 钩子会重新生成；把结果提交进去）。

### 4. 运行时验证（昂贵但必须的部分）

15. 用和用户完全一样的方式从**源码**启动产品：`pnpm dsh web`（tsx 启动）— 这正是 0.1.6 弄坏的二平面形态。同时验证**构建产物 bin** 启动 （`node apps/cli/lib/bin.js web`，构建后）仍然可用；两种启动模式都必须在单个 进程里落到同一个模块平面。 [0.1.6]
16. 端到端驱动真实会话：建会话、发一条带工具调用的消息、重启服务器、然后**恢复同一 会话**（0.1.6 崩溃只在重建+重启后的恢复回合复现）。留意 "This turn failed" / `UNKNOWN`。 [0.1.6]
17. 对符号键控的握手做模块平面断言：在运行中的进程里，从引导路径和加载器图分别解析 同一包并断言只有一个实例 — 例如任何进程都不得同时持有 `packages/core/tools/src/index.ts` 和 `.../lib/index.js`，且 `ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare` 必须是函数。修复笔记里的探针 （`loader.import('@deepseek-ai/dsh-tools')`）几秒内即可复现该检查。 [0.1.6]
18. 回合失败时先解码会话记录 （`~/.dsh/sessions/<workspace>/<session>/session.v3.jsonl.zstd`），不要相信被压平的 `code: 'UNKNOWN'`；底层抛错（如 `undefined.prepare`）才是判定类别的东西。 [0.1.6]
19. 每次源码修复后、重新判断前都要**重建** — 过期的 `lib/` 和 `dist/` 包已经误导过 三次不同的调试会话。0.1.6 崩溃只出现在重建合并后的 HEAD 之后；此前过期的合并前 lib 掩盖了平面分裂。 [0.1.2: 缺陷 3, 0.1.6]
20. 重跑目标包套件 + 类型检查，然后只提交预期文件（按路径 `git add`，检查 `git diff --cached`）；lefthook 只 lint 暂存子集，所以始终单独跑 `npm run typecheck`。 [0.1.2, 0.1.6]

### 5. 发布后续

21. 按依赖顺序发布改动的插件（每次发布都先 zstd-frame 后 session-intelligence）；之后把 registry 区间依赖切到已发布版本并重新安装。再升级 harness 的 `apps/cli` `@hy-sde-org/*` 区间并重跑第 5–7 步。 [0.1.6]

## 测试

本笔记是四次合并的累积结果；0.2.0-rc.2 的经验来自合并后的分层评审而非运行时故障，但收紧的是同一个存活审计。0.1.6 的证据链：0.1.6-alpha.2 合并在所有静态门禁上全绿 → 用户会话以 `UNKNOWN` 失败 → 会话日志显示 `Cannot read properties of undefined (reading 'prepare')`（位于 `agent-loop/lib/index.js:586`）→ 实机 inspector 证明存在 两个 `dsh-tools` 模块实例且 `Object.is(srcSymbol, libSymbol) === false` → 源码启动加载树修复让源码启动单一平面，同一个恢复回合随后正常执行了它的工具调用。按顺序 执行清单正是抓住各类问题的方式；未来合并必须运行它并把结果记入合并描述，这也是 0.1.2 清单笔记已有的要求。

## 后果

清单的成本是每次合并做一次真实启动（第 15–17 步），代价是两天串行调试或用户可见的 坏会话。静态门禁保持强制，但不再被视为合并就绪：「typecheck 绿」只是验证的开始。 0.1.2 清单对其八类问题仍然权威；本笔记补充 0.1.5/0.1.6 的类别（USER preset 的配置 schema 改名、跨仓库依赖协议、空数组兼容、模块平面身份）以及它们要求的操作纪律 （无关的暂存改动、会话日志解码、按启动整顿 fallback）。

## 备选方案

- 让模块 fallback 在 dev checkout 始终解析 `src` — 已否决：已安装或打包的运行时必须 保持无写入的 `lib` 查找，且同一 checkout 的构建产物 bin 启动必须回愈到 `lib`； fallback 改为按启动整顿。
- 重排 vendored loader 的 internal 优先顺序 — 已否决：config-shadow 契约 （`user-patches` 测试）钉死了该顺序；ambient 优先路径以 tsx 钩子为门控，所以 vitest/安装后的 bin 保留原快速路径。
- 把完整浏览器 E2E 自动化成唯一运行时门禁 — 已推迟：现在的门禁是手动第 15–16 步； 自动化的建会话/恢复会话 E2E 可以之后叠加。
