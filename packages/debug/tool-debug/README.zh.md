---
description: "DSH DAP 能力缝之上的模型 `debug` 工具：一个工具、28 个操作，可启动/附加适配器、设置断点、单步、求值、读写内存等。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-debug

[English](README.md) | 中文

## 概述

`dsh-tool-debug` 通过 DSH DAP 能力缝（`ctx.dap`）暴露面向模型的 `debug` 工具：一个工具、28 个操作，覆盖 launch/attach、断点、continue/pause/step、线程与栈帧、变量与求值、内存、模块、自定义请求、输出与终止。当 agent 需要调试真实进程或交互式驱动调试器时使用它。它以 `tool-debug` 插件行挂载，注入 `['tools', 'dap', 'systemPrompt']`，需要会话工作区 cwd，且不是并发安全的——调试会话互斥，每个 agent 同一时刻只有一个活动会话。边界：不建模控制台交互，harness 本身不隧道转发调试器端口。

## 目录

- [插件](#plugin)
- [行为说明](#behavior-notes)
- [测试](#testing)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

面向 DSH DAP 能力缝（`ctx.dap`）的模型 `debug` 工具：一个工具、28 个操作——launch/attach、源码/函数/指令/数据断点、continue/pause/step、threads/stack_trace/scopes/variables/evaluate、disassemble、read_memory/write_memory、modules、loaded_sources、custom_request、output、terminate、sessions。

移植自 [oh-my-pi](https://github.com/oh-my-pi/oh-my-pi) 的 `coding-agent/src/tools/debug.ts`（MIT），并重做到了 DSH 工具契约（`ctx.tools` + `ctx.dap` + `ctx.systemPrompt`）之上。

<a id="plugin"></a>
## 插件

- `name`：`tool-debug`，`inject`：`['tools', 'dap', 'systemPrompt']`
- 配置：`maxResultChars`（16000）、`requestTimeoutSec`（30）、`timeoutMs`（120000，由 `dsh-tool-call-timeout-policy` 强制）。
- 需要会话工作区 cwd（`exec.agent.session.header.cwd`），且不是并发安全的：调试会话互斥。

<a id="behavior-notes"></a>
## 行为说明

- 单一活动会话：再次 launch/attach 前，活动会话必须已终止（或已终止/退出）。
- 路径按会话工作区解析；每次调用可用 `cwd` 覆盖。
- 请求内超时经由合并的 `AbortSignal`（调用 + 超时）中止。
- 适配器选择错误会指出缺失的适配器与安装命令。
- 断点变更按会话串行化，并且（对 js-debug 会话树）会传播到树中的每个活动会话。

<a id="testing"></a>
## 测试

`pnpm --filter @deepseek-ai/dsh-tool-debug test`（vitest）覆盖参数解析、渲染，以及经由脚本化 DAP 适配器的端到端 launch/断点/单步/求值流程。

<a id="model-experience"></a>
## 模型体验

间接地，经由 `ctx.dap` 能力缝，本工具把它的会话快照渲染成 launch、断点、单步、栈与求值结果。

#### KV 缓存效果

插件激活期间前缀稳定：工具 schema 与引导在运行中从不改变，因此先前调用的前缀仍可复用。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **会话互斥** —— 由于缝串行化断点变更，同一时刻每个 agent 只有一个活动调试会话；跨文件并发调试暂缓。
- **不建模控制台交互** —— 启动参数静态传入；尚未暴露可交互的 stdin/stdout 被调试进程控制台，只有捕获输出。
- **无尸检附加辅助** —— 未封装核心转储分析与基于预加载的附加（dlv `--headless` 模式）；基于端口的情形可用原始 `attach`。
- **远程目标** —— 跨主机附加需要能讲 socket/tcp 的适配器；harness 本身不隧道转发调试器端口。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
