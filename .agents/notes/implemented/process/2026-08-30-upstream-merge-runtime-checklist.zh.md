# Agent Note: 合并后的运行时检查清单（源自 0.1.2-alpha.1 同步的经验）

Status: implemented

[English](2026-08-30-upstream-merge-runtime-checklist.md) | 中文

## 问题

将上游原版 `v0.1.2-alpha.1` 合并进本 fork（即 0.1.2-alpha.1 的合并）时，我们只做了文档门禁与 `tsc -b` 校验——所有静态门禁都是绿的——但产品端到端仍然损坏。为了达到可用状态（即合并后的修复提交），又花了两天的 omp 会话调试（2026-08-29/30）。代价来自一个结构性事实：fork 自己的包是按合并前 API 语义编写的，而那些会破坏它们的上游 API 变更，仅靠类型与文档门禁不可见。共有八个独立的回归只在运行时浮现，且彼此层层遮盖。

八个缺陷类别，按发现顺序：

1. **客户端 tsdown 阶段无法解析入口。** api/wiki-controller 的 `tsdown.config.ts`（已删除）是从兄弟控制器错误克隆来的配置，声明了该仅 host 包并不存在的浏览器端半边（`lib/types/client/index.js`）。tsc 看不到 tsdown 的入口配置，所以只有完整执行 `pnpm run build` 才会失败。修复：删除该配置，与 `settings-controller` 的先例一致。
2. **web 启动时崩溃于未声明的依赖。** 该包生成的 `typert.host.js` 导入了 `zod`，但从未在 `dependencies` 中声明。只有真正启动 `pnpm dsh web` 才会暴露。修复：声明 `zod`（每个 typert 贡献者本就如此）。
3. **陈旧的客户端 bundle 导致插件加载失败。** 合并前构建出的客户端 bundle 把 `require("zod")` 外部化了，而模块表中既无对应行、也未内联核心。干净重建即可修复；只有打开 web UI 才能看到插件加载错误。
4. **注册到外部 slot 时与声明产生竞态。** `ui-countdown` 与 `ui-wiki` 在 `apply()` 里直接注册到 `sidebar.footer.action` / `shell.overlay`，而声明这两个 slot 的包把子表推迟到后面的 `ctx.effect` 才注册。上游的 slots API 要求使用顺序安全写法 `ctx.slots.inject(slotName, () => ctx.slots.register(...))`。只有启动 UI 才能看到 `slot "..." is not declared`。
5. **`@Remote` 方法与命名空间服务自身的方法冲突。** `wiki.remove` 与 `RemoteNamespaceService.prototype.remove`（其内部记账 API）冲突，RPC 注册直接拒绝。只有实时注册才能看到 `conflicts with its namespace service`。修复：把线路方法改名为 `wiki.delete`，覆盖控制器、客户端、fixtures 与测试——seam 侧的 `graph.remove` 保持不变。
6. **预设行引用了安装闭包之外的包。** fork 的工具包（`dsh-tool-memory`、`dsh-code-runtime-kernels`、`dsh-tool-logseq`、`dsh-tool-openwiki`、`dsh-tool-codebase-memory`、`dsh-tool-session-query`，以及更早的 `git`/`browser`/`av`）从未在安装锚点声明，导致预设解析与工作区创建失败。修复：fork 新增的工具包必须同时声明在 **`apps/cli/package.json`** 与 **`packages/bundle/base/package.json`**，随后 `pnpm install`。这是 fork 新增包的既有规则。
7. **一个 handler 抛错会中断整条 sink 链。** `ui-wiki` 的 `ctx.on('connection/reset', bind)` 使用了 `ctx.remote.wiki`，却没有在 `inject` 中声明 `'remote.wiki'`，于是第一次连接就抛错——这中断了其余连接 sink，导致会话列表流从未打开，侧边栏里所有历史会话全部消失。数据在整个过程中 100% 完好地躺在磁盘上。修复：在 `inject` 中声明子命名空间，并让测试 bench 提供它。
8. **空数组 compat 默认值在设置校验时拦截了路由。** Schemastery 会把缺失的 compat 字段物化为空值（`allowedFallbackModels: []`、`chatTemplateArgs: {}`、`chatTemplateKwargs: {}`），而 `packages/llm/llm-pi-ai/src/catalog.ts` 的 `configuredCompatEntries` 把空**数组**当成了已配置的开关（它早已正确处理空对象）。用户配置为 `openai-completions` 的 `local` 端点因此被拒绝，提供方从未注册，UI 便显示一个与密钥毫无关系的「模型不可用 / 需要 API key」拦截。修复：像过滤空对象一样过滤空数组，并补一个回归测试。

在其之上还有两个环境回归：合并后的工具链（`tsdown@0.22.2` → 经 `tsx@4.22.4` 引入 `import-without-cache@0.4.0`）在 Node 22.19/23.x 上会让 ESM loader-hook 链以 `ERR_INVALID_RETURN_PROPERTY_VALUE` 崩溃（engine 警告是误导信号），只有 Node 24 可用；另外 GUI 客户端拉起的 git hooks 在净化后的 PATH 下会死于 `node: not found`，通过在每条 lefthook shim 中烘焙安装时 node 的 bin 目录来修复。

## 决定

每一次把上游同步进本 fork 都是一次运行时发布，而不是文档练习。在合并提交定稿前，以下步骤为强制项。方括号内标注其要拦截的缺陷类别。

1. 用新的 lockfile 执行 `pnpm install`；核对 `node_modules/@deepseek-ai` 下每个 fork 包与每条预设行的链接。 [2, 6]
2. 从干净状态完整构建：`pnpm run clean && pnpm run build`（tsc **以及** tsdown 的 host + client）。 [1]
3. 启动真实产品：`pnpm dsh web`，然后用浏览器（或 RPC/WS 客户端）走一遍：工作区下拉选择、会话列表、打开会话、发送一条消息。 [2, 3, 4, 5, 6, 7]
4. 真实 profile 的暖启动验证：在 `$DSH_HOME` 上用用户持久化的 profile、settings 与 `~/.dsh/.agent-presets` 启动 web profile（经过 `healProfilesModuleFallback`）；roster 中每个预设都必须健康（不能是 "broken"），配置的提供方（例如经 `llm-pi-ai` 的 `local`）必须出现在 `routableProviders` 中。 [6, 7, 8]
5. 在新增 `@Remote` 方法前，先对照 `RemoteNamespaceService` 自身的成员核对命名空间 API 表面。 [5]
6. 全面排查 `ctx.remote.*`、`ctx.slots.register` 与事件 handler 是否遵守注入键纪律：使用子命名空间必须在 `inject` 中声明；注册到外部 slot 必须用 `ctx.slots.inject`。 [4, 7]
7. 每次源码/配置修复之后都必须**先重建再判断 UI**——陈旧的 `lib/` 与 `dist/` bundle 已经两次误导过本轮调试。 [3]
8. 提交前运行受影响的包测试，外加一次全新的 `pnpm run build` 与 `pnpm run typecheck`；提交前再跑一次干净的 `pnpm run clean && pnpm run build`。

## 测试

这次合并本身就是清单的证明：按顺序执行各步骤，恰好逐个暴露了上面 1 到 8 的缺陷；合并后的修复提交就是每步都能端到端通过的状态（构建、web 启动、工作区选择、会话可见、预设健康、local 提供方可路由）。未来的合并必须重跑该清单，并把结果写进合并描述。

## 后果

未来的上游同步将从一个可运行的基线出发，而不是一张全绿的静态树。该清单弥合了这次花掉两天的「静态到运行时」鸿沟：八个缺陷类别没有一个能通过步骤 1-8 存活，陈旧 bundle 陷阱被显式写入，fork 新增包的安装闭包规则从构造上防止预设/工作区损坏。立即付出的代价是每次合并多一次真实启动（步骤 3-4）加一轮浏览器操作——几分钟，对比两天的串行调试。本条也终结了「类型检查 + 文档门禁即合并就绪」的错误认知：它们必要但从不充分，因为 fork 包所绑定的上游运行时语义只有运行中的 profile 才能检验。

## 备选方案


先把每个 fork 包改写到适配上游 API 再合并——否决：它不会收敛，因为 API 表面一直在动，而且这些失败只有在运行中的系统里才可观察。把完整浏览器 E2E 自动化作为唯一门禁——推迟：清单中的浏览器步骤今天就有，自动化的 session-create + session-list E2E 可以之后再加；上面的步骤 3-4 已能拦截除 5 之外的所有缺陷类别，而 5 由静态检查拦截。
