<!-- 英文源文件由 scripts/gen-tool-catalog.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-tool-catalog` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/tool-catalog.md` 重新记录配对。 -->

# 工具 Schema 目录

[English](tool-catalog.md) | 中文

已发布插件向 `ctx.tools` 提供的所有面向模型的工具：模型通过系统提示词组装获得的 `name`、`description` 和 JSON Schema `parameters`。本目录是[子系统页面](subsystems/core.zh.md)（类型及每页生成的 `cordis-surface` 接线区域）的补充；本页列出的是向 agent（智能体）提供的*工具*。

英文源文件由系统**生成**，并通过 `pnpm run verify-tool-catalog`（`doc-sync`（文档同步门禁）的一部分）验证新鲜度；本中文文件作为经评审对侧通过双语配对维护。与 Cordis 目录（纯源码 AST 处理）不同，英文生成器会在真实上下文中**启动**每个工具插件并读取 `ctx.tools.schemas()`，因为工具 schema 无法通过静态分析完全确定，例如运行时展开的枚举、拼接的描述、由配置决定的名称以及使用原始 JSON Schema 的 MCP 工具。完整性守卫会 glob 匹配 `packages/*/tool-*`；如果生成器的启动 manifest（元数据清单）遗漏任何包，检查就会失败，因此新工具不会在无人察觉的情况下缺少文档。。

范围：`packages/*/tool-*` 下已发布的产品工具，每个工具均使用其**默认**配置启动；但如果某个 Config 字段是**必填项**且没有默认值，生成器就必须作出选择，对应包的说明会记录本页展示的是哪个分支。注册的工具**名称**可以是加载时配置，例如 `tool-subagent` 的 `toolName`，因此部署可能以不同名称或额外名称提供某个包；如果存在随产品发布的别名，对应包的说明会予以记录。`examples/` 中的演示工具（例如 `echo`）不在范围内，这与 Cordis 目录仅涵盖包的范围一致。

<a id="tool-package-map"></a>
## 工具包映射

下表将模型可见的工具名称与其背后的插件包和服务 seam 对应起来。各包章节随后给出确切的 JSON Schema。

| 工具包 | 模型可见名称 | 依赖 | 写入／影响 | 随产品发布的别名 | 部署说明 |
| --- | --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh-plugin-manager` | `plugin_manager` | `ctx.tools`, `ctx.pluginManager`, `ctx.sandboxPolicy` | `tool/call`, `tool/result`, `user/message` | - | - |
| `@deepseek-ai/dsh-mcp-resources` | `list_mcp_resource_templates`, `list_mcp_resources`, `read_mcp_resource` | `ctx.tools`, `ctx.mcpResources` | `tool/call`, `tool/result` | - | - |
| `@deepseek-ai/dsh-experimental-browser-use-stagehand-native` | `stagehand_act`、`stagehand_extract`、`stagehand_navigate`、`stagehand_observe`、`stagehand_screenshot`、`stagehand_tabs` | `ctx.browserUse`、`ctx.agents`、`ctx.tools`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | - |
| `@deepseek-ai/dsh-tool-ask-user` | `ask_user_question` | `ctx.tools`、`ctx.userQuestions` | `tool/call`、`tool/result after a UI/provider answers the question` | - | ask_user_question 会暂停工具调用，直到当前 UI 提供方返回人类答案。 |
| `@deepseek-ai/dsh-tools` | `run_code` | `ctx.tools`、`ctx.ptcRuntime (execution time)`、`ctx.systemPrompt` | `tool/call`、`one tool/ptc-dispatch-start + tool/ptc-dispatch pair per bridged sub-call`、`tool/result` | - | 在 `mode: ptc`／`mode: both` 下，它由工具注册表所有，作为可过滤能力层之外的保留传输机制（参见 PTC mode Agent Note）。在 `ptc` 下，它是注册表对协议格式（wire format）的唯一贡献；其他可见能力在使用已加载运行时语言生成的 SDK 章节中声明。程序通过 binding 调用这些能力，调用按照原生并发约定调度：启动顺序和策略遵循提交顺序，并发安全的函数体最多重叠执行 `maxParallelSubCalls` 个。调用会重新进入完整且受守卫保护的工具流水线，并将每个嵌套执行关联到此外层结果。 |
| `@deepseek-ai/dsh-plan-mode` | `exit_plan_mode` | `ctx.tools`、`ctx.systemPrompt`、`ctx.userQuestions (execution time, opportunistic)` | `tool/call`、`plan/mode inactive on an approved review`、`tool/result` | - | 规划未激活时，exit_plan_mode 仍保留在面向模型的 schema 中，这样状态转换不会在规划策略变更之外额外造成工具目录变动。其执行路径会拒绝规划模式之外的调用；在规划模式下，它通过用户交互 seam 提交计划（批准／根据反馈继续规划），批准后会在步骤边界记录规划模式已停用。 |
| `@deepseek-ai/dsh-tool-bash` | `bash` | `ctx.tools`、`ctx.shell`、`ctx.systemPrompt`、`ctx.shellEnv`、`ctx.jobs at call time for run_in_background` | `tool/call`、`tool/result` | - | bash 工具是 bash 执行器 seam 面向模型的消费方。使用 `run_in_background` 的运行会注册到通用 `ctx.jobs` 运行时，并通过 `job_*` 工具（来自 `@deepseek-ai/dsh-tool-jobs`）收集／停止；禁用 `enableRunInBackground` 配置（默认为 true）后，该参数会被完全移除。 |
| `@deepseek-ai/dsh-tool-present` | `present` | `ctx.tools`、`ctx.fs`、`ctx.sessionProjections` | `tool/call`、`deliverables/presented after a successful final result`、`tool/result` | - | 交付物归属于调用它的 Session；Web ui-deliverables 提供源文件打开与卡片展示。 |
| `@deepseek-ai/dsh-tool-pwsh` | `pwsh` | `ctx.tools`、`ctx.shell`、`ctx.systemPrompt`、`ctx.shellEnv`、`ctx.jobs at call time for run_in_background` | `tool/call`、`tool/result` | - | pwsh 工具是 Windows 组合中 bash 执行器 seam 的 PowerShell 方言消费方（由 `@deepseek-ai/dsh-pwsh-local` 等 PowerShell 执行器为 `ctx.shell` 提供后端）；除沙箱接口外，它逐项对应 bash 工具调用。使用 `run_in_background` 的运行会注册到通用 `ctx.jobs` 运行时，并通过 `job_*` 工具收集／停止；托管的 `DSH_*` 环境来自 `@deepseek-ai/dsh-shell-env`。每次调用都在新进程中运行，不使用持久 PTY 会话。路径采用原生 `C:\...` 形式，变量采用 `$env:NAME`。 |
| `@deepseek-ai/dsh-tool-cordis` | `cordis_inspect_list`, `cordis_inspect_query` | `ctx.tools`, `ctx.cordisInspect` | `tool/call`, `tool/result` | - | 创造模式提供两个只读运行时检查工具。Cordis host runner 提供检查注册表；Client 查询需要已连接页面。持久化变更编写为组合包，再通过 plugin_manager 安装。 |
| `@deepseek-ai/dsh-tool-bash-persistent` | `bash` | `ctx.tools`、`ctx.terminals`、`an owning Agent at execution time` | `tool/call`、`PTY shell state`、`tool/result` | - | 一个按所有者隔离的持久 bash 工具；部署组合提供 PTY 后端，并可覆盖面向模型的环境描述。 |
| `@deepseek-ai/dsh-tool-edit` | `edit` | `ctx.tools`、`ctx.fs`、`ctx.systemPrompt`、`ctx.lsp (optional: format-on-write / diagnostics-on-write)` | `tool/call`、`fs/write-intent or fs/edit-intent for mutations`、`fs/observed after read presence/absence or successful file operation`、`tool/result` | - | 四种模式的 `edit`（replace / patch / apply_patch / hashline）移植自 @oh-my-pi。与 tool-fs 同时挂载时应设置 `enableEdit: false`，让富编辑工具独享 `edit` 名称。 |
| `@deepseek-ai/dsh-tool-pwsh-persistent` | `pwsh` | `ctx.tools`、`ctx.terminals`、`an owning Agent at execution time` | `tool/call`、`PTY shell state`、`tool/result` | - | 一个按所有者隔离的持久 pwsh 工具，持久 bash 工具的 Windows 对应物；部署组合提供 pwsh 方言的 PTY 后端，并可覆盖面向模型的环境描述。 |
| `@deepseek-ai/dsh-tool-str-replace-editor` | `str_replace_editor` | `ctx.tools`、`ctx.fs` | `tool/call`、`fs/observed after view presence/absence, edit absence, or successful mutation`、`tool/result` | - | 独立于文件系统接缝的查看／创建／唯一字面替换／行插入工具；可与任何 Shell 或终端 API 组合使用。 |
| `@deepseek-ai/dsh-tool-fs` | `edit`、`read`、`read_image`、`write` | `ctx.tools`、`ctx.fs`、`ctx.systemPrompt`、`ctx.attachments (read_image registration)`、`ctx.llm + an image-capable route (read_image execution)` | `tool/call`、`fs/write-intent or fs/edit-intent for mutations`、`fs/observed after read presence/absence or successful file operation`、`durable attachment (read_image)`、`tool/result` | - | 先读后写／编辑策略由 `@deepseek-ai/dsh-fs-observation-policy` 添加；它是一个 `fs/*` 事件门禁插件，不会改变 schema。加载这些工具的部署按预期也应加载该插件。没有 `ctx.attachments` 时 `read_image` 不会注册；其 schema 与路由无关，执行时除非确切路由的模型声明图像输入，否则拒绝。 |
| `@deepseek-ai/dsh-tool-graph` | `update_agent_graph`、`view_agent_graph`、`yield_agent_graph` | `ctx.tools`、`执行时归属的 Agent（root／direct-only 强制由宿主侧执行）`、`可选的 `agentGraphController` 服务（通过 ctx.get 读取）` | `tool/call`、`tool/result` | - | 宿主提供控制器上的 Agent Graph 监督工具（Maka 移植，切片 P4）：恰好三个模型可见工具 view_agent_graph / update_agent_graph / yield_agent_graph，外加 orchestration:graph 提示段。控制器服务是可选的（ctx.get），因此没有图宿主时会话也能创建；在提供之前每次调用都会以 [agent-graph-unavailable] 明确失败，宿主强制 root-only、direct-only 寻址。 |
| `@deepseek-ai/dsh-tool-fs-search` | `glob`、`grep` | `ctx.tools`、`ctx.subprocess`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | glob 和 grep 是无条件可用的发现工具，通过 ctx.subprocess spawn 随包提供的 ripgrep 二进制文件（`@vscode/ripgrep`），并作为普通前台调用运行，绝不作为后台任务；无需在宿主机安装 `rg`，也不经过 shell 层。本目录使用 `sampleOverCapGlobResults: true`；部署必须显式选择该行为。结果超过上限时，会通过可选的 ctx.spillStore 后端保存完整的格式化列表；在共置部署中，如果后端公开本地路径，返回的定位信息可供后续读取／搜索。 |
| `@deepseek-ai/dsh-tool-ast` | `ast_edit`、`ast_grep` | `ctx.tools`、`ctx.subprocess`、`ctx.systemPrompt`、`ctx.fs (ast_edit apply)` | `tool/call`、`fs/observed + fs/edit-intent + fs/write-intent for ast_edit apply (via ctx.fs)`、`tool/result` | - | ast_grep（结构化搜索）与 ast_edit（预览／应用结构化重写）由随包提供的 ast-grep 原生二进制（`@ast-grep/cli`）驱动——无需在宿主机安装 ast-grep，也不经过 shell 层。ast_edit 总是**先预览**（apply 默认为 false），且只有在 apply: true 时才写入文件，写入经文件系统缝隙（观察＋版本校验＋沙盒策略）。 |
| `@deepseek-ai/dsh-tool-memory` | `learn`、`memory_edit`、`mine_sessions`、`recall`、`reflect`、`retain` | `ctx.tools`、`ctx.memory`、`ctx.systemPrompt` | `tool/call`、`project memory files under the configured memory root on retain/learn/memory_edit (recall and reflect are read-only)`、`tool/result` | - | retain、recall、reflect、memory_edit、learn 与 mine_sessions 基于宿主的 `ctx.memory` 服务，外加一个 `memory:project` 系统提示区段，在下一会话开始时重新载入该会话的项目记忆（摘要＋教训＋工作条目）（port_omp.md 第 4 项）。同时挂载 `sessionQuery` 服务（tool-session-query 行）时，`recall`/`reflect` 合并过往会话命中（source `session`、只读、带 sessionId/seq 溯源），`mine_sessions` 从已完成的会话日志中收割教训；没有该服务时所有会话特性降级为无操作。本移植仅内置 local；注册表为后续 Hindsight/Mnemopi 提供方保留接缝。 |
| `@deepseek-ai/dsh-tool-terminal` | `terminal_close`、`terminal_list`、`terminal_open`、`terminal_read`、`terminal_send`、`terminal_signal` | `ctx.tools`、`ctx.terminals`、`ctx.systemPrompt`、`ctx.jobs at call time for run_in_background` | `tool/call`、`tool/result` | - | 这 6 个终端工具需要选择启用，用于补充一次性 bash／文件系统工具。`terminal_send(run_in_background: true)` 会注册到 `ctx.jobs`；schema 不包含 TUI、具名按键序列、BEL、调整尺寸、自动启动和跨 agent 共享。 |
| `@deepseek-ai/dsh-tool-goal` | `create_goal`、`get_goal`、`update_goal` | `ctx.tools`、`ctx.agents`、`ctx.goals`、`ctx.systemPrompt`、`a calling Agent in an authorized open turn` | `tool/call`、`goal/change for mutations`、`tool/result` | - | create、edit、pause 和 resume 要求直接来自人类的根权限；complete 和 blocked 也接受确切的当前 Goal Round。blocked 的默认下限是 3 个获准的 Round。 |
| `@deepseek-ai/dsh-schedule` | `schedule_create`、`schedule_delete`、`schedule_list` | `ctx.tools`、`ctx.sessions`、Session 持久化、未来创建的 live 根 Agent | `tool/call`、`schedule/change create or delete`、`tool/result` | - | 仅在选择启用的 Schedule 插件加载后创建的 live 根 Agent scope 内注册。版本 1 接受 after_seconds、显式绝对 at 和有界固定速率 every_seconds，并披露 session-local 交付；管理读取与变更必须通过共享的 Session 持久化 barrier。 |
| `@deepseek-ai/dsh-tool-debug` | `debug` | `ctx.tools`, `ctx.dap`, `ctx.systemPrompt`, `a session workspace cwd` | `tool/call`, `tool/result`, `the composed debuggee process state via the mounted DAP adapter` | - | debug composes a real debugger (gdb/lldb-dap/debugpy/dlv/...) through the DAP capability seam (ctx.dap) with one exclusive active session: launch/attach, source/function/instruction/data breakpoints, continue/pause/step, threads/stackTrace/scopes/variables/evaluate, disassemble, read_memory/write_memory, modules, loaded_sources, custom_request, output, terminate, sessions. Requires a mounted DAP provider and the spawn seam; with none available, launch/attach return a structured "unavailable" error naming the missing adapter. |
| `@deepseek-ai/dsh-code-runtime-kernels` | `run_kernel_code` | `ctx.tools`、`ctx.systemPrompt`、`调用时 PATH 上的 python3 与 node 二进制（或配置 pythonPath/nodePath）` | `tool/call`、`kernel 子进程会话状态（按 session id，reset: true 时重置）`、`tool/result` | - | run_kernel_code 在持久化 kernel（python3 或 node 子进程，仅标准库／内置）中执行模型代码，共享同一个宿主驱动：按 session id 的 kernel 状态与 reset、墙钟预算、SIGINT→SIGTERM→SIGKILL 升级、恶意对端解析。这是进程隔离而非安全边界——与 harness 进程后端相同的信任（port_omp.md 第 1 项）。 |
| `@deepseek-ai/dsh-tool-lsp` | `lsp` | `ctx.tools`、`ctx.lsp`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | lsp 工具将提供方选择和语言服务器子进程置于 ctx.lsp 之后，因此其模型可见 schema 在更换提供方时保持稳定。运行时要求已注册提供方，例如 `@deepseek-ai/dsh-lsp-stdio`；如果没有提供方，查询会返回结构化 `LSP_UNAVAILABLE` 错误，而不会改变 schema。 |
| `@deepseek-ai/dsh-tool-ralph` | `ralph` | `ctx.tools`、`ctx.workflowEngine`、`ctx.subagents`、`ctx.systemPrompt`、`a calling Agent (exec.agent parents every fresh round)` | `tool/call`、`tool/result`、`workflow and child session events during execution` | - | 固定的前台工作流会在每个 Round 启动一个全新的结构化子级；模型只能选择不可变目标和可选的 Round 上限。 |
| `@deepseek-ai/dsh-tool-skill` | `skill` | `ctx.tools`、`ctx.agents`、`ctx.skills` | `tool/call`、`tool/result`、`user/message replacement catalogs via agent.inject()` | - | - |
| `@deepseek-ai/dsh-tool-session-query` | `session_event_read`、`session_event_search`、`session_event_trace`、`session_search`、`session_trace` | `ctx.tools`、`ctx.systemPrompt`、`ctx.sessionQuery`、`a calling Agent for workspace authority` | `tool/call`、`tool/result` | - | 这 5 个只读工具会隐藏提供方游标，并根据不可变的调用 agent 会话为每个结果授权。该包需要选择启用；需要强制截止时间或限制行内输出的组合还会挂载通用超时或 spill 策略。 |
| `@deepseek-ai/dsh-tool-subagent` | `list_subagent_models`、`subagent` | `ctx.tools`、`ctx.subagents`、`ctx.systemPrompt`、`用于模型发现和所选路由校验的 ctx.llm` | `tool/call`、`tool/result`、`child session events through the chosen provider` | `subagent`、`subagent_fork` | 注册的委派工具名称取决于加载时 `toolName` 配置（默认为 `subagent`）；上述默认 schema 关闭模型选择，而发现 schema 则展示为已启用 Session 中可用的固定配套工具。Web preset 会在每个新顶层 Session 创建时读取插件页偏好，并为其子 Session 保留该决定；`subagent_fork` 始终使用固定路由。每个实例通过 `modelSelectionSettings`、`backgroundMode` 与 `enableRunInBackground` 独立控制是否读取模型选择设置及其后台行为。 |
| `@deepseek-ai/dsh-tool-subagent-control` | `interrupt_agent`、`list_agents`、`send_message` | `ctx.tools`、`ctx.subagents`、`ctx.agents and ctx.sessionProjections (list_agents only)` | `tool/call`、`tool/result`、`child session events through ctx.subagents` | - | 这些是控制可继续后台 subagent 的全局命名工具：绑定提供方的 `tool-subagent` 实例注册不同的委派工具；本包注册一次 `send_message` 和 `interrupt_agent`，另由 `list_agents` 通过单独加载的 `/list-agents` 插件提供，其目录行使用 sessionProjections 和实时 Agent 注册表。 |
| `@deepseek-ai/dsh-tool-subagent-report` | `report` | `ctx.subagents`、`ctx.systemPrompt`、`a live continuable in-process child Agent` | `tool/call`、`tool/result`、`a user-role message in the direct parent session` | - | 按可继续的进程内子级注册，而非全局注册，因此该 schema 仅在这种子级内部可见，并且不受其全局 `toolFilter` 影响。同一份贡献还会安装子级作用域的 `tool:report` 系统提示词 section，本目录不渲染该 section。面向父级的 `send_message` 工具单独安装。 |
| `@deepseek-ai/dsh-tool-jobs` | `job_kill`、`job_list`、`job_output` | `ctx.tools`、`ctx.jobs`、`ctx.systemPrompt` | `tool/call`、`tool/result`、`user/message via agent.inject() for background completion notices` | - | 与任务种类无关的后台任务控制器：后台 bash 命令、PTY 发送和 subagent 都通过相同的 3 个工具读取、列出和终止。加载该插件会挂接控制器，从而启用生产方的 `ctx.jobs.start()`。 |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | `interrupt_agent`、`list_agents`、`send_message`、`spawn_teammate`、`team_task_create`、`team_task_get`、`team_task_list`、`team_task_update`、`wait_agent` | `ctx.tools`、`ctx.systemPrompt`、`ctx.agentTeams`、`an exact live Team member Agent` | `tool/call`、`team/member`、`team/message/queued`、`team/message/delivered`、`team/task`、`tool/result` | - | 这 9 个工具限定于隐式 Team Lead 与持久 teammate 作用域。随产品发布的 dsh-base bundle 默认禁用该包；文档中的 Agent Teams profile patch 会启用它，并禁用旧 continuable child 的同名控制工具。 |
| `@deepseek-ai/dsh-tool-todo` | `todo_write` | `ctx.tools`、`owning Agent session` | `tool/call`、`todo/write`、`tool/result` | - | todo_write 是会话所有的状态；UI 将最新的 todo/write 事件渲染为检查清单。`allowParallelInProgress` 是没有默认值的必填项，因此本目录明确选择 `true`，对应描述允许同时存在多个 `in_progress` 项。选择 `false` 的部署会获得同一工具，但描述会要求只能有 1 个活动任务。 |
| `@deepseek-ai/dsh-tool-workflow` | `workflow` | `ctx.tools`、`ctx.workflowEngine`、`ctx.systemPrompt`、`a calling Agent (exec.agent parents the script children)` | `tool/call`、`tool/result` | - | - |
| `@deepseek-ai/dsh-tool-workspace-dependencies` | `load_workspace_dependencies` | `ctx.tools` | `tool/call`, `tool/result` | - | - |
| `@deepseek-ai/dsh-tool-web` | `web_fetch`、`web_search` | `ctx.tools`、`ctx.web`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | web_search 和 web_fetch 将提供方选择置于 ctx.web 之后，使模型可见 schema 在更换后端时保持稳定。 |
| `@deepseek-ai/dsh-tool-git` | `commit`、`commit_apply`、`review`、`worktree` | `ctx.tools`、`ctx.git`、`ctx.systemPrompt`、`ctx.subagents at call time for review` | `tool/call`、`tool/result` | - | 模型驱动的 git 提交＋评审：`commit` 分析已暂存 diff 并返回计划骨架与锁文件自动归位提示；`commit_apply` 校验并执行（hunk 感知拆分、依赖顺序、dry-run）；`review` 把已暂存 diff 分发给 subagent 评审者并聚合出 ship/reject 结论。 |
| `@deepseek-ai/dsh-tool-browser` | `browser` | `ctx.tools`、`ctx.browser`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | 浏览器工具（omp 移植）：open/close/run/state 覆盖 launch（stealth 补丁）、CloakBrowser patch（源码级 C++ 指纹，默认）、CDP-attach 或本地 relay＋扩展；观察为带 click-by-selector 的 ARIA ref 树，截图写 PNG 路径。 |
| `@deepseek-ai/dsh-tool-av` | `av_catalog`、`av_doctor`、`av_list`、`av_scan` | `ctx.tools`、`ctx.av`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | 只读 Automic Vault 工具：av_scan 审计 Mac 上暴露的开发工具凭据与风险，av_doctor 校验加固，av_catalog 列出检测器/加固器，av_list 仅返回已保存密钥的名称。输出绝不包含 Secret Value，加固始终由用户在终端人工决定。 |
| `@deepseek-ai/dsh-tool-logseq` | `logseq_graph`、`logseq_list`、`logseq_query`、`logseq_remove`、`logseq_search`、`logseq_server`、`logseq_show`、`logseq_upsert` | `ctx.tools`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | 图原生的 Logseq CLI 工具（logseq_list/show/search/query/upsert/remove/graph/server），从终端无头驱动 Logseq 数据库图——桌面 MCP 桥接的本地替代方案，补上 Datalog query、删除、一等任务与图生命周期。 |
| `@deepseek-ai/dsh-tool-codebase-memory` | `codebase_delete_project`、`codebase_detect_changes`、`codebase_get_architecture`、`codebase_get_code_snippet`、`codebase_get_graph_schema`、`codebase_index_repository`、`codebase_index_status`、`codebase_ingest_traces`、`codebase_list_projects`、`codebase_manage_adr`、`codebase_query_graph`、`codebase_search_code`、`codebase_search_graph`、`codebase_trace_path` | `ctx.tools`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | 代码智能工具（codebase_list_projects/index_repository/index_status/search_graph/query_graph/trace_path/get_code_snippet/get_graph_schema/get_architecture/search_code/detect_changes/manage_adr/ingest_traces/delete_project），通过 `codebase-memory-mcp cli --json` 模式对本地 codebase-memory daemon 发起一次性查询——stdio MCP 客户端行的本地替代方案，共享同一 daemon、索引、变更锁与索引 supervisor。 |
| `@deepseek-ai/dsh-tool-agentsview` | `agentsview` | `ctx.tools`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | 会话分析工具（agentsview action=list/get/sessionUsage/health/stats/usage/search/recallQuery/recallBrief/exportSessions），对本地 agentsview 存档发起一次性查询——健康等级与结局、窗口化工作区统计、token 成本报告、fts/语义/混合转录搜索、recall 简报与无内容导出——由 agentsview CLI 直接从 DeepSeek Harness 会话存储构建（它自己解析 session.jsonl.zstd），是让 tool-codebase-memory 得以成立的 CLI-first 模式。 |
| `@deepseek-ai/dsh-tool-openwiki` | `openwiki_begin`、`openwiki_finish`、`openwiki_next_page`、`openwiki_submit_page`、`openwiki_submit_plan` | `ctx.tools`、`ctx.systemPrompt` | `tool/call`、`tool/result` | - | 仓库 wiki 生命周期工具（openwiki_begin/submit_plan/next_page/submit_page/finish）在进程内运行移植的 openwiki 0.4 确定性引擎核心——可恢复的 .run.json 检查点、页面 manifest、带仓库证据解析的 Grounded Claims、OKF 前言修复与索引同步——无需外部 openwiki CLI，并与 codebase-memory 接通以做结构化发现。 |

<a id="deepseek-aidsh-plugin-manager"></a>


## `@deepseek-ai/dsh-plugin-manager`


### `plugin_manager`

列出当前 profile 中的插件或组合包，启用或禁用它们，安装组合包或移除已安装的组合包。每项操作都要求 danger-full-access 权限或本次调用的批准。批准不改变会话权限模式。变更影响该 profile 的所有会话。先列出条目以获取准确标识。包安装可能运行已获批准的构建脚本。支持热更新的 profile 立即应用变更；仅启动时加载的 profile 需要重启。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "Management operation.",
      "enum": [
        "list_plugins",
        "list_bundles",
        "set_plugin",
        "set_bundle",
        "install_bundle",
        "remove_bundle",
        "list_version_exemptions",
        "set_version_exemption"
      ]
    },
    "target": {
      "type": "string",
      "description": "Plugin entry id, bundle package name, or installation spec, according to action."
    },
    "enabled": {
      "type": "boolean",
      "description": "Required for set operations; defaults to true for installation. For set_version_exemption, true grants and false revokes."
    },
    "runtimeVersion": {
      "type": "string",
      "description": "For set_version_exemption: exact DSH version from list_version_exemptions. Target must be the manifest package-name@version, not an alias or version range."
    },
    "acceptRisk": {
      "type": "boolean",
      "description": "For granting an exemption: true only after warning the user about possible crashes and data loss and receiving explicit permission for this exact plugin/runtime pair. General installation permission is not enough."
    },
    "approvedBuilds": {
      "type": "array",
      "description": "For install_bundle: pass names from pendingBuilds only after the user explicitly approves running their install scripts in the conversation. This grants persistent permission for this profile.",
      "items": {
        "type": "string"
      }
    },
    "registry": {
      "type": "string",
      "description": "For install_bundle: the npm registry URL asked first, when the user names one; otherwise the configured registry is asked, and its configured fallbacks while a registry is unreachable."
    },
    "offset": {
      "type": "number",
      "description": "Zero-based list offset; defaults to 0."
    },
    "limit": {
      "type": "number",
      "description": "List page size, from 1 to 100; defaults to 25."
    }
  },
  "required": [
    "action"
  ]
}
```

来源： [`packages/boot/plugin-manager/src/tools.ts`](../packages/boot/plugin-manager/src/tools.ts)

<a id="deepseek-aidsh-mcp-resources"></a>


## `@deepseek-ai/dsh-mcp-resources`


### `list_mcp_resource_templates`

列出 MCP 服务器提供的参数化资源 URI 模板。

```json
{
  "type": "object",
  "properties": {
    "server": {
      "type": "string",
      "description": "Configured MCP server name."
    },
    "cursor": {
      "type": "string",
      "description": "Continuation cursor returned by this server."
    }
  },
  "required": [
    "server"
  ]
}
```

来源： [`packages/mcp/mcp-resources/src/tools.ts`](../packages/mcp/mcp-resources/src/tools.ts)


### `list_mcp_resources`

列出 MCP 服务器提供的资源。

```json
{
  "type": "object",
  "properties": {
    "server": {
      "type": "string",
      "description": "Configured MCP server name."
    },
    "cursor": {
      "type": "string",
      "description": "Continuation cursor returned by this server."
    }
  },
  "required": [
    "server"
  ]
}
```

来源： [`packages/mcp/mcp-resources/src/tools.ts`](../packages/mcp/mcp-resources/src/tools.ts)


### `read_mcp_resource`

按 URI 从指定服务器读取 MCP 资源。使用已列出的 URI 或展开后的资源模板。

```json
{
  "type": "object",
  "properties": {
    "server": {
      "type": "string",
      "description": "Configured MCP server name."
    },
    "uri": {
      "type": "string",
      "description": "Resource URI to read."
    }
  },
  "required": [
    "server",
    "uri"
  ]
}
```

来源： [`packages/mcp/mcp-resources/src/tools.ts`](../packages/mcp/mcp-resources/src/tools.ts)

<a id="deepseek-aidsh-experimental-browser-use-stagehand-native"></a>


## `@deepseek-ai/dsh-experimental-browser-use-stagehand-native`


### `stagehand_act`

使用配置的 Stagehand 模型执行一次自然语言浏览器操作。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pageId": {
      "type": "string",
      "minLength": 1
    },
    "instruction": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "instruction"
  ],
  "additionalProperties": false
}
```

来源：[`packages/experimental/browser-use-stagehand-native/src/index.ts`](../packages/experimental/browser-use-stagehand-native/src/index.ts)


### `stagehand_extract`

使用配置的 Stagehand 模型与可选的 JSON Schema 提取页面数据。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pageId": {
      "type": "string",
      "minLength": 1
    },
    "instruction": {
      "type": "string",
      "minLength": 1
    },
    "schema": {
      "type": "object",
      "propertyNames": {
        "type": "string"
      },
      "additionalProperties": {
        "$ref": "#/$defs/__schema0"
      }
    }
  },
  "required": [
    "instruction"
  ],
  "additionalProperties": false,
  "$defs": {
    "__schema0": {
      "anyOf": [
        {
          "type": "string"
        },
        {
          "type": "number"
        },
        {
          "type": "boolean"
        },
        {
          "type": "null"
        },
        {
          "type": "array",
          "items": {
            "$ref": "#/$defs/__schema0"
          }
        },
        {
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {
            "$ref": "#/$defs/__schema0"
          }
        }
      ]
    }
  }
}
```

来源：[`packages/experimental/browser-use-stagehand-native/src/index.ts`](../packages/experimental/browser-use-stagehand-native/src/index.ts)


### `stagehand_navigate`

将 Stagehand 浏览器标签页导航至指定 URL。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pageId": {
      "type": "string",
      "minLength": 1
    },
    "url": {
      "type": "string",
      "format": "uri"
    }
  },
  "required": [
    "url"
  ],
  "additionalProperties": false
}
```

来源：[`packages/experimental/browser-use-stagehand-native/src/index.ts`](../packages/experimental/browser-use-stagehand-native/src/index.ts)


### `stagehand_observe`

使用配置的 Stagehand 模型查找符合指令的浏览器操作。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pageId": {
      "type": "string",
      "minLength": 1
    },
    "instruction": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "instruction"
  ],
  "additionalProperties": false
}
```

来源：[`packages/experimental/browser-use-stagehand-native/src/index.ts`](../packages/experimental/browser-use-stagehand-native/src/index.ts)


### `stagehand_screenshot`

截取 Stagehand 标签页图像以供视觉检查。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "pageId": {
      "type": "string",
      "minLength": 1
    },
    "fullPage": {
      "default": false,
      "type": "boolean"
    }
  },
  "required": [
    "fullPage"
  ],
  "additionalProperties": false
}
```

来源：[`packages/experimental/browser-use-stagehand-native/src/index.ts`](../packages/experimental/browser-use-stagehand-native/src/index.ts)


### `stagehand_tabs`

列出、创建、选择或关闭 Stagehand 浏览器标签页。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "oneOf": [
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "const": "list"
        }
      },
      "required": [
        "action"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "const": "new"
        },
        "url": {
          "type": "string",
          "format": "uri"
        }
      },
      "required": [
        "action"
      ],
      "additionalProperties": false
    },
    {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "select",
            "close"
          ]
        },
        "pageId": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "action",
        "pageId"
      ],
      "additionalProperties": false
    }
  ],
  "type": "object"
}
```

来源：[`packages/experimental/browser-use-stagehand-native/src/index.ts`](../packages/experimental/browser-use-stagehand-native/src/index.ts)

<a id="deepseek-aidsh-tool-ask-user"></a>


## `@deepseek-ai/dsh-tool-ask-user`


### `ask_user_question`

继续操作前，如果需要确认、选择或缺失的信息，请向用户提出简明问题。发送一个或多个问题，每个问题都带一个稳定 id，该 id 会在答案中原样返回。

```json
{
  "type": "object",
  "properties": {
    "questions": {
      "type": "array",
      "description": "Questions to ask the user before continuing.",
      "items": {
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "id": {
            "type": "string",
            "description": "Stable id for this question; echoed in the answer."
          },
          "question": {
            "type": "string",
            "description": "The specific question to ask the user."
          },
          "header": {
            "type": "string",
            "description": "Optional short heading for the question, such as \"Confirm\" or \"Choose Mode\"."
          },
          "options": {
            "type": "array",
            "description": "Optional choices to show the user. If you recommend one, put it first and append \"(Recommended)\" to that label.",
            "items": {
              "type": "object",
              "additionalProperties": true,
              "properties": {
                "label": {
                  "type": "string",
                  "description": "Short user-facing option label."
                },
                "description": {
                  "type": "string",
                  "description": "One sentence explaining the tradeoff or impact."
                }
              },
              "required": [
                "label"
              ]
            }
          },
          "multi_select": {
            "type": "boolean",
            "description": "Whether the user may select more than one option. Defaults to false."
          }
        },
        "required": [
          "id",
          "question"
        ]
      }
    }
  },
  "required": [
    "questions"
  ]
}
```

来源：[`packages/interaction/tool-ask-user/src/index.ts`](../packages/interaction/tool-ask-user/src/index.ts)

ask_user_question 会暂停工具调用，直到当前 UI 提供方返回人类答案。

<a id="deepseek-aidsh-tools"></a>


## `@deepseek-ai/dsh-tools`


### `run_code`

针对可用工具执行 TypeScript 程序。接受两个必填参数：`code`，即异步函数的**函数体**（仅使用可擦除语法；支持顶层 `await` 和 `return`）；以及 `description`，简要说明该程序做什么。请根据系统提示词中的声明，以 `await tools.name(args)` 形式调用工具。只有打印或返回的内容属于程序输出，请谨慎筛选。含图片的子工具结果会在运行结束后附加。

```json
{
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "description": "The program: the body of an async TypeScript function."
    },
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: \"Count TODO markers across packages\"; \"Read failing test and its fixture\"; \"Rename config key in every cordis.yml\"."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Positive elapsed-time budget in milliseconds, capped by the deployment maximum."
    },
    "sandbox_permissions": {
      "type": "string",
      "description": "Wider sandbox mode for this complete program execution; requires justification and approval.",
      "enum": [
        "workspace-write",
        "danger-full-access"
      ]
    },
    "justification": {
      "type": "string",
      "description": "Reason this complete program needs wider access, shown to the user for approval. Use the language of the user’s current request."
    },
    "session": {
      "type": "string",
      "description": "Optional persistent-kernel session id: runs sharing a session id keep kernel state (assignments, imports, top-level await results) across calls when the mounted backend supports persistence; one-shot backends ignore it entirely."
    },
    "reset": {
      "type": "boolean",
      "description": "Discard the session's prior kernel state (variables, imports) before this run. Costs one reset instead of many retries; requires `session` to be meaningful."
    }
  },
  "required": [
    "code",
    "description"
  ]
}
```

来源：[`packages/core/tools/src/ptc.ts`](../packages/core/tools/src/ptc.ts)

在 `mode: ptc`／`mode: both` 下，它由工具注册表所有，作为可过滤能力层之外的保留传输机制（参见 PTC mode Agent Note）。在 `ptc` 下，它是注册表对协议格式的唯一贡献；其他可见能力在使用已加载运行时语言生成的 SDK 章节中声明。程序通过 binding 调用这些能力，调用按照原生并发约定调度：启动顺序和策略遵循提交顺序，并发安全的函数体最多重叠执行 `maxParallelSubCalls` 个。调用会重新进入完整且受守卫保护的工具流水线，并将每个嵌套执行关联到此外层结果。

<a id="deepseek-aidsh-plan-mode"></a>


## `@deepseek-ai/dsh-plan-mode`


### `exit_plan_mode`

仅在规划模式下使用。提交计划供用户评审，并在获批后退出规划模式。发送**完整的** Markdown 计划，以一个为计划命名的 # 标题开头。用户可以批准（从你的下一步骤起执行计划），也可以要求继续规划；其反馈会通过工具结果返回，请修改后再次提交。

```json
{
  "type": "object",
  "properties": {
    "plan": {
      "type": "string",
      "description": "The complete plan, as markdown, starting with a # heading that names it."
    }
  },
  "required": [
    "plan"
  ]
}
```

来源：[`packages/plan/plan-mode/src/index.ts`](../packages/plan/plan-mode/src/index.ts)

规划未激活时，exit_plan_mode 仍保留在面向模型的 schema 中，这样状态转换不会在规划策略变更之外额外造成工具目录变动。其执行路径会拒绝规划模式之外的调用；在规划模式下，它通过用户交互 seam 提交计划（批准／根据反馈继续规划），批准后会在步骤边界记录规划模式已停用。

<a id="deepseek-aidsh-tool-bash"></a>


## `@deepseek-ai/dsh-tool-bash`


### `bash`

执行 bash 命令（`bash -c`）并返回 stdout/stderr。每次调用都在新 shell 中运行：调用之间不保留任何状态（cwd、变量、函数），请传入 `workdir`，不要使用 `cd`。非零退出会报告为 `[exit code: N]`。当前 harness 环境信息通过托管的 `$DSH_*` 变量公开，需要时请检查这些变量。命令可能在文件沙箱中运行；被阻止的文件操作报告为 `[sandbox: file access denied under <mode> mode]`，这是策略拒绝，而不是命令缺陷，请勿换一种方式重试。较长的输出会截断，只保留尾部；如可用，完整输出会保存到文件并报告其路径。对于长时间运行的命令，请设置 `run_in_background: true`：调用会立即返回 job id；使用 `job_output` 读取输出，使用 `job_kill` 停止任务。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The bash command to execute."
    },
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" → \"List files in current directory\"; \"git status\" → \"Show working tree status\"; \"npm install\" → \"Install package dependencies\"."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed."
    },
    "workdir": {
      "type": "string",
      "description": "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies."
    }
  },
  "required": [
    "command",
    "description"
  ]
}
```

来源：[`packages/shell/tool-bash/src/index.ts`](../packages/shell/tool-bash/src/index.ts)

bash 工具是 bash 执行器 seam 面向模型的消费方。使用 `run_in_background` 的运行会注册到通用 `ctx.jobs` 运行时，并通过 `job_*` 工具（来自 `@deepseek-ai/dsh-tool-jobs`）收集／停止；禁用 `enableRunInBackground` 配置（默认为 true）后，该参数会被完全移除。

<a id="deepseek-aidsh-tool-pwsh"></a>




## `@deepseek-ai/dsh-tool-present`


### `present`

将 Session 文件系统中已存在的文件声明为最终交付物。当你创建或更新的文件是用户要求接收的输出时，必须在写入之后、最终回复之前调用 present——包括通过 Bash 或代码执行创建的文件。仅在回复中提及路径不能替代此调用。文件必须已经存在。用户打开的是当前源文件；其内容不会被复制或保留。

```json
{
  "type": "object",
  "properties": {
    "files": {
      "type": "array",
      "description": "Usually the 1-2 most important deliverables; at most 4 per call.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "path": {
            "type": "string",
            "description": "Path of an existing regular file. Relative paths use the Session working directory."
          },
          "description": {
            "type": "string",
            "description": "Brief description for the user."
          }
        },
        "required": [
          "path"
        ]
      }
    }
  },
  "required": [
    "files"
  ]
}
```

来源： [`packages/deliverables/tool-present/src/index.ts`](../packages/deliverables/tool-present/src/index.ts)

交付物归属于调用它的 Session；Web ui-deliverables 提供源文件打开与卡片展示。

<a id="deepseek-aidsh-tool-pwsh"></a>

## `@deepseek-ai/dsh-tool-pwsh`


### `pwsh`

执行 PowerShell 命令（`pwsh -Command`）并返回 stdout/stderr。每次调用都在新的 pwsh 进程中运行：调用之间不保留任何状态（cwd、变量、函数），请传入 `workdir`，不要使用 `cd`。路径采用 Windows 原生形式（`C:\...`）；使用 `$env:NAME` 读取环境变量。非零退出会报告为 `[exit code: N]`。当前 harness 环境信息通过托管的 `$env:DSH_*` 变量公开，需要时请检查这些变量。命令可能在文件沙箱中运行；被阻止的文件操作报告为 `[sandbox: file access denied under <mode> mode]`，这是策略拒绝，而不是命令缺陷，请勿换一种方式重试。较长的输出会截断，只保留尾部；如可用，完整输出会保存到文件并报告其路径。在 Windows 上，被强制终止的命令会以 `[exit code: 1]` 结算且不带信号标记，请将其视为中断，而不是命令失败。对于长时间运行的命令，请设置 `run_in_background: true`：调用会立即返回 job id；使用 `job_output` 读取输出，使用 `job_kill` 停止任务。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The PowerShell command to execute."
    },
    "description": {
      "type": "string",
      "description": "Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: \"ls\" → \"List files in current directory\"; \"git status\" → \"Show working tree status\"; \"Get-Process\" → \"List running processes\"."
    },
    "timeoutMs": {
      "type": "number",
      "description": "Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed."
    },
    "workdir": {
      "type": "string",
      "description": "Working directory for this command. Defaults to the session workspace; a relative path is resolved against it."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies."
    }
  },
  "required": [
    "command",
    "description"
  ]
}
```

来源：[`packages/shell/tool-pwsh/src/index.ts`](../packages/shell/tool-pwsh/src/index.ts)

pwsh 工具是 Windows 组合中 bash 执行器 seam 的 PowerShell 方言消费方（由 `@deepseek-ai/dsh-pwsh-local` 等 PowerShell 执行器为 `ctx.shell` 提供后端）；除沙箱接口外，它逐项对应 bash 工具调用。使用 `run_in_background` 的运行会注册到通用 `ctx.jobs` 运行时，并通过 `job_*` 工具收集／停止；托管的 `DSH_*` 环境来自 `@deepseek-ai/dsh-shell-env`。每次调用都在新进程中运行，不使用持久 PTY 会话。路径采用原生 `C:\...` 形式，变量采用 `$env:NAME`。

<a id="deepseek-aidsh-tool-cordis"></a>


## `@deepseek-ai/dsh-tool-cordis`


### `cordis_inspect_list`

列出 Host 当前已知的所有 Cordis Inspect Provider，包括本地 Host Provider 和 Client 同步的最新清单。每项包含平台、用途、只读方法以及输入输出 schema。编写或配置插件前先调用本工具，再从结果选择 cordis_inspect_query 的 provider 和方法。不要猜测名称，也不要把 Inspect 方法当作插件代码可调用的业务 Service。

```json
{
  "type": "object",
  "properties": {}
}
```

来源： [`packages/extensions/tool-cordis/src/index.ts`](../packages/extensions/tool-cordis/src/index.ts)


### `cordis_inspect_query`

执行 Inspect Provider 明确声明的只读查询。platform、provider 和 method 必须来自 cordis_inspect_list，input 必须符合该方法的 schema。编写插件代码前，用本工具读取准确的 Service 方法、Event 模式、Builtin 签名、Tool schema、主题 token，或实时 Slot 树与 props。Host 查询在本地运行。Client 查询等待页面首个有效响应，直到页面回应或工具取消。本工具不能调用业务 Service 方法或修改运行时。对于 Service.listService 和 Event.listEvents，不传 input 可浏览精简签名目录，再查询准确服务或事件以获得完整约定及引用类型。对于 Slots.listSubTree，不传 root 可浏览精简树；查询准确的 Slot root 可获得完整注册约定和 props，而查询准确的 Factory root 只返回 identity、scope 与 registrant。

```json
{
  "type": "object",
  "properties": {
    "platform": {
      "type": "string",
      "description": "Runtime platform that owns the Provider.",
      "enum": [
        "host",
        "client"
      ]
    },
    "provider": {
      "type": "string",
      "description": "Exact Provider ID returned by cordis_inspect_list."
    },
    "method": {
      "type": "string",
      "description": "Exact method name declared by the Provider manifest."
    },
    "input": {
      "description": "Optional query input; it must satisfy the method input schema."
    }
  },
  "required": [
    "platform",
    "provider",
    "method"
  ]
}
```

来源： [`packages/extensions/tool-cordis/src/index.ts`](../packages/extensions/tool-cordis/src/index.ts)

创造模式提供两个只读运行时检查工具。Cordis host runner 提供检查注册表；Client 查询需要已连接页面。持久化变更编写为组合包，再通过 plugin_manager 安装。

<a id="deepseek-aidsh-tool-bash-persistent"></a>


## `@deepseek-ai/dsh-tool-bash-persistent`


### `bash`

在持久 bash shell 中运行命令。包括当前目录和已导出环境变量在内的状态会在此 agent 的多次调用之间保留。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The bash command to run. Relative path is preferred in the command."
    }
  },
  "required": [
    "command"
  ]
}
```

来源：[`packages/shell/tool-bash-persistent/src/index.ts`](../packages/shell/tool-bash-persistent/src/index.ts)

一个按所有者隔离的持久 bash 工具；部署组合提供 PTY 后端，并可覆盖面向模型的环境描述。

<a id="deepseek-aidsh-tool-pwsh-persistent"></a>


## `@deepseek-ai/dsh-tool-edit`


### `edit`

单文件编辑工具。模式由配置固定，而非每次调用指定；合适的参数形态见 &lt;parameters&gt;。

"hashline" 模式（默认）——基于行的锚定 patch 语言。&lt;guidance&gt;
Section: [PATH#TAG]; TAG: 最新 read/search 的 4 位十六进制快照，每个 section 必填。
HEADER FORMS:
- PUT N.=M: — 用主体行（body rows）替换原始第 N–M 行（含）
- PUT N*: — 替换以 N 开始的语法块（自动解析结束行）
- PUT &lt;N: — 在第 N 行之前插入主体行（PUT &lt;1: = 文件头）
- PUT >N: — 在第 N 行之后插入主体行（PUT >$: = 文件尾）
- CUT N.=M / CUT N* — 删除并捕获若干行／块；可选 @name 寄存器
- REM — 删除 section 文件；MV DEST — 移动／重命名 section 文件
- 主体行只能位于 `:` 头之下；行是逐字的 +TEXT（保留前导空白）。
  字面量开头的短横／加号：`- item` → `+- item`；`+ item` → `++ item`。
- 数字始终是原始的，绝不被变更块移动。每次编辑重新编号并改变 #TAG。
- 只触碰已显示的行；未显示的变更块被拒绝。省略（…、..、折叠的 N-M: 行）不可见。
- 范围：只包含变更的行；绝不为保守行加宽。分开的变更 → 分开的变更块。
- 绝不要用此工具格式化／重排版；请运行项目格式化器。
完整的提示指引位于该包的 hashline 提示中（此处不重复）。
&lt;/guidance&gt;

"replace" 模式——带模糊空白匹配的字面量字符串替换。必须使用能唯一标识变更的最小的 old_string。非唯一的 old_string 必须补充上下文，或对全部出现使用 replace_all: true。跨文件重命名字符串 → replace_all: true。

"patch" 模式——应用 diff 变更块。变更块头：当上下文行唯一时为裸 `@@`，否则为从文件逐字复制的 `@@ $ANCHOR`。每个变更块主体只能包含以 ' ' | '+' | '-' 开头的行，且至少有一处变更（+ 或 −）。使用足够的 ` ` 前缀上下文行使匹配唯一（通常 2–8）。在编辑结构化代码块时，包含其开头与结尾行，使编辑保持在块内。绝不要用行号作为锚点。若某次 patch 失败，请重新读取文件并生成全新的 patch——绝不要重试同一 diff。

"apply_patch" 模式——Codex 风格信封：
*** Begin Patch
*** Add File: &lt;path&gt;
+&lt;initial contents lines&gt;
*** Update File: &lt;path&gt; [*** Move to: &lt;new path&gt;]
@@ &lt;optional anchor/class/function&gt;
- &lt;old line&gt;
+ &lt;new line&gt;
  &lt;context line&gt;
*** Delete File: &lt;path&gt;
*** End Patch
文件引用相对，绝不绝对。新建文件的行必须以 `+` 开头。

&lt;parameters&gt;
replace mode: { path: string, old_string: string, new_string: string, replace_all?: boolean }
patch mode:   { path: string, edits: Array<{ op: "create"|"delete"|"update", rename?: string, diff?: string }> }
apply_patch / hashline mode: { input: string }
&lt;/parameters&gt;

&lt;critical&gt;如有可能，先读取目标文件：read 工具会返回当前 [path#tag] 头部及行号，hashline 锚点正是基于该标记内容校验的。缺失或过期的标签会被拒绝——请重读以获取新的头部，切勿臆造或复用旧标签。执行器自身的读取同样满足本会话的 fs-observation-policy，因此只要观察到的内容与锚点一致，一次调用即可落地编辑。&lt;/critical&gt;

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "the file path (relative to the working directory)"
    },
    "file_path": {
      "type": "string",
      "description": "Alias for `path`; prefer `path`."
    },
    "filePath": {
      "type": "string",
      "description": "Alias for `path`; prefer `path`."
    },
    "old_string": {
      "type": "string",
      "description": "the exact existing text to replace (fuzzy whitespace matching when fuzzyMatch is enabled)"
    },
    "new_string": {
      "type": "string",
      "description": "the replacement text"
    },
    "replace_all": {
      "type": "boolean",
      "description": "when true, replaces every occurrence."
    },
    "edits": {
      "type": "array",
      "description": "list of edit entries: { op: \"create\"|\"delete\"|\"update\", rename?: string, diff?: string }"
    },
    "input": {
      "type": "string",
      "description": "a full *** Begin Patch ... *** End Patch envelope. a hashline patch document ([path#tag] sections)"
    }
  }
}
```

来源：[`packages/edit/tool-edit/src/index.ts`](../packages/edit/tool-edit/src/index.ts)

四种模式的 `edit`（replace / patch / apply_patch / hashline）移植自 @oh-my-pi。与 tool-fs 同时挂载时应设置 `enableEdit: false`，让富编辑工具独享 `edit` 名称。

<a id="deepseek-aidsh-tool-fs"></a>

## `@deepseek-ai/dsh-tool-pwsh-persistent`


### `pwsh`

在持久 PowerShell shell 中运行命令。包括当前目录和已导出环境变量在内的状态会在此 agent 的多次调用之间保留。

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The PowerShell command to run. Relative path is preferred in the command."
    }
  },
  "required": [
    "command"
  ]
}
```

来源：[`packages/shell/tool-pwsh-persistent/src/index.ts`](../packages/shell/tool-pwsh-persistent/src/index.ts)

一个按所有者隔离的持久 pwsh 工具，持久 bash 工具的 Windows 对应物；部署组合提供 pwsh 方言的 PTY 后端，并可覆盖面向模型的环境描述。




## `@deepseek-ai/dsh-tool-str-replace-editor`


### `str_replace_editor`

用于查看、创建与编辑文件的自定义编辑工具。
* 状态在多次命令调用以及和用户的讨论之间保持不变
* 如果 `path` 是文件，`view` 显示应用 `cat -n` 后的结果。如果 `path` 是目录，`view` 最多列出两层深的非隐藏文件与目录
* 如果指定的 `path` 已经作为文件存在，则不能使用 `create` 命令
* 如果某个 `command` 产生较长的输出，它会被截断并标记 `<response clipped>`
* 未被所选命令使用的参数的 null 占位符视为省略。必填参数仍需要值；删除匹配项时应省略 `str_replace.new_str` 而不是将其置为 null

使用 `str_replace` 命令的注意事项：
* `old_str` 参数应精确匹配原文件中一个或多个连续行。注意空白！
* 如果 `old_str` 参数在文件中不唯一，替换不会执行。请确保 `old_str` 中包含足够的上下文使其唯一
* `new_str` 参数应包含替换 `old_str` 的编辑后行

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
      "enum": [
        "view",
        "create",
        "str_replace",
        "insert"
      ]
    },
    "path": {
      "type": "string",
      "description": "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`."
    },
    "file_text": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "description": "Required string parameter of `create` command, with the content of the file to be created. A null placeholder is treated as omitted by commands that do not use this parameter."
    },
    "insert_line": {
      "oneOf": [
        {
          "type": "integer"
        },
        {
          "type": "null"
        }
      ],
      "description": "Required integer parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`. A null placeholder is treated as omitted by commands that do not use this parameter."
    },
    "new_str": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "description": "Optional string parameter of `str_replace` command containing the new string (if omitted, no string will be added). Required string parameter of `insert` command containing the string to insert. A null placeholder is accepted only by commands that do not use this parameter."
    },
    "old_str": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "null"
        }
      ],
      "description": "Required string parameter of `str_replace` command containing the string in `path` to replace. A null placeholder is treated as omitted by commands that do not use this parameter."
    },
    "view_range": {
      "oneOf": [
        {
          "type": "array",
          "items": {
            "type": "integer"
          }
        },
        {
          "type": "null"
        }
      ],
      "description": "Optional parameter of `view` command when `path` points to a file. If omitted or null, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file."
    }
  },
  "required": [
    "command",
    "path"
  ]
}
```

Source: [`packages/fs/tool-str-replace-editor/src/index.ts`](../packages/fs/tool-str-replace-editor/src/index.ts)

独立于文件系统接缝的查看／创建／唯一字面替换／行插入工具；可与任何 Shell 或终端 API 组合使用。

## `@deepseek-ai/dsh-tool-fs`


### `edit`

通过替换字面量文本来编辑现有 UTF-8 文本文件。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to edit, resolved by the filesystem backend."
    },
    "old_string": {
      "type": "string",
      "description": "Literal text to replace."
    },
    "new_string": {
      "type": "string",
      "description": "Literal replacement text. Use an empty string to delete the match."
    },
    "replace_all": {
      "type": "boolean",
      "description": "Replace all matches. Defaults to false; when false, old_string must appear exactly once."
    }
  },
  "required": [
    "file_path",
    "old_string",
    "new_string"
  ]
}
```

来源：[`packages/fs/tool-fs/src/index.ts`](../packages/fs/tool-fs/src/index.ts)


### `read`

读取 UTF-8 文本文件，并返回带行号的内容。归档路径（foo.zip、foo.zip:dir、foo.zip:dir/file）通过内置多格式引擎列出归档或读取成员文本。Zstd 路径（foo.zst、foo.zstd、session.jsonl.zstd）通过同样的带行号窗口提供其解码后的纯文本/JSONL。对完整的小型 UTF-8 文件，读取会在内容前加一行 hashline 锚头（[path#TAG]）——请逐字复制该标签到 edit 工具的 hashline 段，使编辑精确锚定在你看到的内容上。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to read, resolved by the filesystem backend."
    },
    "offset": {
      "type": "number",
      "description": "1-based first line to return. Defaults to 1."
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of lines to return. Defaults to 2000."
    }
  },
  "required": [
    "file_path"
  ]
}
```

来源：[`packages/fs/tool-fs/src/index.ts`](../packages/fs/tool-fs/src/index.ts)


### `read_image`

读取 PNG/JPEG/WebP/GIF 文件并返回图像本身。无扩展名的路径同样被接受；格式按文件内容检测，因此规范化附件路径可以直接传入，无需复制或重命名。Harness 会在下一次模型请求前校验并缩小受支持的大图，因此仅为查看图片时应直接使用此工具，无需安装图片库或创建缩略图。可以用小批次并发读取彼此独立的文件。要求当前模型接受图像输入。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to the image file, resolved by the filesystem backend."
    }
  },
  "required": [
    "file_path"
  ]
}
```

来源：[`packages/fs/tool-fs/src/index.ts`](../packages/fs/tool-fs/src/index.ts)


### `write`

创建或完全替换 UTF-8 文本文件。

```json
{
  "type": "object",
  "properties": {
    "file_path": {
      "type": "string",
      "description": "Path to write, resolved by the filesystem backend."
    },
    "content": {
      "type": "string",
      "description": "Full UTF-8 text content to write."
    }
  },
  "required": [
    "file_path",
    "content"
  ]
}
```

来源：[`packages/fs/tool-fs/src/index.ts`](../packages/fs/tool-fs/src/index.ts)

先读后写／编辑策略由 `@deepseek-ai/dsh-fs-observation-policy` 添加；它是一个 `fs/*` 事件门禁插件，不会改变 schema。加载这些工具的部署按预期也应加载该插件。没有 `ctx.attachments` 时图像工具不会注册；其 schema 与路由无关，执行时除非确切路由的模型声明图像输入，否则拒绝。

<a id="deepseek-aidsh-tool-fs-search"></a>



## `@deepseek-ai/dsh-tool-graph`


### `update_agent_graph`

```json
{
  "type": "object",
  "properties": {
    "graphId": {
      "type": "string",
      "description": "The agent graph id to update."
    },
    "operation": {
      "type": "string",
      "description": "Explicit operation discriminator; unrelated provider-filled payloads are ignored.",
      "enum": [
        "add_work",
        "stop",
        "finish"
      ]
    },
    "addWork": {
      "type": "array",
      "description": "Schedule work (up to 32 items).",
      "items": {
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "targetKind": {
            "type": "string",
            "description": "Explicit target discriminator; unrelated identity fields are ignored.",
            "enum": [
              "new_agent",
              "new_preset",
              "existing_operator"
            ]
          },
          "agentId": {
            "type": "string",
            "description": "Legacy built-in agent id for new graph work."
          },
          "subagentId": {
            "type": "string",
            "description": "User-approved subagent preset id for new graph work."
          },
          "operatorId": {
            "type": "string",
            "description": "Runtime id of an EXISTING graph operator."
          },
          "instruction": {
            "type": "string"
          },
          "inputIds": {
            "type": "array",
            "description": "Durable record ids forming this work item input frontier.",
            "items": {
              "type": "string"
            }
          },
          "selectedResultInputs": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "sourceGraphId": {
                  "type": "string"
                },
                "resultId": {
                  "type": "string"
                }
              },
              "required": [
                "sourceGraphId",
                "resultId"
              ]
            }
          },
          "replaces": {
            "type": "string",
            "description": "Existing work superseded by this work item."
          },
          "replacementMode": {
            "type": "string",
            "description": "none drops a provider-filled replaces.",
            "enum": [
              "none",
              "replace"
            ]
          },
          "workId": {
            "type": "string",
            "description": "Optional explicit work id (normally derived deterministically)."
          }
        },
        "required": [
          "instruction"
        ]
      }
    },
    "stop": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "targetId": {
            "type": "string"
          },
          "reason": {
            "type": "string"
          }
        },
        "required": [
          "targetId",
          "reason"
        ]
      }
    },
    "finish": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "resultIds": {
          "type": "array",
          "description": "Committed graph record ids selected as the final result.",
          "items": {
            "type": "string"
          }
        },
        "reason": {
          "type": "string"
        }
      },
      "required": [
        "reason"
      ]
    },
    "idempotencyKey": {
      "type": "string",
      "description": "Stable key folded into the source triple: a retried identical update with the same key is not re-committed."
    }
  },
  "required": [
    "graphId"
  ]
}
```

Source: [`packages/graph/tool-graph/src/index.ts`](../packages/graph/tool-graph/src/index.ts)


### `view_agent_graph`

```json
{
  "type": "object",
  "properties": {
    "graphId": {
      "type": "string",
      "description": "The agent graph id to inspect."
    },
    "cursor": {
      "type": "string",
      "description": "Opaque page cursor from a previous view (omit for the latest view)."
    }
  },
  "required": [
    "graphId"
  ]
}
```

Source: [`packages/graph/tool-graph/src/index.ts`](../packages/graph/tool-graph/src/index.ts)


### `yield_agent_graph`

```json
{
  "type": "object",
  "properties": {
    "graphId": {
      "type": "string",
      "description": "The agent graph id to yield for."
    },
    "reason": {
      "type": "string",
      "description": "Why the supervisor has no immediate decision until the graph changes."
    }
  },
  "required": [
    "graphId"
  ]
}
```

Source: [`packages/graph/tool-graph/src/index.ts`](../packages/graph/tool-graph/src/index.ts)

## `@deepseek-ai/dsh-tool-fs-search`


### `glob`

查找路径匹配 glob 模式的文件。只返回匹配的文件路径，绝不返回目录；包括隐藏文件和被忽略的文件，但排除 VCS 元数据目录。最多按修改时间顺序返回 100 条路径；如果结果更多，则改为返回从顶层条目中抽样的 100 条路径，说明已抽样，并报告完整排序列表的保存位置。该工具不枚举目录条目。

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Glob pattern to match file paths against (e.g. \"**/*.ts\", \"src/**/*.test.js\"). A pattern with no \"/\" matches the basename at any depth, so \"*\" and \"*.ts\" both search the whole tree; include a separator to anchor the depth."
    },
    "path": {
      "type": "string",
      "description": "Directory to search in. Defaults to the session workspace; a relative path resolves against it."
    }
  },
  "required": [
    "pattern"
  ]
}
```

来源：[`packages/fs/tool-fs-search/src/index.ts`](../packages/fs/tool-fs-search/src/index.ts)


### `grep`

使用 ripgrep 正则表达式搜索文件内容。返回带行号的匹配行，按文件分组，并优先排列 git 修改过的文件。前 50 条匹配会直接返回；结果达到上限时会返回延续 `cursor`——原样传回（相同的 pattern/path/include）以获取下一页，或按 spill locator 读取完整结果。如需周边上下文，请对匹配的文件使用 read。

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Regular expression to search for (ripgrep syntax)."
    },
    "path": {
      "type": "string",
      "description": "File, directory, or internal URL (e.g. conflict://3, pr://owner/repo/123/diff) to search. Defaults to the session workspace; a relative path resolves against it."
    },
    "include": {
      "type": "string",
      "description": "One glob filter for which files to search (e.g. \"*.ts\", \"*.{js,jsx}\"). Not a list; negation is not supported."
    },
    "cursor": {
      "type": "string",
      "description": "Opaque continuation token returned by a capped previous result. Pass it back unchanged with the same pattern, path, and include to fetch the next page."
    }
  },
  "required": [
    "pattern"
  ]
}
```

来源：[`packages/fs/tool-fs-search/src/index.ts`](../packages/fs/tool-fs-search/src/index.ts)

glob 和 grep 是无条件可用的发现工具，通过 ctx.subprocess spawn 随包提供的 ripgrep 二进制文件（`@vscode/ripgrep`），并作为普通前台调用运行，绝不作为后台任务；无需在宿主机安装 `rg`，也不经过 shell 层。本目录使用 `sampleOverCapGlobResults: true`；部署必须显式选择该行为。结果超过上限时，会通过可选的 ctx.spillStore 后端保存完整的格式化列表；在共置部署中，如果后端公开本地路径，返回的定位信息可供后续读取／搜索。另外，grep 的每次调用会做一次 `git status` 探测；在 git 仓库中，被修改文件会排到最前并用 ` [M in git]` 标注，非仓库工作目录则静默跳过。

<a id="deepseek-aidsh-tool-terminal"></a>


## `@deepseek-ai/dsh-tool-ast`


### `ast_edit`

按 AST 模式在结构上重写源文件。默认情况下只**预览**建议的变更块，不写入任何内容；设置 apply: true 才写入文件。支持 ast-grep 模式语法：`$NAME` 捕获一个可在重写中以 `$NAME` 引用的节点。每个匹配的节点都会被重写；不存在交互式选择。

```json
{
  "type": "object",
  "properties": {
    "pat": {
      "type": "string",
      "description": "AST pattern to match, in ast-grep syntax. Must be non-empty."
    },
    "rewrite": {
      "type": "string",
      "description": "Replacement template. Captured metavariables from pat substitute here (e.g. `$NAME`). Empty rewrite deletes the matched node."
    },
    "path": {
      "type": "string",
      "description": "File or directory to search (or several roots separated by \";\"). Defaults to the session workspace; a relative path resolves against it."
    },
    "include": {
      "type": "string",
      "description": "One glob filter for which files to rewrite (e.g. \"*.ts\", \"*.{js,jsx}\"). Not a list; negation is not supported."
    },
    "lang": {
      "type": "string",
      "description": "Force the language for pattern + targets (e.g. \"Python\", \"Rust\", \"TypeScript\"). Normally inferred from file extensions."
    },
    "strictness": {
      "type": "string",
      "description": "How strictly the pattern node kinds must match. \"smart\" is the default; \"ast\" ignores comments and trivia.",
      "enum": [
        "cst",
        "smart",
        "ast",
        "relaxed",
        "signature",
        "template"
      ]
    },
    "apply": {
      "type": "boolean",
      "description": "true to write the rewrites to disk; false (default) previews only."
    }
  },
  "required": [
    "pat",
    "rewrite"
  ]
}
```

来源：[`packages/ast/tool-ast/src/index.ts`](../packages/ast/tool-ast/src/index.ts)


### `ast_grep`

按 AST 模式对源文件进行结构化搜索。返回带行号、按文件分组的匹配节点。内联返回前 100 条匹配；被截断时汇报总数。支持 ast-grep 模式语法：`$NAME` 捕获一个节点，`$_` 匹配任意单个节点，`$$$NAME` 捕获零个或多个节点。对匹配文件使用 read 获取周边上下文。

```json
{
  "type": "object",
  "properties": {
    "pat": {
      "type": "string",
      "description": "AST pattern to match, in ast-grep syntax. Must be non-empty."
    },
    "path": {
      "type": "string",
      "description": "File or directory to search (or several roots separated by \";\"). Defaults to the session workspace; a relative path resolves against it."
    },
    "include": {
      "type": "string",
      "description": "One glob filter for which files to search (e.g. \"*.ts\", \"*.{js,jsx}\"). Not a list; negation is not supported."
    },
    "lang": {
      "type": "string",
      "description": "Force the language for pattern + targets (e.g. \"Python\", \"Rust\", \"TypeScript\"). Normally inferred from file extensions."
    },
    "strictness": {
      "type": "string",
      "description": "How strictly the pattern node kinds must match. \"smart\" is the default; \"ast\" ignores comments and trivia; \"signature\" matches node kinds without text.",
      "enum": [
        "cst",
        "smart",
        "ast",
        "relaxed",
        "signature",
        "template"
      ]
    }
  },
  "required": [
    "pat"
  ]
}
```

来源：[`packages/ast/tool-ast/src/index.ts`](../packages/ast/tool-ast/src/index.ts)

ast_grep（结构化搜索）与 ast_edit（预览／应用结构化重写）由随包提供的 ast-grep 原生二进制（`@ast-grep/cli`）驱动——无需在宿主机安装 ast-grep，也不经过 shell 层。ast_edit 总是**先预览**（apply 默认为 false），且只有在 apply: true 时才写入文件，写入经文件系统缝隙（观察＋版本校验＋沙盒策略）。

<a id="deepseek-aidsh-tool-memory"></a>


## `@deepseek-ai/dsh-tool-memory`


### `learn`

在长期项目记忆中捕获一条可复用的教训；持久化的 `memory` 载荷应能独立成句（是什么、何时、为何）。在解决了一个很可能再次有回报的洞见后使用：一个不明显的修复、一条新发现的项目约定，或一个行之有效的工作流。克制而具体地捕获：一条强有力的可复用教训胜过几条含混的。教训保留在 `learned.md` 中，会在后续会话开始时再次呈现，并在存储前对提示注入标记进行中和。

```json
{
  "type": "object",
  "properties": {
    "memory": {
      "type": "string",
      "description": "The durable, self-contained lesson to remember (what, when, why)"
    },
    "context": {
      "type": "string",
      "description": "Optional source context for the lesson"
    }
  },
  "required": [
    "memory"
  ]
}
```

来源：[`packages/memory/tool-memory/src/index.ts`](../packages/memory/tool-memory/src/index.ts)


### `memory_edit`

按 id 编辑项目记忆（`recall`/`reflect` 返回的 id）。操作：`update` 替换内容与／或重要性；`forget` 永久删除；`invalidate` 软作废，可选指定 `replacement_id`。教训与摘要条目是只读事实。对历史可能仍有价值的过时记忆优先使用 `invalidate`；只有需要硬删除时才用 `forget`。

```json
{
  "type": "object",
  "properties": {
    "op": {
      "type": "string",
      "description": "Memory edit operation",
      "enum": [
        "update",
        "forget",
        "invalidate"
      ]
    },
    "id": {
      "type": "string",
      "description": "Memory id from recall output"
    },
    "content": {
      "type": "string",
      "description": "Replacement content for update"
    },
    "importance": {
      "type": "number",
      "description": "Replacement importance for update (0–1)"
    },
    "replacement_id": {
      "type": "string",
      "description": "Replacement memory id for invalidate"
    }
  },
  "required": [
    "op",
    "id"
  ]
}
```

来源：[`packages/memory/tool-memory/src/index.ts`](../packages/memory/tool-memory/src/index.ts)


### `mine_sessions`

从本项目自己的过往会话中收割可复用教训（需要宿主 `sessionQuery` 服务；没有它则降级为不可用的提示）。读取最近数条会话日志（或明确指定的某个 `session_id`），从压缩摘要、turn/end 错误原因、全部完成的 todos 中抽取教训，并通过 `learn` 以会话作为溯源逐条存入。可偶尔运行以把对话历史转化为持久记忆；按内容去重，因此重复运行不会新增内容。

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Optional explicit session id to mine instead of the recent sessions of this project"
    }
  }
}
```

来源：[`packages/memory/tool-memory/src/index.ts`](../packages/memory/tool-memory/src/index.ts)


### `recall`

搜索长期项目记忆；返回原始相关性排序的匹配条目。在回答过往对话、用户偏好、项目决策或先前上下文能提升准确度的话题之前主动使用。`recall` 返回具体事实与条目，`reflect` 返回跨多条记忆的综合答案。此处返回的记忆 id 可回传给 `memory_edit`。

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Natural-language search query"
    },
    "limit": {
      "type": "integer",
      "description": "Maximum entries to return (default 10)"
    }
  },
  "required": [
    "query"
  ]
}
```

来源：[`packages/memory/tool-memory/src/index.ts`](../packages/memory/tool-memory/src/index.ts)


### `reflect`

从相关的长期项目记忆中综合出一个连贯的回答；与 recall 不同，它会混合多条记忆。用于横跨大量存储事实的开放式问题：“关于这位用户你知道什么？”、“总结项目决策。”、“我对 X 的偏好是什么？”。可选的 `context` 将综合聚焦于特定角度。回答仅以存储的记忆为依据——在依赖之前请先验证仓库事实。

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Question to answer from memory"
    },
    "context": {
      "type": "string",
      "description": "Optional focus context"
    }
  },
  "required": [
    "query"
  ]
}
```

来源：[`packages/memory/tool-memory/src/index.ts`](../packages/memory/tool-memory/src/index.ts)


### `retain`

在长期项目记忆中为未来会话存储一条或多条事实。用于持久、可复用的知识：用户偏好、项目决策、架构选择——任何能改进未来回答的内容。不用于一次性任务状态。每条事实必须具体且自成一体（谁、什么、何时、为何）。每次调用批量保存相关事实；条目会去重并整合。

```json
{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "description": "Memories to retain",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "content": {
            "type": "string",
            "description": "Information to remember"
          },
          "context": {
            "type": "string",
            "description": "Optional source context"
          }
        },
        "required": [
          "content"
        ]
      }
    }
  }
}
```

来源：[`packages/memory/tool-memory/src/index.ts`](../packages/memory/tool-memory/src/index.ts)

retain、recall、reflect、memory_edit、learn 与 mine_sessions 基于宿主的 `ctx.memory` 服务，外加一个 `memory:project` 系统提示区段，在下一会话开始时重新载入该会话的项目记忆（摘要＋教训＋工作条目）（port_omp.md 第 4 项）。同时挂载 `sessionQuery` 服务（tool-session-query 行）时，`recall`/`reflect` 合并过往会话命中（source `session`、只读、带 sessionId/seq 溯源），`mine_sessions` 从已完成的会话日志中收割教训——压缩摘要中的要点、turn/end 错误原因中的失败、全部完成的 todos——以 `learn` 条目存储并以会话作为溯源、按运行去重；没有该服务时所有会话特性降级为无操作，`mine_sessions` 报告 `available: false`。本移植仅内置 local；注册表为后续 Hindsight/Mnemopi 提供方保留接缝。

<a id="deepseek-aidsh-tool-terminal"></a>

## `@deepseek-ai/dsh-tool-terminal`


### `terminal_close`

关闭一个持久终端，并等待其捕获且所有的进程树完全退出。

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Terminal session id."
    }
  },
  "required": [
    "sessionId"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)


### `terminal_list`

列出当前 agent 所有的持久终端会话。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)


### `terminal_open`

通过已注册的后端类型创建按所有者隔离的持久终端会话。需要在多次工具调用之间保留 shell 或 REPL 状态时，请使用此工具。

```json
{
  "type": "object",
  "properties": {
    "type": {
      "type": "string",
      "description": "Registered terminal backend type, usually \"shell\"."
    },
    "name": {
      "type": "string",
      "description": "Optional owner-local display name such as \"main\" or \"gdb\"."
    },
    "cwd": {
      "type": "string",
      "description": "Initial working directory. Defaults to the deployment workspace root."
    }
  },
  "required": [
    "type"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)


### `terminal_read`

从持久终端读取一页有界的保留输出，不发送输入。

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Terminal session id."
    },
    "offset": {
      "type": "number",
      "description": "Newest-relative line offset (default 0)."
    },
    "count": {
      "type": "number",
      "description": "Requested line count (default 500; backend caps apply)."
    }
  },
  "required": [
    "sessionId"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)


### `terminal_send`

向持久终端发送文本。默认会提交 Enter，并等待提示符、stdin 等待、输出静默、超时或会话退出。后台模式会返回供 job_output／job_kill 使用的 job id。

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Terminal session id returned by terminal_open or terminal_list."
    },
    "text": {
      "type": "string",
      "description": "UTF-8 text to write to the terminal."
    },
    "submit": {
      "type": "boolean",
      "description": "Submit Enter after text (default true). Set false for control characters or incomplete REPL input."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Return a job id immediately; collect with job_output or stop with job_kill."
    }
  },
  "required": [
    "sessionId",
    "text"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)


### `terminal_signal`

向持久终端当前的前台进程组发送允许的信号。

```json
{
  "type": "object",
  "properties": {
    "sessionId": {
      "type": "string",
      "description": "Terminal session id."
    },
    "signal": {
      "type": "string",
      "description": "Signal to deliver. Shell-targeted SIGKILL is rejected; use terminal_close.",
      "enum": [
        "SIGINT",
        "SIGTERM",
        "SIGKILL",
        "SIGTSTP",
        "SIGHUP"
      ]
    }
  },
  "required": [
    "sessionId",
    "signal"
  ]
}
```

来源：[`packages/terminal/tool-terminal/src/index.ts`](../packages/terminal/tool-terminal/src/index.ts)

这 6 个终端工具需要选择启用，用于补充一次性 bash／文件系统工具。`terminal_send(run_in_background: true)` 会注册到 `ctx.jobs`；schema 不包含 TUI、具名按键序列、BEL、调整尺寸、自动启动和跨 agent 共享。

<a id="deepseek-aidsh-tool-goal"></a>


## `@deepseek-ai/dsh-tool-goal`


### `create_goal`

当当前直接人类请求是需要跨自主 Goal Round 持续推进的长期目标时，创建一个持久化的同会话完成目标。即使用户没有明确说「创建目标」，你也可以推断其意图。不要用于简单的单轮工作。执行时会拒绝非人类权限和 subagent 权限。

```json
{
  "type": "object",
  "properties": {
    "objective": {
      "type": "string",
      "description": "The concrete completion objective inferred from the direct human request."
    },
    "max_goal_rounds": {
      "type": "number",
      "description": "Optional positive safe-integer limit on automatic continuation rounds."
    }
  },
  "required": [
    "objective"
  ]
}
```

来源：[`packages/goal/tool-goal/src/index.ts`](../packages/goal/tool-goal/src/index.ts)


### `get_goal`

读取当前的同会话目标，包括确切的 id／revision、目标、阶段、已完成的延续 Round 数、Round 上限、存在时的阻塞原因，以及是否已准备下一次延续。更新目标前请先调用此工具。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/goal/tool-goal/src/index.ts`](../packages/goal/tool-goal/src/index.ts)


### `update_goal`

更新确切的当前目标 revision。edit、pause 和 resume 要求直接的顶层人类请求。在自动延续当前目标期间，也允许 complete 和 blocked。在达到配置的最小 Round 数之前会拒绝 blocked；模型仍须判断相同条件是否在这些 Round 中持续存在，并在 blocked_reason 中予以说明。

```json
{
  "type": "object",
  "properties": {
    "goal_id": {
      "type": "string",
      "description": "Exact id returned by get_goal."
    },
    "revision": {
      "type": "number",
      "description": "Exact positive revision returned by get_goal."
    },
    "action": {
      "type": "string",
      "description": "edit, pause, and resume require a direct top-level human request. complete and blocked are also allowed during an automatic continuation of this goal; blocked is rejected before the configured minimum round count.",
      "enum": [
        "edit",
        "pause",
        "resume",
        "complete",
        "blocked"
      ]
    },
    "objective": {
      "type": "string",
      "description": "Replacement objective; valid only with action edit."
    },
    "max_goal_rounds": {
      "type": "number",
      "description": "Replacement cap; valid only with action edit."
    },
    "blocked_reason": {
      "type": "string",
      "description": "Required only with action blocked: the concrete condition that persisted across rounds and blocks progress."
    }
  },
  "required": [
    "goal_id",
    "revision",
    "action"
  ]
}
```

来源：[`packages/goal/tool-goal/src/index.ts`](../packages/goal/tool-goal/src/index.ts)

create、edit、pause 和 resume 要求直接来自人类的根权限；complete 和 blocked 也接受确切的当前 Goal Round。blocked 的默认下限是 3 个获准的 Round。

<a id="deepseek-aidsh-schedule"></a>


## `@deepseek-ai/dsh-schedule`


### `schedule_create`

在当前会话中创建一条提醒。请提供非空 prompt 和恰好一个 selector：正的安全整数 after_seconds 延时；作为严格带偏移日期时间或本地日期／时间对象的 at；或不小于 300 的安全整数 every_seconds。固定速率提醒始终与创建时刻对齐，会跳过错过的发生时点，并把每条逾期规则的最新一个发生时点合并到一个批次中。交付模式是 session-local：只有此会话处于 live 状态时，提醒才会准时运行；否则提醒会进入 overdue 状态，直至会话恢复。

```json
{
  "type": "object",
  "properties": {
    "prompt": {
      "type": "string",
      "description": "Reminder content to present when the target becomes due."
    },
    "title": {
      "type": "string",
      "description": "Task name of at most 120 characters, shown on the task card and in task lists."
    },
    "after_seconds": {
      "type": "number",
      "description": "Delay in whole seconds."
    },
    "every_seconds": {
      "type": "number",
      "description": "Fixed-rate interval in whole seconds, at least 60, aligned to the creation time; changing it with schedule_update re-aligns it to the save time."
    },
    "daily": {
      "type": "object",
      "description": "Every day at a local time.",
      "additionalProperties": false,
      "properties": {
        "time": {
          "type": "string",
          "description": "HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00."
        },
        "time_zone": {
          "type": "string",
          "description": "UTC or IANA Area/Location, for example Asia/Shanghai."
        }
      },
      "required": [
        "time",
        "time_zone"
      ]
    },
    "weekly": {
      "type": "object",
      "description": "On the given weekdays at a local time.",
      "additionalProperties": false,
      "properties": {
        "time": {
          "type": "string",
          "description": "HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00."
        },
        "time_zone": {
          "type": "string",
          "description": "UTC or IANA Area/Location, for example Asia/Shanghai."
        },
        "weekdays": {
          "type": "array",
          "description": "ISO weekdays, Monday 1 through Sunday 7, without repetitions.",
          "items": {
            "type": "integer"
          }
        }
      },
      "required": [
        "time",
        "time_zone",
        "weekdays"
      ]
    },
    "cron": {
      "type": "object",
      "description": "Five-field Vixie cron expression in a time zone.",
      "additionalProperties": false,
      "properties": {
        "expression": {
          "type": "string",
          "description": "minute hour day-of-month month day-of-week, for example \"*/15 9-17 * * 1-5\". When both day fields are restricted, a date matches if either one matches."
        },
        "time_zone": {
          "type": "string",
          "description": "UTC or IANA Area/Location, for example Asia/Shanghai."
        }
      },
      "required": [
        "expression",
        "time_zone"
      ]
    },
    "at": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "date": {
              "type": "string"
            },
            "time": {
              "type": "string"
            },
            "time_zone": {
              "type": "string"
            }
          },
          "required": [
            "date",
            "time",
            "time_zone"
          ]
        }
      ],
      "description": "Absolute target: an RFC 3339 date-time with offset, or a local date, time, and IANA time_zone."
    }
  },
  "required": [
    "prompt",
    "title"
  ]
}
```

来源：[`packages/schedule/schedule/src/tools.ts`](../packages/schedule/schedule/src/tools.ts)


### `schedule_delete`

使用 schedule_create 或 schedule_list 返回的确切 id，删除当前会话中的一条活动提醒。未知或已经结束的 id 会返回 deleted false。

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Schedule id returned by schedule_list."
    }
  },
  "required": [
    "id"
  ]
}
```

来源：[`packages/schedule/schedule/src/tools.ts`](../packages/schedule/schedule/src/tools.ts)


### `schedule_list`

按创建顺序列出当前会话中的所有活动提醒，包括确切 id、UTC 目标、scheduled 或 overdue 状态，以及 session-local 交付模式。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/schedule/schedule/src/tools.ts`](../packages/schedule/schedule/src/tools.ts)

仅在选择启用的 Schedule 插件加载后创建的 live 根 Agent scope 内注册。版本 1 接受 after_seconds、显式绝对 at 和有界固定速率 every_seconds，并披露 session-local 交付；管理读取与变更必须通过共享的 Session 持久化 barrier。

<a id="deepseek-aidsh-tool-debug"></a>


### `schedule_update`

原地修改一条提醒并保留其 id。提供新的 title、prompt，或至多一个时间参数；未提供的字段保持原值。需要相对延迟时请新建一条提醒。

```json
{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "Schedule id returned by schedule_list."
    },
    "title": {
      "type": "string",
      "description": "New task name of at most 120 characters."
    },
    "prompt": {
      "type": "string",
      "description": "New reminder content."
    },
    "every_seconds": {
      "type": "number",
      "description": "Fixed-rate interval in whole seconds, at least 60, aligned to the creation time; changing it with schedule_update re-aligns it to the save time."
    },
    "daily": {
      "type": "object",
      "description": "Every day at a local time.",
      "additionalProperties": false,
      "properties": {
        "time": {
          "type": "string",
          "description": "HH:mm:ss with optional 1-3 fractional digits, for example 23:00:00."
        },
        "time_zone": {
          "type": "string",
          "description": "UTC or IANA Area/Location, for example Asia/Shanghai."
        }
      },
      "required": [
        "time",
        "time_zone"
      ]
    },
    "weekly": {
      "type": "object",
      "description": "On the given weekdays at a local time.",
      "additionalProperties": false,
      "properties": {
        "time": {
          "type": "string",
          "description": "HH:mm:ss with optional 1-3 fractional digits, for example 09:00:00."
        },
        "time_zone": {
          "type": "string",
          "description": "UTC or IANA Area/Location, for example Asia/Shanghai."
        },
        "weekdays": {
          "type": "array",
          "description": "ISO weekdays, Monday 1 through Sunday 7, without repetitions.",
          "items": {
            "type": "integer"
          }
        }
      },
      "required": [
        "time",
        "time_zone",
        "weekdays"
      ]
    },
    "cron": {
      "type": "object",
      "description": "Five-field Vixie cron expression in a time zone.",
      "additionalProperties": false,
      "properties": {
        "expression": {
          "type": "string",
          "description": "minute hour day-of-month month day-of-week, for example \"*/15 9-17 * * 1-5\". When both day fields are restricted, a date matches if either one matches."
        },
        "time_zone": {
          "type": "string",
          "description": "UTC or IANA Area/Location, for example Asia/Shanghai."
        }
      },
      "required": [
        "expression",
        "time_zone"
      ]
    },
    "at": {
      "oneOf": [
        {
          "type": "string"
        },
        {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "date": {
              "type": "string"
            },
            "time": {
              "type": "string"
            },
            "time_zone": {
              "type": "string"
            }
          },
          "required": [
            "date",
            "time",
            "time_zone"
          ]
        }
      ],
      "description": "Absolute target: an RFC 3339 date-time with offset, or a local date, time, and IANA time_zone."
    }
  },
  "required": [
    "id"
  ]
}
```

Source: [`packages/schedule/schedule/src/tools.ts`](../packages/schedule/schedule/src/tools.ts)

Schedule 服务加载期间，在 live 根 Agent scope 内注册。接受 after_seconds、显式绝对 at、有界固定速率 every_seconds、带显式 IANA 时区的每日与每周本地时间，以及作为五字段表达式的 cron。管理使用宿主 storage domain；到期消息会恢复原 Session。

<a id="deepseek-aidsh-tool-lsp"></a>

## `@deepseek-ai/dsh-tool-debug`


### `debug`

Attach a real debugger to a running or launched process through the Debug Adapter Protocol (DAP). 28 operations: launch, attach, set/remove_breakpoint (source or function), set/remove_instruction_breakpoint, data_breakpoint_info, set/remove_data_breakpoint, continue, step_over, step_in, step_out, pause, evaluate, stack_trace, threads, scopes, variables, disassemble, read_memory, write_memory, modules, loaded_sources, custom_request, output, terminate, sessions. One active session at a time — terminate before launching another.

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "The debug operation to perform.",
      "enum": [
        "launch",
        "attach",
        "set_breakpoint",
        "remove_breakpoint",
        "set_instruction_breakpoint",
        "remove_instruction_breakpoint",
        "data_breakpoint_info",
        "set_data_breakpoint",
        "remove_data_breakpoint",
        "continue",
        "step_over",
        "step_in",
        "step_out",
        "pause",
        "evaluate",
        "stack_trace",
        "threads",
        "scopes",
        "variables",
        "disassemble",
        "read_memory",
        "write_memory",
        "modules",
        "loaded_sources",
        "custom_request",
        "output",
        "terminate",
        "sessions"
      ]
    },
    "program": {
      "type": "string",
      "description": "Debug target path; Delve accepts Go package directories."
    },
    "args": {
      "type": "array",
      "description": "Program arguments for launch.",
      "items": {
        "type": "string"
      }
    },
    "adapter": {
      "type": "string",
      "description": "Configured adapter id (gdb, lldb-dap, debugpy, dlv, ... or a dap.json entry)."
    },
    "cwd": {
      "type": "string",
      "description": "Call working directory; defaults to the session workspace."
    },
    "file": {
      "type": "string",
      "description": "Source file (breakpoint operations)."
    },
    "line": {
      "type": "number",
      "description": "Source line (breakpoint operations)."
    },
    "function": {
      "type": "string",
      "description": "Function name (breakpoint operations)."
    },
    "name": {
      "type": "string",
      "description": "Variable or data name (data_breakpoint_info)."
    },
    "condition": {
      "type": "string",
      "description": "Breakpoint condition expression."
    },
    "hit_condition": {
      "type": "string",
      "description": "Breakpoint hit count condition."
    },
    "expression": {
      "type": "string",
      "description": "Expression to evaluate."
    },
    "context": {
      "type": "string",
      "description": "Evaluate context (default repl).",
      "enum": [
        "watch",
        "repl",
        "hover",
        "variables",
        "clipboard"
      ]
    },
    "frame_id": {
      "type": "number",
      "description": "Stack frame id (scopes/evaluate)."
    },
    "scope_id": {
      "type": "number",
      "description": "Scope variables reference (variables)."
    },
    "variable_ref": {
      "type": "number",
      "description": "Variable reference (variables)."
    },
    "pid": {
      "type": "number",
      "description": "Process id for attach."
    },
    "port": {
      "type": "number",
      "description": "Remote attach port."
    },
    "host": {
      "type": "string",
      "description": "Remote attach host (default localhost)."
    },
    "levels": {
      "type": "number",
      "description": "Max stack frames for stack_trace."
    },
    "memory_reference": {
      "type": "string",
      "description": "Memory reference or address."
    },
    "instruction_reference": {
      "type": "string",
      "description": "Instruction reference for set_instruction_breakpoint."
    },
    "instruction_count": {
      "type": "number",
      "description": "Instructions to disassemble."
    },
    "instruction_offset": {
      "type": "number"
    },
    "count": {
      "type": "number",
      "description": "Bytes to read for read_memory."
    },
    "data": {
      "type": "string",
      "description": "Base64 memory payload for write_memory."
    },
    "data_id": {
      "type": "string",
      "description": "Data breakpoint id."
    },
    "access_type": {
      "type": "string",
      "description": "Data breakpoint access type.",
      "enum": [
        "read",
        "write",
        "readWrite"
      ]
    },
    "command": {
      "type": "string",
      "description": "Custom DAP request command."
    },
    "arguments": {
      "type": "object",
      "description": "Custom request arguments.",
      "additionalProperties": true
    },
    "offset": {
      "type": "number",
      "description": "Byte offset for memory operations."
    },
    "resolve_symbols": {
      "type": "boolean"
    },
    "allow_partial": {
      "type": "boolean"
    },
    "start_module": {
      "type": "number"
    },
    "module_count": {
      "type": "number"
    },
    "timeout": {
      "type": "number",
      "description": "Per-request timeout in seconds (default 30)."
    }
  },
  "required": [
    "action"
  ]
}
```

Source: [`packages/debug/tool-debug/src/index.ts`](../packages/debug/tool-debug/src/index.ts)

debug composes a real debugger (gdb/lldb-dap/debugpy/dlv/...) through the DAP capability seam (ctx.dap) with one exclusive active session: launch/attach, source/function/instruction/data breakpoints, continue/pause/step, threads/stackTrace/scopes/variables/evaluate, disassemble, read_memory/write_memory, modules, loaded_sources, custom_request, output, terminate, sessions. Requires a mounted DAP provider and the spawn seam; with none available, launch/attach return a structured "unavailable" error naming the missing adapter.



## `@deepseek-ai/dsh-code-runtime-kernels`


### `run_kernel_code`

在持久化 kernel 中执行模型代码，并返回其 JSON 完成值与打印输出。`language` 选择运行时：`python` 或 `typescript`。`typescript` 下每个 cell 以异步函数体运行，因此支持顶层 `await` 与 `return`。`python` 下以模块运行：支持顶层 `await`，语句会持久化进会话命名空间，最后一个表达式即完成值（顶层 `return` 是非法 Python）。跨调用携带相同的非空 `session` 以保留 kernel 状态（变量、导入、工作数据）；省略它以一次性运行于全新状态。传 `reset: true` 会在本次运行前丢弃该会话先前的 kernel 状态（一次 reset，而不是状态损坏后的无限重试）。

```json
{
  "type": "object",
  "properties": {
    "language": {
      "type": "string",
      "description": "Which runtime executes the code.",
      "enum": [
        "python",
        "typescript"
      ]
    },
    "code": {
      "type": "string",
      "description": "The program source. Runs as the body of an async function: top-level `await` and `return` are available; return a JSON value to surface it as the result value."
    },
    "session": {
      "type": "string",
      "description": "Optional persistent-kernel identity: runs sharing a session id keep kernel state. Omit for one-shot."
    },
    "reset": {
      "type": "boolean",
      "description": "Discard the session's prior kernel state (variables, imports) before this run. Costs one reset instead of many retries; requires `session` to be meaningful."
    }
  },
  "required": [
    "language",
    "code"
  ]
}
```

Source: [`packages/code-runtime/code-runtime-kernels/src/index.ts`](../packages/code-runtime/code-runtime-kernels/src/index.ts)

run_kernel_code 在持久化 kernel（python3 或 node 子进程，仅标准库／内置）中执行模型代码，共享同一个宿主驱动：按 session id 的 kernel 状态与 reset、墙钟预算、SIGINT→SIGTERM→SIGKILL 升级、恶意对端解析。这是进程隔离而非安全边界——与 harness 进程后端相同的信任（port_omp.md 第 1 项）。

<a id="deepseek-aidsh-tool-lsp"></a>


## `@deepseek-ai/dsh-tool-lsp`


### `lsp`

查询语言服务器，以精确导航代码。operation 可取 goToDefinition、findReferences、goToImplementation 或 hover。line 和 character 是从 1 开始的 UTF-16 光标坐标。findReferences 包含声明。

```json
{
  "type": "object",
  "properties": {
    "operation": {
      "type": "string",
      "description": "goToDefinition, findReferences, goToImplementation, goToTypeDefinition, hover, documentSymbols, codeActions, rename, or diagnostics.",
      "enum": [
        "goToDefinition",
        "findReferences",
        "goToImplementation",
        "goToTypeDefinition",
        "hover",
        "documentSymbols",
        "codeActions",
        "rename",
        "diagnostics"
      ]
    },
    "file_path": {
      "type": "string",
      "description": "The source file to query, relative to the workspace or absolute."
    },
    "line": {
      "type": "number",
      "description": "One-based line of the cursor (pass 1 for documentSymbols / diagnostics)."
    },
    "character": {
      "type": "number",
      "description": "One-based UTF-16 column of the cursor (pass 1 for documentSymbols / diagnostics)."
    },
    "new_name": {
      "type": "string",
      "description": "The new symbol name for rename; required by rename, ignored by others."
    }
  },
  "required": [
    "operation",
    "file_path",
    "line",
    "character"
  ]
}
```

来源：[`packages/lsp/tool-lsp/src/index.ts`](../packages/lsp/tool-lsp/src/index.ts)

lsp 工具将提供方选择和语言服务器子进程置于 ctx.lsp 之后，因此其模型可见 schema 在更换提供方时保持稳定。运行时要求已注册提供方，例如 `@deepseek-ai/dsh-lsp-stdio`；如果没有提供方，查询会返回结构化 `LSP_UNAVAILABLE` 错误，而不会改变 schema。

<a id="deepseek-aidsh-tool-ralph"></a>


## `@deepseek-ai/dsh-tool-ralph`


### `ralph`

围绕一个不可变目标运行使用全新 agent 的前台 Ralph 循环。仅当直接人类明确要求 Ralph 或使用全新 agent 迭代时使用。每个 Round 都会启动一个全新子级，该子级看不到父级对话或先前子会话；共享工作区充当长期记忆，Round 之间只传递有界的结构化报告。当工作进程报告完成、报告具体阻塞项或达到 Round 上限时，调用返回。普通的长期同会话工作应使用 goal 工具。

```json
{
  "type": "object",
  "properties": {
    "objective": {
      "type": "string",
      "description": "The immutable completion objective for every fresh Ralph round."
    },
    "maxRounds": {
      "type": "number",
      "description": "Optional positive safe-integer round cap, bounded by the deployment ceiling."
    }
  },
  "required": [
    "objective"
  ]
}
```

来源：[`packages/workflow/tool-ralph/src/index.ts`](../packages/workflow/tool-ralph/src/index.ts)

固定的前台工作流会在每个 Round 启动一个全新的结构化子级；模型只能选择不可变目标和可选的 Round 上限。

<a id="deepseek-aidsh-tool-skill"></a>


## `@deepseek-ai/dsh-tool-skill`


### `skill`

加载可用 skill（技能）的完整说明。在执行点名某项 skill 或与其明确匹配的任务前，请使用会话 skill 目录中的确切名称调用此工具。

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "The exact skill name from the available skills list."
    }
  },
  "required": [
    "name"
  ]
}
```

来源：[`packages/skill/tool-skill/src/index.ts`](../packages/skill/tool-skill/src/index.ts)

<a id="deepseek-aidsh-tool-session-query"></a>


## `@deepseek-ai/dsh-tool-session-query`


### `session_event_read`

从一个已获授权的会话中读取一个完整且未删节的事件，以及可选的相邻原始事件概述。

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Target session id. Omit for the current session."
    },
    "seq": {
      "type": "integer",
      "description": "Target event sequence number."
    },
    "before": {
      "type": "integer",
      "description": "Number of preceding raw events to summarize. Omit for none."
    },
    "after": {
      "type": "integer",
      "description": "Number of following raw events to summarize. Omit for none."
    }
  },
  "required": [
    "seq"
  ]
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)


### `session_event_search`

在一个已获授权的会话中搜索先前事件；如果搜索当前会话，则排除执行此次调用的步骤。

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Target session id. Omit for the current session."
    },
    "query": {
      "type": "string",
      "description": "Literal full-text query over the target session."
    },
    "seq_from": {
      "type": "integer",
      "description": "Inclusive event sequence lower bound."
    },
    "seq_to": {
      "type": "integer",
      "description": "Inclusive event sequence upper bound."
    },
    "time_from": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 event-time lower bound."
    },
    "time_to": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 event-time upper bound."
    },
    "event_types": {
      "type": "array",
      "description": "Event types to include.",
      "items": {
        "type": "string"
      }
    },
    "surfaces": {
      "type": "array",
      "description": "Event surfaces to include.",
      "items": {
        "type": "string",
        "enum": [
          "current",
          "shadowed",
          "log-only"
        ]
      }
    }
  },
  "required": [
    "query"
  ]
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)


### `session_event_trace`

读取已获授权会话中某个事件的所有直接替换关系，以及该事件与其引用的来源事件之间的关系。

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Target session id. Omit for the current session."
    },
    "seq": {
      "type": "integer",
      "description": "Target event sequence number."
    }
  },
  "required": [
    "seq"
  ]
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)


### `session_search`

搜索调用方工作区中的先前会话，并从每个会话返回匹配度最高的事件。

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Literal full-text query over prior session history."
    },
    "session_ids": {
      "type": "array",
      "description": "Optional session ids to include.",
      "items": {
        "type": "string"
      }
    },
    "created_at_from": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 creation-time lower bound."
    },
    "created_at_to": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 creation-time upper bound."
    },
    "parent_session_ids": {
      "type": "array",
      "description": "Optional direct parent session ids.",
      "items": {
        "type": "string"
      }
    },
    "include_root_sessions": {
      "type": "boolean",
      "description": "Include sessions with no parent in the parent filter."
    },
    "availability": {
      "type": "array",
      "description": "Require at least one selected source availability.",
      "items": {
        "type": "string",
        "enum": [
          "live",
          "persisted"
        ]
      }
    },
    "event_seq_from": {
      "type": "integer",
      "description": "Inclusive event sequence lower bound."
    },
    "event_seq_to": {
      "type": "integer",
      "description": "Inclusive event sequence upper bound."
    },
    "event_time_from": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 event-time lower bound."
    },
    "event_time_to": {
      "type": "string",
      "description": "Inclusive timezone-qualified ISO 8601 event-time upper bound."
    },
    "event_types": {
      "type": "array",
      "description": "Event types to include.",
      "items": {
        "type": "string"
      }
    },
    "event_surfaces": {
      "type": "array",
      "description": "Event surfaces to include.",
      "items": {
        "type": "string",
        "enum": [
          "current",
          "shadowed",
          "log-only"
        ]
      }
    }
  },
  "required": [
    "query"
  ]
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)


### `session_trace`

读取围绕一个会话的已授权会话谱系，包括完整可见的祖先和后代关系。

```json
{
  "type": "object",
  "properties": {
    "session_id": {
      "type": "string",
      "description": "Target session id. Omit for the current session."
    }
  }
}
```

来源：[`packages/session-query/tool-session-query/src/index.ts`](../packages/session-query/tool-session-query/src/index.ts)

这 5 个只读工具会隐藏提供方游标，并根据不可变的调用 agent 会话为每个结果授权。该包需要选择启用；需要强制截止时间或限制行内输出的组合还会挂载通用超时或 spill 策略。

<a id="deepseek-aidsh-tool-subagent"></a>


## `@deepseek-ai/dsh-tool-subagent`


### `list_subagent_models`

在不改变当前 Agent 的情况下发现面向 subagent 的 LLM 路由。不带参数调用可列出已注册的提供方；带上 `provider` 可列出其宣传的模型；同时带上 `provider` 与 `model` 可检查该确切模型及其推理投入。目录成员资格仅供参考：适配器可能接受未列出的模型 id。请将返回的 id 用于委派工具的 `provider`、`model` 与 `reasoning_effort` 字段。

```json
{
  "type": "object",
  "properties": {
    "provider": {
      "type": "string",
      "description": "Registered LLM provider id. Omit to list providers."
    },
    "model": {
      "type": "string",
      "description": "Exact model id to inspect. Requires provider; omit to list that provider's advertised models."
    }
  }
}
```

来源：[`packages/subagent/tool-subagent/src/list-models.ts`](../packages/subagent/tool-subagent/src/list-models.ts)


### `subagent`

将一项自包含任务委派给 subagent（在自身上下文中工作的独立 agent），用它卸载聚焦且独立的工作，例如研究、限定范围的实现或分析，以免消耗当前对话的上下文。subagent 会返回结果，但不会返回中间步骤。请提供完整、独立的提示词，因为它看不到当前对话。此调用默认等待结果。设置 `run_in_background: true` 可返回 job id；使用 `job_output` 收集结果，使用 `job_kill` 停止任务。

```json
{
  "type": "object",
  "properties": {
    "description": {
      "type": "string",
      "description": "A short (3-5 word) description of the delegated task, for display."
    },
    "prompt": {
      "type": "string",
      "description": "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs."
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Run as a background job and return its id (collect with job_output, stop with job_kill). Defaults to false."
    },
    "workspace": {
      "type": "string",
      "description": "Absolute path of an existing directory the child works in — typically the `path` from a `worktree` acquire so one task owns one isolated git worktree. The child session workspace and its file tools resolve against this directory (which must be inside the deployment file-policy scope)."
    }
  },
  "required": [
    "description",
    "prompt"
  ]
}
```

来源：[`packages/subagent/tool-subagent/src/index.ts`](../packages/subagent/tool-subagent/src/index.ts)

注册的工具名称取决于加载时 `toolName` 配置（默认为 `subagent`）；上述 schema 对应默认值。随产品发布的组合会为每个 subagent 后端加载一次该包，因此模型还会看到绑定到 fork 后端的 `subagent_fork`。每个实例的描述、`run_in_background` 参数与 system prompt 策略取决于它自己的 `backgroundMode` 和 `enableRunInBackground`，因此两个随附 schema 并不相同：`subagent` 为 `continuable`，省略参数时默认后台运行，并由 runtime 自动投递结束结果；`subagent_fork` 保持 `one-shot`，省略参数时默认前台运行。详见 `packages/bundle/base/cordis.patch.yml` 和 `examples/acp-agent/cordis.yml`。

<a id="deepseek-aidsh-tool-subagent-control"></a>


## `@deepseek-ai/dsh-tool-subagent-control`


### `interrupt_agent`

根据 agent id 请求取消后台 agent 的当前轮次。目标可以是你的直接子级，也可以是在你下方创建的更深层 agent。只有当前轮次会停止：已经排队发给该 agent 的消息会一直搁置到后续的 send_message；它启动的 agent 会继续运行；该 agent 本身仍可接受后续操作。停止请求被接受后，此调用立即返回，因此目标可能还会短暂运行；中断一个已经完成的 agent 是可接受的空操作。

```json
{
  "type": "object",
  "properties": {
    "agent_id": {
      "type": "string",
      "description": "The id of an agent created under you: your direct child or a deeper descendant."
    }
  },
  "required": [
    "agent_id"
  ]
}
```

来源：[`packages/subagent/tool-subagent-control/src/index.ts`](../packages/subagent/tool-subagent-control/src/index.ts)


### `list_agents`

按持久 id 和标签列出你的可继续后台 subagent。用它回忆你启动过哪些 subagent，而不是轮询完成情况——subagent 完成时你会被告知。状态来自实时注册表：running 表示 agent 此刻正在工作；idle 表示已加载但处于轮次之间，可能正在等待它启动的 agent；ready 表示它只存在于存储中——可恢复而非终态，也不表示有结果等待收集；`send_message` 会在运行中 child 的最近 step 边界 steer 消息，或为 idle、ready child 启动轮次，且无论处于哪种状态，直接子级都仍可作为 `send_message` 的目标。该快照并非投递承诺；`send_message` 会执行权威检查，仍可能失败。无法读取的子级会作为诊断信息报告，而不会被静默丢弃。`descendants` 作用域会按稳定的前序顺序遍历你下方的整棵树，并为每个条目标注其持久的直接父会话 id 和深度。只有深度为 1 的条目可以使用 `send_message`；更深的条目只能作为 `interrupt_agent` 的候选目标。

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "description": "children (default) lists direct children, which accept send_message in any status. descendants lists the whole tree below you with each entry's parent session id and depth; entries deeper than 1 accept only interrupt_agent.",
      "enum": [
        "children",
        "descendants"
      ]
    }
  }
}
```

来源：[`packages/subagent/tool-subagent-control/src/list-agents.ts`](../packages/subagent/tool-subagent-control/src/list-agents.ts)


### `send_message`

根据 agent id 向直接可继续 child 发送消息。如果你是驻留的可继续 child，也可以把自己的直接 parent 作为目标。如果目标仍在工作，消息会 steer 其最近的 step；如果目标处于 idle，消息会启动一个轮次。此调用不会返回该 agent 的答案，只会确认消息已投递。调用失败表示消息**未**投递。

```json
{
  "type": "object",
  "properties": {
    "agent_id": {
      "type": "string",
      "description": "The agent id of your direct continuable child, or your direct parent when you are a resident continuable child."
    },
    "message": {
      "type": "string",
      "description": "The message to deliver to the agent."
    }
  },
  "required": [
    "agent_id",
    "message"
  ]
}
```

来源：[`packages/subagent/tool-subagent-control/src/index.ts`](../packages/subagent/tool-subagent-control/src/index.ts)

这些是控制可继续后台 subagent 的全局命名工具：绑定提供方的 `tool-subagent` 实例注册不同的委派工具；本包注册一次 `send_message` 和 `interrupt_agent`，另由 `list_agents` 通过单独加载的 `/list-agents` 插件提供，其目录行使用 sessionProjections 和实时 Agent 注册表。`pending_decisions` 展示由决策形态的子级报告记录而来的、带键的待决事项账本。

<a id="deepseek-aidsh-tool-subagent-report"></a>


## `@deepseek-ai/dsh-tool-subagent-report`


### `report`

将选定内容报告给启动你的 agent。在结束前调用一次，并提供自包含的最终结果；更早时可以报告会改变该 agent 下一步行动的进展或发现。该 agent 与你共享工作区，但不会自动收到你的对话记录、工具输出或推理内容，因此完成工作本身并不等于交付结果。报告不会结束你的回合或完成你的工作，且只有你的直属父级会收到。失败的调用仍可能已送达，所以不要盲目重复。单独使用 `output` 表达自由文本说明；只有当父级必须在你继续之前做出决定时才添加 `status` 与 `decisionKey` + `summary`（`needs-decision` = 你同时继续工作；`blocked` = 你无法继续）。

```json
{
  "type": "object",
  "properties": {
    "output": {
      "type": "string",
      "description": "Actionable content for your parent; summarize conclusions and reference relevant shared paths."
    },
    "status": {
      "type": "string",
      "description": "Structured status of this report. `needs-decision` and `blocked` open a keyed decision for your parent.",
      "enum": [
        "done",
        "progress",
        "needs-decision",
        "blocked"
      ]
    },
    "summary": {
      "type": "string",
      "description": "One-line actionable summary. Required together with `decisionKey` for a decision-shaped report."
    },
    "evidence": {
      "type": "array",
      "description": "Optional evidence lines backing the summary.",
      "items": {
        "type": "string"
      }
    },
    "nextSteps": {
      "type": "array",
      "description": "Optional next steps you have planned or that await the parent's answer.",
      "items": {
        "type": "string"
      }
    },
    "blocker": {
      "type": "string",
      "description": "Required (and only meaningful) when `status` is `blocked`: what stops you."
    },
    "decisionKey": {
      "type": "string",
      "description": "Stable, short key making this report an open decision; unique within your reports. The parent answers with the same key."
    }
  }
}
```

来源: [`packages/subagent/tool-subagent-report/src/index.ts`](../packages/subagent/tool-subagent-report/src/index.ts)

按可继续的进程内子级注册，而非全局注册，因此该 schema 仅在这种子级内部可见，并且不受其全局 `toolFilter` 影响。同一份贡献还会安装子级作用域的 `tool:report` 系统提示词 section，本目录不渲染该 section。面向父级的 `send_message` 工具单独安装。

<a id="deepseek-aidsh-tool-jobs"></a>


## `@deepseek-ai/dsh-tool-jobs`


### `job_kill`

根据 job id 请求取消正在运行的后台任务。此调用立即返回；任务的工作真正停止后，会以 killed 状态结算。

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "description": "Job id returned by the tool that started the background work."
    },
    "reason": {
      "type": "string",
      "description": "Optional short reason, recorded in the log and forwarded to the job."
    }
  },
  "required": [
    "job_id"
  ]
}
```

来源：[`packages/jobs/tool-jobs/src/index.ts`](../packages/jobs/tool-jobs/src/index.ts)


### `job_list`

列出你的后台任务（包括正在运行和已完成的任务）及其 id、种类和状态。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/jobs/tool-jobs/src/index.ts`](../packages/jobs/tool-jobs/src/index.ts)


### `job_output`

读取后台任务。流式任务只返回自上次读取以来的输出；最终输出任务会在结算后返回结果。每个响应都以 `[status: ...]` 结尾。读取默认不阻塞；设置 `wait: true` 后，最长等待到配置的上限。

```json
{
  "type": "object",
  "properties": {
    "job_id": {
      "type": "string",
      "description": "Job id returned by the tool that started the background work."
    },
    "wait": {
      "type": "boolean",
      "description": "Block until the job finishes or the timeout expires; a timed-out wait leaves the job running. Defaults to false."
    },
    "timeout_ms": {
      "type": "number",
      "description": "Max wait in milliseconds with wait: true. Defaults to and is capped by configuration."
    }
  },
  "required": [
    "job_id"
  ]
}
```

来源：[`packages/jobs/tool-jobs/src/index.ts`](../packages/jobs/tool-jobs/src/index.ts)

与任务种类无关的后台任务控制器：后台 bash 命令、PTY 发送和 subagent 都通过相同的 3 个工具读取、列出和终止。加载该插件会挂接控制器，从而启用生产方的 `ctx.jobs.start()`。


## `@deepseek-ai/dsh-experimental-tool-agent-team`


### `interrupt_agent`

中断一名 teammate 的当前 turn，同时保留其待处理 inbox。仅 Team Lead 可用。

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Teammate target returned by spawn_teammate or list_agents."
    }
  },
  "required": [
    "target"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)


### `list_agents`

列出 Lead 与所有持久 teammate，以及各自当前的运行时状态。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)


### `send_message`

向另一名 Team member 发送一条持久消息。running target 会在最近的步骤边界收到消息；idle target 会启动一个 turn；inactive teammate 会冷恢复。

```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "Member target returned by spawn_teammate or list_agents, including lead."
    },
    "message": {
      "type": "string",
      "description": "Self-contained message for the target."
    }
  },
  "required": [
    "target",
    "message"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)


### `spawn_teammate`

创建一名具名、持久的 teammate。只有 Team Lead 可以调用此工具。

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Unique lower-kebab-case teammate name."
    },
    "description": {
      "type": "string",
      "description": "Short description of the delegated responsibility."
    },
    "prompt": {
      "type": "string",
      "description": "Complete initial task for the teammate."
    },
    "context": {
      "type": "string",
      "description": "fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.",
      "enum": [
        "fresh",
        "fork"
      ]
    }
  },
  "required": [
    "name",
    "description",
    "prompt"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)


### `team_task_create`

在共享 Team 任务板上创建一个无 owner 的 pending task。

```json
{
  "type": "object",
  "properties": {
    "subject": {
      "type": "string",
      "description": "Concise task title."
    },
    "description": {
      "type": "string",
      "description": "Complete task details and acceptance criteria."
    },
    "blocked_by": {
      "type": "array",
      "description": "Task ids that must complete first.",
      "items": {
        "type": "string"
      }
    },
    "write_scopes": {
      "type": "array",
      "description": "Advisory workspace-relative file or directory prefixes this task expects to modify.",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "subject",
    "description"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)


### `team_task_get`

在修改或执行共享任务前，读取其完整的最新值。

```json
{
  "type": "object",
  "properties": {
    "task_id": {
      "type": "string",
      "description": "Shared task id."
    }
  },
  "required": [
    "task_id"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)


### `team_task_list`

列出共享任务，包括 readiness、owner、revision、blocker 与 write-scope warning。

```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "description": "Optional exact status filter.",
      "enum": [
        "pending",
        "in_progress",
        "completed"
      ]
    },
    "owner": {
      "type": "string",
      "description": "Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner."
    },
    "ready": {
      "type": "boolean",
      "description": "Optional readiness filter."
    },
    "cursor": {
      "type": "integer",
      "description": "Zero-based result offset. Defaults to 0."
    },
    "limit": {
      "type": "integer",
      "description": "Number of rows, 1 through 100. Defaults to 50."
    }
  }
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)


### `team_task_update`

使用 team_task_get 或 team_task_list 返回的最新 revision，对共享任务操作执行 compare-and-set。

```json
{
  "type": "object",
  "properties": {
    "task_id": {
      "type": "string",
      "description": "Shared task id."
    },
    "expected_revision": {
      "type": "integer",
      "description": "Current task revision used as the CAS precondition."
    },
    "action": {
      "type": "string",
      "description": "Task transition to apply.",
      "enum": [
        "claim",
        "release",
        "edit",
        "set_dependencies",
        "complete",
        "reopen",
        "reassign",
        "delete"
      ]
    },
    "subject": {
      "type": "string",
      "description": "Replacement title for edit."
    },
    "description": {
      "type": "string",
      "description": "Replacement details for edit."
    },
    "blocked_by": {
      "type": "array",
      "description": "Complete blocker list for set_dependencies.",
      "items": {
        "type": "string"
      }
    },
    "write_scopes": {
      "type": "array",
      "description": "Replacement advisory write scopes for edit.",
      "items": {
        "type": "string"
      }
    },
    "owner": {
      "type": "string",
      "description": "Member target from spawn_teammate or list_agents for Lead-only reassign; omit to unassign."
    }
  },
  "required": [
    "task_id",
    "expected_revision",
    "action"
  ]
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)


### `wait_agent`

等待本次调用开始后下一次 teammate 状态、mailbox 或共享任务变更。它绝不会唤醒 inactive member；若没有其他 member 正在 running 或 provisioning，则立即返回 noProgress。唤醒或超时后应重新列出状态，而不是轮询。

```json
{
  "type": "object",
  "properties": {
    "timeout_ms": {
      "type": "integer",
      "description": "Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000."
    }
  }
}
```

来源：[`packages/experimental/tool-agent-team/src/index.ts`](../packages/experimental/tool-agent-team/src/index.ts)

这 10 个工具限定于隐式 Team Lead 与持久 teammate 作用域。随产品发布的 dsh-base bundle 默认禁用该包；文档中的 Agent Teams profile patch 会启用它，并禁用旧 continuable child 的同名控制工具。


<a id="deepseek-aidsh-tool-todo"></a>

## `@deepseek-ai/dsh-tool-todo`


### `todo_write`

记录并更新当前工作的结构化任务列表。每次调用都要发送**完整列表**，它会**替换**之前的列表，不支持局部更新或逐项编辑。请用它规划多步骤工作并展示进度：开始前为每个具体步骤添加一项 todo。将当前正在处理的每项 todo 标记为 `in_progress`；确实并行运行时（例如并发 subagent 或后台命令）可同时标记多项，顺序工作则标记 1 项。只要工作尚未完成，就应至少有一项任务为 `in_progress`。某项 todo 完成后立即标记为 `completed`，不要批量标记完成；只有全部工作完成后，才可以没有 `in_progress` 项。简单的单步骤任务无需使用列表。状态：`pending`（未开始）、`in_progress`（正在处理）、`completed`（已完成）。

```json
{
  "type": "object",
  "properties": {
    "todos": {
      "type": "array",
      "description": "The COMPLETE task list, replacing any previous list.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "content": {
            "type": "string",
            "description": "What the task is — a short imperative line."
          },
          "status": {
            "type": "string",
            "description": "pending (not started) | in_progress (now) | completed (done).",
            "enum": [
              "pending",
              "in_progress",
              "completed"
            ]
          }
        },
        "required": [
          "content",
          "status"
        ]
      }
    }
  },
  "required": [
    "todos"
  ]
}
```

来源：[`packages/todo/tool-todo/src/index.ts`](../packages/todo/tool-todo/src/index.ts)

todo_write 是会话所有的状态；UI 将最新的 todo/write 事件渲染为检查清单。`allowParallelInProgress` 是没有默认值的必填项，因此本目录明确选择 `true`，对应描述允许同时存在多个 `in_progress` 项。选择 `false` 的部署会获得同一工具，但描述会要求只能有 1 个活动任务。

<a id="deepseek-aidsh-tool-workflow"></a>


## `@deepseek-ai/dsh-tool-workflow`


### `workflow`

运行用于大规模编排 subagent 的 JavaScript 工作流脚本。当工作会分散到许多相互独立的部分时，请使用此工具，例如审查大量文件、执行迁移、开展多角度研究或对发现进行对抗式验证；此时应将编排写成脚本，而不是逐轮委派。

工作流的身份通过 `meta` 参数以 JSON 形式传入：必填的 `name`（简短 kebab-case）和 `description` 字符串，以及可选的 `whenToUse` 字符串和 `phases` 数组（`{title, detail?, provider?, model?}`）。`script` 参数只能是纯 JavaScript **函数体**，不能是 TypeScript，也不能包含 `export const meta` 语句；meta 是参数而非代码。脚本支持顶层 await；请以 `return <value>` 结尾，该值必须可以 JSON 序列化，并作为此工具的结果。

脚本函数体提供以下钩子：

- `agent(prompt, opts?): Promise<any>`：运行一个 subagent 直至完成。不提供 `opts.schema` 时，解析为子级最终文本；提供 `opts.schema` 时，它必须是以对象为根、且**只能**使用 type/properties/required/additionalProperties/items/enum/const/oneOf 的 JSON Schema，不支持 pattern/format/数值边界，此时解析为通过校验的对象。子级失败时解析为 `null`，可使用 `.filter(Boolean)` 过滤。其他选项包括 `label`（显示名称）、`phase`（进度组），以及相互独立的 `provider`／`model` LLM（大语言模型）目标覆盖项，两者可单独提供。其他任何选项（`effort`／`isolation`／`agentType`）都会明确报错。
- `pipeline(items, ...stages): Promise<any[]>`：让每个条目分别经过各阶段，阶段之间**没有**屏障；多阶段工作优先使用它。每个阶段接收 `(prev, item, index)`。普通的阶段异常会将该**条目**变为 `null`，并跳过它的剩余阶段。
- `parallel(thunks): Promise<any[]>`：并发运行零参数函数并等待**全部**完成。它会形成屏障，仅当某个阶段确实需要汇总全部先前结果时使用。抛出异常的 thunk 解析为 `null`。
- `phase(title)`：开始一个进度阶段；`log(message)`：说明进度；`args`：工具调用的 `args` 输入，原样提供。

如果误用钩子（参数错误、未知选项、不受支持的 schema、触发上限），抛出的错误**总会**终止脚本，绝不会退化为单个条目的 `null`。

约束：并发上限和 agent 总数上限均会生效；不提供文件系统、网络、定时器或 Node.js API。具体工作由 agent 完成，脚本只负责编排。该运行在前台执行：整个脚本完成后，调用才会返回。

```json
{
  "type": "object",
  "properties": {
    "script": {
      "type": "string",
      "description": "The plain JavaScript body, not TypeScript and without an `export const meta` statement; top-level await is allowed. End with `return <value>`; the JSON-serializable value is this tool's result."
    },
    "meta": {
      "type": "object",
      "description": "The workflow identity as plain JSON, not code.",
      "additionalProperties": true,
      "properties": {
        "name": {
          "type": "string",
          "description": "Short kebab-case workflow name."
        },
        "description": {
          "type": "string",
          "description": "One-line description of what the workflow does."
        },
        "whenToUse": {
          "type": "string",
          "description": "Optional guidance on when this workflow applies."
        },
        "phases": {
          "type": "array",
          "description": "Optional phase declarations matched by phase() calls.",
          "items": {
            "type": "object",
            "additionalProperties": true,
            "properties": {
              "title": {
                "type": "string",
                "description": "The phase title phase() calls match by exact string."
              },
              "detail": {
                "type": "string",
                "description": "Optional one-line description of the phase."
              },
              "provider": {
                "type": "string",
                "description": "Optional provider override this phase is expected to use."
              },
              "model": {
                "type": "string",
                "description": "Optional model override this phase is expected to use."
              }
            },
            "required": [
              "title"
            ]
          }
        }
      },
      "required": [
        "name",
        "description"
      ]
    },
    "args": {
      "type": "object",
      "description": "Optional JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {\"files\": [...]}).",
      "additionalProperties": true
    },
    "run_in_background": {
      "type": "boolean",
      "description": "Run as a background job: return a job id immediately instead of waiting; the return value arrives with the completion notice."
    }
  },
  "required": [
    "script",
    "meta"
  ]
}
```

来源：[`packages/workflow/tool-workflow/src/index.ts`](../packages/workflow/tool-workflow/src/index.ts)

<a id="deepseek-aidsh-tool-web"></a>


## `@deepseek-ai/dsh-tool-workspace-dependencies`

### `load_workspace_dependencies`

获取随包附带的 Python 和库目录的绝对路径，以及随包 Python 发行版的版本。payload 提供 Node.js 和 pnpm 时才返回对应路径。Python 含 numpy、pandas、python-docx、python-pptx、openpyxl、Pillow、lxml 与 XlsxWriter。除非用户或工作区指令选择了别的环境，Office 文件请使用这些库。返回 Node.js 和 pnpm 路径时，用该 Node 可执行文件和 pnpm 脚本路径运行 pnpm。本工具不改 PATH，也不改包管理器设置。

```json
{
  "type": "object",
  "properties": {}
}
```

来源：[`packages/skill/tool-workspace-dependencies/src/index.ts`](../packages/skill/tool-workspace-dependencies/src/index.ts)

<a id="deepseek-aidsh-tool-web"></a>

## `@deepseek-ai/dsh-tool-web`


### `web_fetch`

获取指定 HTTP(S) URL 的内容，并将其解码为文本后返回。

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "The HTTP(S) URL to fetch."
    }
  },
  "required": [
    "url"
  ]
}
```

来源：[`packages/web/tool-web/src/index.ts`](../packages/web/tool-web/src/index.ts)


### `web_search`

在 Web 上搜索最新信息。在必填的 `queries` 数组中提供 1–4 个查询。返回可选的摘要答案和来源 URL 列表。

```json
{
  "type": "object",
  "properties": {
    "queries": {
      "type": "array",
      "description": "1–4 search queries; their results are merged.",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "queries"
  ]
}
```

来源：[`packages/web/tool-web/src/index.ts`](../packages/web/tool-web/src/index.ts)

web_search 和 web_fetch 将提供方选择置于 ctx.web 之后，使模型可见 schema 在更换后端时保持稳定。
<a id="deepseek-aidsh-tool-git"></a>


## `@deepseek-ai/dsh-tool-git`


### `commit`

分析当前的 git 变更，并产出一个 conventional-commit 拆分子建议。读取已暂存（或在无暂存内容时自动暂存工作区）的树，返回按文件的增删计数、有界 diff 文本、锁文件提示和一个建议计划骨架。阅读分析后，编写精确的 `SplitCommitPlan`（类型、作用域、摘要、依赖），并将其交给 `commit_apply` 执行。这里绝不编辑文件：本工具只读，从不写入仓库。


```json
{
  "type": "object",
  "properties": {
    "stagedOnly": {
      "type": "boolean",
      "description": "Analyze only what is already staged; when false and nothing is staged, stage all changes first (default false)."
    },
    "context": {
      "type": "string",
      "description": "Optional user context for planning: intent, headline change, reviewers, issue refs."
    },
    "cwd": {
      "type": "string",
      "description": "Working directory; defaults to the session workspace."
    }
  }
}
```

来源：[`packages/git/tool-git/src/index.ts`](../packages/git/tool-git/src/index.ts)


### `commit_apply`

对已暂存变更执行一个通过校验的拆分提交计划。要求使用 `commit` 产出的计划：每个已暂存文件必须恰好被覆盖一次，锁文件自动归位，hunk 选择对照真实 diff 校验，依赖按拓扑解析（环在任何写入前被拒绝），每个提交按依赖顺序原子创建。在写入任何内容前，可用 `dryRun: true` 预览确切的提交消息。


```json
{
  "type": "object",
  "properties": {
    "commits": {
      "type": "array",
      "description": "Commit groups of the split plan (see commit_apply contract): each has changes [{path, hunks}], type, scope, summary, details, dependencies.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "changes": {
            "type": "array",
            "description": "Files (and optional hunk selectors) this commit covers; paths must name staged files.",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "path": {
                  "type": "string"
                },
                "hunks": {
                  "type": "object",
                  "description": "Which part of the file to commit: all (default), indices (1-based hunk numbers), or lines (new-file line range).",
                  "additionalProperties": false,
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "all",
                        "indices",
                        "lines"
                      ]
                    },
                    "indices": {
                      "type": "array",
                      "items": {
                        "type": "integer"
                      }
                    },
                    "start": {
                      "type": "integer"
                    },
                    "end": {
                      "type": "integer"
                    }
                  },
                  "required": [
                    "type"
                  ]
                }
              },
              "required": [
                "path"
              ]
            }
          },
          "type": {
            "type": "string",
            "description": "Conventional-commit type.",
            "enum": [
              "feat",
              "fix",
              "refactor",
              "docs",
              "test",
              "chore",
              "style",
              "perf",
              "build",
              "ci",
              "revert",
              "deps",
              "security",
              "config",
              "ux",
              "release",
              "hotfix",
              "infra",
              "init",
              "merge",
              "hack",
              "wip"
            ]
          },
          "scope": {
            "type": "string",
            "description": "Optional conventional scope."
          },
          "summary": {
            "type": "string",
            "description": "Imperative summary line, ≤72 chars."
          },
          "details": {
            "type": "array",
            "description": "Optional body bullet lines.",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "text": {
                  "type": "string"
                },
                "userVisible": {
                  "type": "boolean"
                }
              },
              "required": [
                "text"
              ]
            }
          },
          "issueRefs": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "dependencies": {
            "type": "array",
            "description": "Zero-based indices of groups that must commit first.",
            "items": {
              "type": "integer"
            }
          }
        },
        "required": [
          "changes",
          "type",
          "summary"
        ]
      }
    },
    "dryRun": {
      "type": "boolean",
      "description": "Validate and print the exact commit messages without writing anything (default false)."
    },
    "push": {
      "type": "boolean",
      "description": "Push the current branch to `origin` after committing and record upstream tracking (`git push --set-upstream origin <branch>`), so PR flows can consume it. Requires a named branch: on a detached HEAD it fails with guidance (acquire a named-branch slot with `worktree acquire --branch`). Reruns stay no-follow-tags; force is never implied. Default false."
    },
    "cwd": {
      "type": "string",
      "description": "Working directory; defaults to the session workspace."
    }
  }
}
```

来源：[`packages/git/tool-git/src/index.ts`](../packages/git/tool-git/src/index.ts)


### `review`

用专门的评审者 subagent 对 git 变更（工作区、已暂存区或一个提交区间）执行并行代码评审。每条发现按 P0–P3 分级并带置信度分数；工具返回按严重度排序的全部发现，以及带解释的 ship/reject 结论。评审者只读（git diff/log/show、read、grep、ast_grep），从不编辑文件或运行构建。可用 focus 过滤器只评审相关路径。


```json
{
  "type": "object",
  "properties": {
    "target": {
      "type": "string",
      "description": "What to review: working-tree changes vs HEAD (default, includes staged + unstaged), only staged, or a commit range.",
      "enum": [
        "worktree",
        "staged",
        "commits"
      ]
    },
    "range": {
      "type": "string",
      "description": "Commit range like HEAD~3..HEAD when target is commits (both endpoints resolved by git)."
    },
    "focus": {
      "type": "array",
      "description": "Optional subset of paths/prefixes to restrict the review to; other files are skipped.",
      "items": {
        "type": "string"
      }
    },
    "maxReviewers": {
      "type": "integer",
      "description": "Cap on parallel reviewers (default 4); the diff is split into at most this many slices."
    },
    "cwd": {
      "type": "string",
      "description": "Working directory; defaults to the session workspace."
    }
  }
}
```

来源：[`packages/git/tool-git/src/index.ts`](../packages/git/tool-git/src/index.ts)


### `worktree`

管理持久池中带持久租约的隔离按任务 git 工作树（firstmate/treehouse 模型）。`acquire` 切出一个新槽位（`--branch` 用于命名分支 HEAD —— `commit_apply --push` 与 PR 的路径）或复用一个可证明空闲的槽位，返回 `path` ＋ `leaseId`；`release` 归还槽位（除非 `force`，否则拒绝脏工作），且以精确租约 id 为条件；`list` 显示池的实时状态；`prune` 只移除空闲槽位（无 `yes` 时 dry-run）；`destroy` 移除一个槽位（无 `yes` 时 dry-run，除非显式标志否则拒绝租借／脏工作）。在 `lease.path` 下工作——它是同一个仓库的普通 git 工作树；交付前先用 release 归还。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "acquire | release | list | prune | destroy.",
      "enum": [
        "acquire",
        "release",
        "list",
        "prune",
        "destroy"
      ]
    },
    "cwd": {
      "type": "string",
      "description": "Working directory; defaults to the session workspace."
    },
    "branch": {
      "type": "string",
      "description": "acquire only: cut HEAD at a new named branch (for commit_apply --push / PR flows)."
    },
    "base": {
      "type": "string",
      "description": "acquire only: cut from this branch instead of the configured/inferred default."
    },
    "holder": {
      "type": "string",
      "description": "acquire only: lease holder label (default `dsh`)."
    },
    "noFetch": {
      "type": "boolean",
      "description": "acquire only: skip the origin fetch."
    },
    "path": {
      "type": "string",
      "description": "release/destroy: the worktree path from the acquire result."
    },
    "leaseId": {
      "type": "string",
      "description": "release only: the exact lease id from the acquire result."
    },
    "force": {
      "type": "boolean",
      "description": "release only: discard uncommitted changes instead of refusing (git clean -fdqx)."
    },
    "name": {
      "type": "string",
      "description": "destroy only: pool-relative slot name (alternative to path)."
    },
    "yes": {
      "type": "boolean",
      "description": "prune/destroy only: execute instead of dry-running."
    },
    "includeLeased": {
      "type": "boolean",
      "description": "destroy only: allow destroying a slot that is still leased."
    },
    "includeUnlanded": {
      "type": "boolean",
      "description": "destroy only: allow discarding dirty/unmerged work (irreversible)."
    },
    "all": {
      "type": "boolean",
      "description": "prune only: sweep every pool under the configured root."
    }
  },
  "required": [
    "action"
  ]
}
```

来源：[`packages/git/tool-git/src/index.ts`](../packages/git/tool-git/src/index.ts)

模型驱动的 git 提交＋评审：`commit` 分析已暂存 diff 并返回计划骨架与锁文件自动归位提示；`commit_apply` 校验并执行（hunk 感知拆分、依赖顺序、dry-run）；`review` 把已暂存 diff 分发给 subagent 评审者并聚合出 ship/reject 结论。

<a id="deepseek-aidsh-tool-browser"></a>


## `@deepseek-ai/dsh-tool-browser`


### `browser`

通过 Chrome DevTools Protocol 驱动真实浏览器：打开 URL、在标签页内求值 JS、把页面快照为 ARIA ref 树并关闭标签页。三种后端：派生一个带 stealth 补丁的浏览器二进制（app.path）、接入既有 CDP 端点（app.cdp_url）、或经本地 dsh browser relay＋配套扩展驱动用户自己的 Chrome 标签页（app.relay）。ARIA 快照携带 [ref=eN] id，在下一次快照前保持有效；click/type 经由 CSS 选择器仍然可用。截图写为 PNG 路径供模型再读。返回的观察为当前 title、url 与 ref 树，无需截图时优先读取它而非重读页面。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "open navigates, run evaluates `code` in the tab, state returns the current observation, close closes tab(s).",
      "enum": [
        "open",
        "close",
        "run",
        "state"
      ]
    },
    "name": {
      "type": "string",
      "description": "tab id (default 'main') — several tabs can stay open at once"
    },
    "url": {
      "type": "string",
      "description": "URL to open and navigate to (action=open only)"
    },
    "app": {
      "type": "object",
      "description": "Which backend to use; defaults to spawning a stealth-patched browser.",
      "additionalProperties": false,
      "properties": {
        "path": {
          "type": "string",
          "description": "browser binary path to spawn (default resolves a system Chrome/Edge"
        },
        "cdp_url": {
          "type": "string",
          "description": "existing CDP endpoint (http://127.0.0.1:9222) to attach to"
        },
        "relay": {
          "type": "boolean",
          "description": "drive the user's own tabs via the local relay + extension"
        },
        "patch": {
          "type": "boolean",
          "description": "use the CloakBrowser patched Chromium (source-level C++ fingerprint patches; requires the optional `cloakbrowser` peer)"
        }
      }
    },
    "wait_until": {
      "type": "string",
      "description": "Navigation wait condition (default load).",
      "enum": [
        "load",
        "domcontentloaded",
        "networkidle0",
        "networkidle2"
      ]
    },
    "code": {
      "type": "string",
      "description": "JavaScript expression or IIFE body to evaluate in the tab (action=run only)"
    },
    "timeout": {
      "type": "integer",
      "description": "Per-call timeout in seconds (default 30)."
    },
    "all": {
      "type": "boolean",
      "description": "close every tab (action=close only)"
    },
    "kill": {
      "type": "boolean",
      "description": "also kill spawned-app browsers (action=close only)"
    },
    "screenshot": {
      "type": "boolean",
      "description": "write a PNG of the tab to disk and return its path (open/run; uses screenshot_path or a temp file)"
    },
    "screenshot_path": {
      "type": "string",
      "description": "target PNG file for screenshot=yes"
    }
  },
  "required": [
    "action"
  ]
}
```

来源：[`packages/browser/tool-browser/src/index.ts`](../packages/browser/tool-browser/src/index.ts)

Browser tool (port of omp): open/close/run/state over launch (stealth-patched), CDP-attach, or the local relay + extension; observations are ARIA ref trees with click-by-selector, and screenshots write PNG paths.


## `@deepseek-ai/dsh-tool-av`


### `av_catalog`

列出 Automic Vault 认识的工具：检测器（扫描覆盖范围；名称供 `av_scan` 的 `detector` 使用）与加固器（加固状态；名称供 `av_doctor` 的 `tool` 使用），各含文档链接。来自 `av detectors --json` 与 `av hardeners --json` 的只读元数据。

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "description": "Which catalog to return (default both).",
      "enum": [
        "detectors",
        "hardeners",
        "both"
      ]
    },
    "max_entries": {
      "type": "integer",
      "description": "Cap on entries per scope (default 60)."
    }
  }
}
```

Source: [`packages/av/tool-av/src/index.ts`](../packages/av/tool-av/src/index.ts)


### `av_doctor`

校验已安装开发工具的 Automic Vault 加固状态（运行 `av doctor [tool] --json`）：哪些已加固工具健康、哪些有问题，并给出每条 issue 的修复步骤（stub/target 路径）。只读；代理报告，加固由用户运行。先用 `av_catalog` 查看工具名称。

```json
{
  "type": "object",
  "properties": {
    "tool": {
      "type": "string",
      "description": "Hardener/tool name to check (default: all applicable)."
    }
  }
}
```

Source: [`packages/av/tool-av/src/index.ts`](../packages/av/tool-av/src/index.ts)


### `av_list`

列出 Automic Vault 中已保存密钥的名称（`av list`）。只返回**名称**——绝不返回值，绝不释放密钥。用它告知用户保管库中有什么，再由用户决定如何处置。

```json
{
  "type": "object",
  "properties": {}
}
```

Source: [`packages/av/tool-av/src/index.ts`](../packages/av/tool-av/src/index.ts)


### `av_scan`

用 Automic Vault 审计 Mac 上受支持的凭据暴露与安全风险（运行 `av scan --json`）：开发者工具密钥以明文配置、钥匙串或环境助手形式暴露的文件/行，每条 finding 都带说明与修复建议。只读；绝不返回已存储的密钥值。可用 `detector`（来自 `av_catalog` scope=detectors 的名称）收窄，或保留完整审计。向用户报告 finding，并提出文档化的 `av harden <tool>` 式修复——运行加固是在终端中进行的人工决策。

```json
{
  "type": "object",
  "properties": {
    "severity": {
      "type": "string",
      "description": "Only findings at or above this severity (default: all).",
      "enum": [
        "high",
        "medium",
        "low"
      ]
    },
    "detector": {
      "type": "string",
      "description": "Detector name (e.g. gh_cli) to scan only that tool; from `av_catalog` scope=detectors."
    },
    "max_findings": {
      "type": "integer",
      "description": "Cap on returned findings (default 30); remaining findings are summarized."
    }
  }
}
```

Source: [`packages/av/tool-av/src/index.ts`](../packages/av/tool-av/src/index.ts)

只读 Automic Vault 工具：av_scan 审计 Mac 上暴露的开发工具凭据与风险，av_doctor 校验加固，av_catalog 列出检测器/加固器，av_list 仅返回已保存密钥的名称。输出绝不包含 Secret Value，加固始终由用户在终端人工决定。

<a id="deepseek-aidsh-tool-logseq"></a>


## `@deepseek-ai/dsh-tool-logseq`


### `logseq_graph`

图生命周期操作（`logseq graph ...`）：validate、info、export（edn/sqlite 到文件）、import、backup list/create/restore/remove。破坏性操作前先用 export/backup。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "Which graph operation to run.",
      "enum": [
        "validate",
        "info",
        "export",
        "import",
        "backup-list",
        "backup-create",
        "backup-restore",
        "backup-remove"
      ]
    },
    "type": {
      "type": "string",
      "description": "export: output format.",
      "enum": [
        "edn",
        "sqlite"
      ]
    },
    "file": {
      "type": "string",
      "description": "export: output file; import: input file."
    },
    "backupName": {
      "type": "string",
      "description": "backup-create/restore: backup name."
    },
    "fix": {
      "type": "boolean",
      "description": "validate: fix problems."
    }
  }
}
```

Source: [`packages/logseq/tool-logseq/src/index.ts`](../packages/logseq/tool-logseq/src/index.ts)


### `logseq_list`

通过 `logseq list <entity>` CLI 从数据库图列出 Logseq 图实体（页面、标签、属性、任务、节点、资产）。

```json
{
  "type": "object",
  "properties": {
    "entityType": {
      "type": "string",
      "description": "Kind of entity to list.",
      "enum": [
        "page",
        "tag",
        "property",
        "task",
        "node",
        "asset"
      ]
    },
    "limit": {
      "type": "integer",
      "description": "Maximum result count (default: 50)."
    },
    "offset": {
      "type": "integer",
      "description": "Result offset."
    },
    "sort": {
      "type": "string",
      "description": "Sort field (e.g. id, title, updated-at)."
    },
    "order": {
      "type": "string",
      "description": "Sort order.",
      "enum": [
        "asc",
        "desc"
      ]
    },
    "fields": {
      "type": "string",
      "description": "Comma-separated fields to include (id, title, ident, uuid, status, ...)."
    },
    "includeBuiltIn": {
      "type": "boolean",
      "description": "Include built-in/system entries (pages/tags/properties)."
    },
    "journalOnly": {
      "type": "boolean",
      "description": "Pages: only journal pages."
    },
    "includeHidden": {
      "type": "boolean",
      "description": "Pages: include hidden pages."
    },
    "withProperties": {
      "type": "boolean",
      "description": "Tags: include properties data."
    },
    "withExtends": {
      "type": "boolean",
      "description": "Tags: include extends data."
    },
    "taskStatus": {
      "type": "string",
      "description": "Tasks: filter by status (todo/doing/done/...)."
    },
    "taskPriority": {
      "type": "string",
      "description": "Tasks: filter by priority."
    },
    "content": {
      "type": "string",
      "description": "Tasks: content filter; Search: search text."
    }
  }
}
```

Source: [`packages/logseq/tool-logseq/src/index.ts`](../packages/logseq/tool-logseq/src/index.ts)


### `logseq_query`

对图运行 Datascript 查询（`logseq query --query <EDN>`），或按名称运行已保存查询并附可选 inputs。用于页面/块/标签一次跳转答不了的结构性问题。

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Datascript query EDN, e.g. `[:find [?t ...] :where [?b :block/title ?t]]`."
    },
    "name": {
      "type": "string",
      "description": "Saved query name (from `logseq query list`)."
    },
    "inputs": {
      "type": "string",
      "description": "Query inputs EDN, e.g. `[:foo \"value\"]` or `[30]`."
    },
    "limit": {
      "type": "integer",
      "description": "Cap on returned rows (default 20)."
    }
  }
}
```

Source: [`packages/logseq/tool-logseq/src/index.ts`](../packages/logseq/tool-logseq/src/index.ts)


### `logseq_remove`

从图永久删除实体（`logseq remove <entity>`）。删除是真实的——仅在确定时使用；wiki schema 允许时优先用 status/superseded 标记。

```json
{
  "type": "object",
  "properties": {
    "entityType": {
      "type": "string",
      "description": "Kind to remove.",
      "enum": [
        "block",
        "page",
        "tag",
        "property"
      ]
    },
    "id": {
      "type": "integer",
      "description": "Entity db/id."
    },
    "uuid": {
      "type": "string",
      "description": "Entity UUID."
    },
    "page": {
      "type": "string",
      "description": "Page name (for page entity)."
    },
    "name": {
      "type": "string",
      "description": "Tag/property name."
    }
  }
}
```

Source: [`packages/logseq/tool-logseq/src/index.ts`](../packages/logseq/tool-logseq/src/index.ts)


### `logseq_search`

按内容文本搜索 Logseq 块/页面/属性/标签（`logseq search <type> --content <text>`）。返回匹配项。

```json
{
  "type": "object",
  "properties": {
    "entityType": {
      "type": "string",
      "description": "Kind to search.",
      "enum": [
        "block",
        "page",
        "property",
        "tag"
      ]
    },
    "content": {
      "type": "string",
      "description": "Search text."
    },
    "limit": {
      "type": "integer",
      "description": "Cap on returned items (default 50)."
    }
  }
}
```

Source: [`packages/logseq/tool-logseq/src/index.ts`](../packages/logseq/tool-logseq/src/index.ts)


### `logseq_server`

管理 db-worker-node 服务（`logseq server ...`）：list/start/stop/restart/cleanup。无头场景需要它：每张图 start 一次，随后任何读/写工具都不再依赖桌面 App。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "Server operation (default list).",
      "enum": [
        "list",
        "start",
        "stop",
        "restart",
        "cleanup"
      ]
    }
  }
}
```

Source: [`packages/logseq/tool-logseq/src/index.ts`](../packages/logseq/tool-logseq/src/index.ts)


### `logseq_show`

显示块/页面树（`logseq show --page <name>` 或 `--id`/`--uuid`），可选层级：返回 CLI 的人类可读树文本。

```json
{
  "type": "object",
  "properties": {
    "page": {
      "type": "string",
      "description": "Page name to show."
    },
    "id": {
      "type": "integer",
      "description": "Entity db/id to show."
    },
    "uuid": {
      "type": "string",
      "description": "Block/page UUID to show."
    },
    "level": {
      "type": "integer",
      "description": "Tree depth cap."
    },
    "pageHierarchy": {
      "type": "boolean",
      "description": "Include page hierarchy."
    },
    "linkedReferences": {
      "type": "boolean",
      "description": "Include linked references."
    }
  }
}
```

Source: [`packages/logseq/tool-logseq/src/index.ts`](../packages/logseq/tool-logseq/src/index.ts)


### `logseq_upsert`

创建或更新 Logseq 实体（block/page/tag/property/task）。给定 id/uuid 时为更新模式；标签/属性/任务状态是结构化选项，绝不嵌入正文。

```json
{
  "type": "object",
  "properties": {
    "entityType": {
      "type": "string",
      "description": "Kind to upsert.",
      "enum": [
        "block",
        "page",
        "tag",
        "property",
        "task"
      ]
    },
    "id": {
      "type": "integer",
      "description": "Entity db/id (update mode)."
    },
    "uuid": {
      "type": "string",
      "description": "Entity UUID (update mode)."
    },
    "content": {
      "type": "string",
      "description": "block/task content text (required to create)."
    },
    "targetPage": {
      "type": "string",
      "description": "block/task: page to place under."
    },
    "targetId": {
      "type": "integer",
      "description": "block/task: target block id (position anchor)."
    },
    "pos": {
      "type": "string",
      "description": "block/task: insert position.",
      "enum": [
        "first-child",
        "last-child",
        "sibling"
      ]
    },
    "page": {
      "type": "string",
      "description": "page name."
    },
    "name": {
      "type": "string",
      "description": "tag/property name."
    },
    "propertyType": {
      "type": "string",
      "description": "property type.",
      "enum": [
        "default",
        "number",
        "date",
        "checkbox",
        "url"
      ]
    },
    "cardinality": {
      "type": "string",
      "description": "property cardinality.",
      "enum": [
        "one",
        "many"
      ]
    },
    "updateTags": {
      "type": "array",
      "description": "tags to add (page/block).",
      "items": {
        "type": "string"
      }
    },
    "updateProperties": {
      "type": "object",
      "description": "properties map to add/update (page/block).",
      "additionalProperties": true
    },
    "removeTags": {
      "type": "array",
      "description": "tags to remove.",
      "items": {
        "type": "string"
      }
    },
    "removeProperties": {
      "type": "array",
      "description": "property names to remove.",
      "items": {
        "type": "string"
      }
    },
    "status": {
      "type": "string",
      "description": "task status (structured, not in content).",
      "enum": [
        "todo",
        "doing",
        "done",
        "waiting",
        "later",
        "cancelled"
      ]
    },
    "priority": {
      "type": "string",
      "description": "task priority (A/B/C/...)."
    },
    "scheduled": {
      "type": "string",
      "description": "task scheduled date."
    },
    "deadline": {
      "type": "string",
      "description": "task deadline date."
    },
    "restore": {
      "type": "boolean",
      "description": "page: restore recycled page before updating."
    },
    "dryRun": {
      "type": "boolean",
      "description": "Print the exact CLI invocation only; do not write."
    }
  }
}
```

Source: [`packages/logseq/tool-logseq/src/index.ts`](../packages/logseq/tool-logseq/src/index.ts)

图原生的 Logseq CLI 工具（logseq_list/show/search/query/upsert/remove/graph/server），从终端无头驱动 Logseq 数据库图——桌面 MCP 桥接的本地替代方案，补上 Datalog query、删除、一等任务与图生命周期。
<a id="deepseek-aidsh-tool-codebase-memory"></a>


## `@deepseek-ai/dsh-tool-codebase-memory`


### `codebase_delete_project`

从 codebase-memory 图存储删除一个项目的索引。破坏性且永久：图只能通过重新运行 codebase_index_repository 重建。仅用于清理被取代的索引（例如释放磁盘）。

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string",
      "description": "Indexed project name (see codebase_list_projects)."
    }
  }
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)


### `codebase_detect_changes`

检测代码改动及其对已索引项目知识图的影响：把来自基准分支/引用的 git diff 映射到图上，告诉你一次改动会波及哪些符号/路由/集群。编辑前后使用以规划与复盘工作。

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string",
      "description": "Indexed project name (see codebase_list_projects)."
    },
    "scope": {
      "type": "string",
      "description": "Optional scope hint for the analysis."
    },
    "depth": {
      "type": "integer",
      "description": "Impact depth (default 2)."
    },
    "baseBranch": {
      "type": "string",
      "description": "Base branch to diff from (default main)."
    },
    "since": {
      "type": "string",
      "description": "Git ref or tag to compare from, e.g. HEAD~5 or v0.5.0. Diffs <ref>...HEAD."
    }
  }
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)


### `codebase_get_architecture`

从知识图给出项目的高层架构概览：包、服务、依赖，以及对调用/导入图做 Leiden 社区检测得到的 de-facto 模块（含凝聚力与代表性节点）。深入遍历代码前使用，并据此检验重构是否符合真实接缝。可选目录前缀限定分析范围。

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string",
      "description": "Indexed project name (see codebase_list_projects)."
    },
    "path": {
      "type": "string",
      "description": "Optional directory prefix to scope the architecture, e.g. apps/hoa."
    },
    "aspects": {
      "type": "array",
      "description": "Aspects to include: all, overview, structure, dependencies, routes, languages, packages, entry_points, hotspots, boundaries, layers, file_tree, clusters. Omit = all.",
      "items": {
        "type": "string"
      }
    }
  }
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)


### `codebase_get_code_snippet`

读取已索引项目中单个符号的源码——codebase_search_graph 给出的完整限定名，或短函数名。在已知道符号（来自 codebase_search_graph / codebase_trace_path）时，用它替代若干次文件读取 + grep 循环。

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string",
      "description": "Indexed project name (see codebase_list_projects)."
    },
    "qualifiedName": {
      "type": "string",
      "description": "Full qualified_name from codebase_search_graph, or a short function name."
    },
    "includeNeighbors": {
      "type": "boolean",
      "description": "Also render the symbol's structural neighbors."
    }
  }
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)


### `codebase_get_graph_schema`

返回项目知识图中的节点标签与边类型——codebase_query_graph 的 Cypher 与 codebase_search_graph 接受的标签词汇表。

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string",
      "description": "Indexed project name (see codebase_list_projects)."
    }
  }
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)


### `codebase_index_repository`

把仓库索引进 codebase-memory 知识图。需要结构答案（调用者/被调者、路由、架构、跨服务链接）时用它替代临时 grep——文件系统工具要把这些拼出来需要很多次 read/grep 循环。在 daemon 中运行；仓库索引一次即可反复查询。

```json
{
  "type": "object",
  "properties": {
    "repoPath": {
      "type": "string",
      "description": "Path to the repository to index."
    },
    "mode": {
      "type": "string",
      "description": "full (default): all files + similarity/semantic edges. moderate: filtered files + similarity/semantic. fast: filtered files, no similarity/semantic. cross-repo-intelligence: only match routes/channels across already-indexed projects (requires targetProjects).",
      "enum": [
        "full",
        "moderate",
        "fast",
        "cross-repo-intelligence"
      ]
    },
    "targetProjects": {
      "type": "array",
      "description": "Projects to search for cross-repo links (cross-repo-intelligence mode). Use [\"*\"] for all indexed projects.",
      "items": {
        "type": "string"
      }
    },
    "name": {
      "type": "string",
      "description": "Override the derived project name (defaults to the path slug)."
    },
    "persistence": {
      "type": "boolean",
      "description": "Write a compressed artifact to .codebase-memory/graph.db.zst for team sharing."
    }
  }
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)


### `codebase_index_status`

报告项目的索引状态与覆盖率：节点/边数量、新鲜度、跳过与部分解析的文件，以及上次索引运行的日志文件。在信任一个关于近期改动仓库的答案前使用。

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string",
      "description": "Indexed project name (see codebase_list_projects)."
    }
  }
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)


### `codebase_ingest_traces`

把运行时调用 trace 折入已索引项目的知识图，使查询与分析反映观测到的行为而不只是静态结构。接受 {caller, callee, count} 数组并返回接受/导入数量。

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string",
      "description": "Indexed project name (see codebase_list_projects)."
    },
    "traces": {
      "type": "array",
      "description": "Runtime traces to ingest.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "caller": {
            "type": "string"
          },
          "callee": {
            "type": "string"
          },
          "count": {
            "type": "integer"
          }
        },
        "required": [
          "caller",
          "callee",
          "count"
        ]
      }
    }
  }
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)


### `codebase_list_projects`

列出已索引进 codebase-memory 知识图的全部项目（名称、根路径、git 状态）。在其他 codebase_* 工具之前使用，取到目标仓库的标准 `project` 名，再传给其它工具。

```json
{
  "type": "object",
  "properties": {}
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)


### `codebase_manage_adr`

读写已索引项目的架构决策记录。模式：get（列出 ADR）、update（创建/替换一条 ADR）、sections（读取某条 ADR 的指定部分）。用来把承重架构选择持久化到代码旁边。

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string",
      "description": "Indexed project name (see codebase_list_projects)."
    },
    "mode": {
      "type": "string",
      "description": "get: list ADRs; update: create/replace an ADR; sections: read one ADR's sections.",
      "enum": [
        "get",
        "update",
        "sections"
      ]
    },
    "content": {
      "type": "string",
      "description": "Full ADR content for mode=update."
    },
    "sections": {
      "type": "array",
      "description": "Section names to read for mode=sections.",
      "items": {
        "type": "string"
      }
    }
  }
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)


### `codebase_query_graph`

对 codebase-memory 知识图执行原始 Cypher 查询，表达精选工具无法表达的多跳模式、聚合与跨服务分析。响应带 total（返回行数）；图有硬性 10 万行上限，宽泛查询请加 LIMIT。每个 Function/Method 节点还带有 complexity/cognitive/loop/recursion 热点属性。

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string",
      "description": "Indexed project name (see codebase_list_projects)."
    },
    "query": {
      "type": "string",
      "description": "Cypher query, e.g. MATCH (f:Function) WHERE f.transitive_loop_depth >= 3 RETURN f.qualified_name, f.transitive_loop_depth, f.linear_scan_in_loop ORDER BY f.transitive_loop_depth DESC."
    },
    "maxRows": {
      "type": "integer",
      "description": "Optional row cap (default: unlimited up to the 100k ceiling). No offset support — use codebase_search_graph for paged browsing."
    }
  }
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)


### `codebase_search_code`

grep 增强的代码搜索：按文本找匹配，再把匹配丰富进包含它们的函数，按结构重要性排序（定义优先、热门函数其次、测试最后）。模式：compact（默认，签名）、full（带源码）、files（仅文件列表）。需要在单个已索引项目内按字面文本找代码时使用。

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string",
      "description": "Indexed project name (see codebase_list_projects)."
    },
    "pattern": {
      "type": "string",
      "description": "Text pattern to search (grep syntax)."
    },
    "filePattern": {
      "type": "string",
      "description": "Glob to restrict files, e.g. *.go or packages/**/*.ts."
    },
    "pathFilter": {
      "type": "string",
      "description": "Regex filter on result file paths, e.g. ^src/ or \\.(go|ts)$."
    },
    "mode": {
      "type": "string",
      "description": "compact (default): signatures + metadata. full: with source. files: just file list.",
      "enum": [
        "compact",
        "full",
        "files"
      ]
    },
    "context": {
      "type": "integer",
      "description": "Lines of context around each match (grep -C). Only used in compact mode."
    },
    "regex": {
      "type": "boolean",
      "description": "Treat pattern as a regular expression (default literal)."
    },
    "limit": {
      "type": "integer",
      "description": "Max enriched results (default 10; responses carry total_grep_matches/total_results so you can detect truncation and raise limit or narrow path_filter)."
    }
  }
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)


### `codebase_search_graph`

在 codebase-memory 知识图中搜索函数、类、路由与变量。找定义、实现或关系时优先于普通 grep/glob：三种独立模式——query（BM25 全文，带 camelCase 拆分与结构标签加权）、namePattern（符号名的精确正则）、semanticQuery（向量余弦；弥合词汇差距，如搜索 "send" 可找到 "publish"）。以 qn/label/file/lines 与 in/out 度数分组的树行响应。

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string",
      "description": "Indexed project name (see codebase_list_projects)."
    },
    "query": {
      "type": "string",
      "description": "Natural-language or keyword full-text search. Tokens split on whitespace; camelCase identifiers index as individual words. When provided, namePattern is ignored."
    },
    "label": {
      "type": "string",
      "description": "Restrict to one node label, e.g. Function, Method, Route, Class."
    },
    "namePattern": {
      "type": "string",
      "description": "Exact regex over symbol names (ignored when query is provided)."
    },
    "qnPattern": {
      "type": "string",
      "description": "Regex over qualified names."
    },
    "filePattern": {
      "type": "string",
      "description": "Restrict to files matching this substring/glob."
    },
    "relationship": {
      "type": "string",
      "description": "Edge relationship to filter by."
    },
    "minDegree": {
      "type": "integer",
      "description": "Minimum selected degree."
    },
    "maxDegree": {
      "type": "integer",
      "description": "Maximum selected degree."
    },
    "excludeEntryPoints": {
      "type": "boolean",
      "description": "Exclude entry-point symbols."
    },
    "includeConnected": {
      "type": "boolean",
      "description": "Also return connected nodes."
    },
    "semanticQuery": {
      "type": "array",
      "description": "Array of keyword strings (NOT a single string) — each scored via per-keyword min-cosine. Requires moderate/full index mode.",
      "items": {
        "type": "string"
      }
    },
    "limit": {
      "type": "integer",
      "description": "Max results per call (default 50). Response carries total and has_more; page with offset when truncated."
    },
    "offset": {
      "type": "integer",
      "description": "Skip the first N results. Combine with limit to page until has_more is false."
    },
    "format": {
      "type": "string",
      "description": "Response encoding: tree (default) prefix-grouped rows; json the same model as structured JSON.",
      "enum": [
        "tree",
        "json"
      ]
    },
    "fields": {
      "type": "array",
      "description": "Extra per-node property columns, e.g. complexity, cognitive, signature, docstring, return_type, is_test, lines(int). Core columns (qn/label/file/lines/in/out) are always present.",
      "items": {
        "type": "string"
      }
    }
  }
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)


### `codebase_trace_path`

追踪 codebase-memory 知识图中的调用/数据流/跨服务路径。callers/callees（calls 模式）、带参数表达式的值传播（data_flow），或穿过 HTTP/异步路由节点并跨仓库（cross_service）。调用方浮出声明与每条入边。

```json
{
  "type": "object",
  "properties": {
    "project": {
      "type": "string",
      "description": "Indexed project name (see codebase_list_projects)."
    },
    "functionName": {
      "type": "string",
      "description": "Qualified name from codebase_search_graph, or a short function name."
    },
    "direction": {
      "type": "string",
      "description": "Trace direction (default both).",
      "enum": [
        "inbound",
        "outbound",
        "both"
      ]
    },
    "depth": {
      "type": "integer",
      "description": "Hop depth (default 3)."
    },
    "mode": {
      "type": "string",
      "description": "calls: CALLS edges. data_flow: CALLS+DATA_FLOWS with arg expressions. cross_service: HTTP/async routes and CROSS_* cross-repo edges.",
      "enum": [
        "calls",
        "data_flow",
        "cross_service"
      ]
    },
    "parameterName": {
      "type": "string",
      "description": "data_flow mode: scope the trace to one parameter name."
    },
    "edgeTypes": {
      "type": "array",
      "description": "Restrict to specific edge types.",
      "items": {
        "type": "string"
      }
    },
    "riskLabels": {
      "type": "boolean",
      "description": "Add CRITICAL/HIGH/MEDIUM/LOW risk classes by hop distance."
    },
    "includeTests": {
      "type": "boolean",
      "description": "Include test nodes (default excludes them)."
    }
  }
}
```

Source: [`packages/codebase-memory/tool-codebase-memory/src/index.ts`](../packages/codebase-memory/tool-codebase-memory/src/index.ts)

代码智能工具（codebase_list_projects/index_repository/index_status/search_graph/query_graph/trace_path/get_code_snippet/get_graph_schema/get_architecture/search_code/detect_changes/manage_adr/ingest_traces/delete_project），通过 `codebase-memory-mcp cli --json` 模式对本地 codebase-memory daemon 发起一次性查询——stdio MCP 客户端行的本地替代方案，共享同一 daemon、索引、变更锁与索引 supervisor。

<a id="deepseek-aidsh-tool-agentsview"></a>


## `@deepseek-ai/dsh-tool-agentsview`


### `agentsview`

查询本地 agentsview 存档（agentsview CLI 本身就解析 DSH session.jsonl.zstd 日志）：带健康等级与结局信号的会话列表/详情、窗口化工作区统计（stats）、每日 token/成本报告（usage）、单会话成本（sessionUsage）、含语义/混合模式的转录搜索（search）、对蒸馏会话知识的实验性 recall 查询/简报，以及无内容分析导出。读取的是 harness 写出的同一会话存储；首次调用可能同步存档。

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "description": "The agentsview CLI surface to query. `list` = session list (health/outcome columns). `get` = one session metadata + signals. `sessionUsage` = token usage and cost for one session. `health` = recent sessions with grade/outcome, or one session detail when `sessionId` is set. `stats` = window-scoped workspace analytics. `usage` = daily token/cost report. `search` = transcript content search (mode: substring|regex|fts|semantic|hybrid). `recallQuery` = query the distilled recall corpus. `recallBrief` = packed trust-brief for a task. `exportSessions` = content-free session summary export (JSON).",
      "enum": [
        "list",
        "get",
        "sessionUsage",
        "health",
        "stats",
        "usage",
        "search",
        "recallQuery",
        "recallBrief",
        "exportSessions"
      ]
    },
    "sessionId": {
      "type": "string",
      "description": "get/sessionUsage/health-detail: session id (from `list` or export)."
    },
    "query": {
      "type": "string",
      "description": "search/recallQuery/recallBrief: query text or task brief (required for those actions)."
    },
    "mode": {
      "type": "string",
      "description": "search: retrieval mode; default substring. `semantic`/`hybrid` require the vector index to be built (agentsview `embeddings build`).",
      "enum": [
        "substring",
        "regex",
        "fts",
        "semantic",
        "hybrid"
      ]
    },
    "limit": {
      "type": "integer",
      "description": "list/health/search/exportSessions: result cap."
    },
    "project": {
      "type": "string",
      "description": "list/exportSessions: project filter (path or name)."
    },
    "agent": {
      "type": "string",
      "description": "list/stats/usage: agent filter."
    },
    "since": {
      "type": "string",
      "description": "stats/usage: window start (`28d` or `YYYY-MM-DD`); exportSessions: active-on-or-after date (`--date-from`)."
    },
    "until": {
      "type": "string",
      "description": "stats/usage/exportSessions: window end (`YYYY-MM-DD`); exportSessions uses `--date-to`."
    },
    "includeAutomated": {
      "type": "boolean",
      "description": "list: include automated sessions (excluded by default)."
    },
    "includeOneShot": {
      "type": "boolean",
      "description": "list: include one-shot sessions (excluded by default)."
    },
    "includeChildren": {
      "type": "boolean",
      "description": "list: include subagent/child sessions (excluded by default)."
    },
    "ownOnly": {
      "type": "boolean",
      "description": "sessionUsage: exclude subagent transcripts from cost attribution."
    },
    "all": {
      "type": "boolean",
      "description": "usage: scan full history instead of the default 30-day window."
    },
    "breakdown": {
      "type": "boolean",
      "description": "usage: per-model rows and JSON breakdown arrays."
    },
    "excludeSession": {
      "type": "string",
      "description": "search: drop matches from this session before the cap."
    },
    "outcome": {
      "type": "string",
      "description": "exportSessions: comma-separated outcome filter (completed/abandoned/errored/unknown)."
    },
    "healthGrade": {
      "type": "string",
      "description": "exportSessions: comma-separated health grade filter (A..F)."
    },
    "minToolFailures": {
      "type": "integer",
      "description": "exportSessions: minimum tool-failure signal count."
    },
    "cursor": {
      "type": "string",
      "description": "exportSessions: opaque cursor from a previous response for paging."
    },
    "includeProjects": {
      "type": "array",
      "description": "stats: project allowlist (repeatable).",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "action"
  ]
}
```

Source: [`packages/agentsview/tool-agentsview/src/index.ts`](../packages/agentsview/tool-agentsview/src/index.ts)

Session-analytics tool (`agentsview` action=list/get/sessionUsage/health/stats/usage/search/recallQuery/recallBrief/exportSessions) that runs one-shot queries against the local agentsview archive — health grades and outcomes, windowed workspace stats, token-cost reports, fts/semantic/hybrid transcript search, the recall brief, and content-free export — built by the agentsview CLI directly from the DeepSeek Harness session store (it parses session.jsonl.zstd itself), the CLI-first pattern that made tool-codebase-memory viable.

<a id="deepseek-aidsh-tool-openwiki"></a>


## `@deepseek-ai/dsh-tool-openwiki`


### `openwiki_begin`

启动或恢复 OpenWiki 仓库生成。干净更新返回 status=noop，否则返回持久的规划/生成运行状态。无法识别的 `language` 会以 invalid_input 失败，而不是启动一次运行。

```json
{
  "type": "object",
  "properties": {
    "root": {
      "type": "string",
      "description": "Absolute path to any directory inside the target Git repository."
    },
    "mode": {
      "type": "string",
      "description": "init generates a fresh wiki; update refreshes an existing one.",
      "enum": [
        "init",
        "update"
      ]
    },
    "language": {
      "type": "string",
      "description": "BCP-47 documentation language code, e.g. \"ko\" (not \"Korean\"). Omit to keep the existing wiki language."
    },
    "force": {
      "type": "boolean",
      "description": "Bypass update no-op detection."
    }
  },
  "required": [
    "root",
    "mode"
  ]
}
```

Source: [`packages/openwiki/tool-openwiki/src/index.ts`](../packages/openwiki/tool-openwiki/src/index.ts)


### `openwiki_finish`

仅在每个 PageJob 都完成后调用。执行确定性的删除、校验、索引、出处、Claims 收尾与运行元数据持久化。

```json
{
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "description": "Stable run UUID returned by openwiki_begin."
    }
  },
  "required": [
    "runId"
  ]
}
```

Source: [`packages/openwiki/tool-openwiki/src/index.ts`](../packages/openwiki/tool-openwiki/src/index.ts)


### `openwiki_next_page`

返回第一个待办的页面任务及其当前 Claims；无剩余任务时返回 status=complete。

```json
{
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "description": "Stable run UUID returned by openwiki_begin."
    }
  },
  "required": [
    "runId"
  ]
}
```

Source: [`packages/openwiki/tool-openwiki/src/index.ts`](../packages/openwiki/tool-openwiki/src/index.ts)


### `openwiki_submit_page`

在页面 Markdown 写好后，提交该页完整的、以仓库为锚的预期 Claim 集以完成当前任务。保留每个未变既有 Claim 的 id、精确 statement 与证据 resource 值；必要的修订复用其 id；省略即撤消；真正的新 Claim 省略 id。最终页面与 Claim 集必须一致。

```json
{
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "description": "Stable run UUID returned by openwiki_begin."
    },
    "jobId": {
      "type": "string",
      "description": "Current pending job UUID from openwiki_next_page."
    },
    "claims": {
      "type": "array",
      "description": "Complete material Claim set for the finished page.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "id": {
            "type": "string",
            "description": "Existing id to preserve/reuse; omit for a genuinely new Claim."
          },
          "statement": {
            "type": "string"
          },
          "evidence": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "resource": {
                  "type": "string"
                }
              },
              "required": [
                "resource"
              ]
            }
          }
        },
        "required": [
          "statement",
          "evidence"
        ]
      }
    }
  },
  "required": [
    "runId",
    "jobId",
    "claims"
  ]
}
```

Source: [`packages/openwiki/tool-openwiki/src/index.ts`](../packages/openwiki/tool-openwiki/src/index.ts)


### `openwiki_submit_plan`

提交最终规范性页面计划。OpenWiki 会校验它，并在接受前持久化有序的 PageJob 队列。

```json
{
  "type": "object",
  "properties": {
    "runId": {
      "type": "string",
      "description": "Stable run UUID returned by openwiki_begin."
    },
    "pages": {
      "type": "array",
      "description": "Ordered proposed page queue.",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "path": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "purpose": {
            "type": "string"
          },
          "seedPaths": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "relatedPages": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "instructions": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
          "path",
          "title",
          "purpose"
        ]
      }
    },
    "deletePages": {
      "type": "array",
      "description": "Existing generated pages to delete.",
      "items": {
        "type": "string"
      }
    }
  },
  "required": [
    "runId",
    "pages"
  ]
}
```

Source: [`packages/openwiki/tool-openwiki/src/index.ts`](../packages/openwiki/tool-openwiki/src/index.ts)

仓库 wiki 生命周期工具（openwiki_begin/submit_plan/next_page/submit_page/finish）在进程内运行移植的 openwiki 0.4 确定性引擎核心——可恢复的 .run.json 检查点、页面 manifest、带仓库证据解析的 Grounded Claims、OKF 前言修复与索引同步——无需外部 openwiki CLI，并与 codebase-memory 接通以做结构化发现。
