---
description: "面向 DeepSeek Harness 的调试适配器协议（DAP）能力缝：适配器解析加一个会话管理器，可启动并驱动 debugpy、lldb-dap、gdb、dlv 等调试器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-dap

[English](README.md) | 中文

## 概述

`dsh-dap` 提供调试适配器协议（DAP）能力缝（`ctx.dap`）：适配器解析加一个会话管理器，可启动/附加派生的 DAP 适配器，并驱动断点、单步、线程与栈帧、变量、求值、内存读写、反汇编、模块与已加载源、程序输出与会话终止。由于 DAP 适配器是拥有被调试进程的本地二进制，本包既是服务定义又是 provider，因此不存在远程 provider 缝。当组合需要真实调试器集成时选择它；面向模型的表面属于 `@deepseek-ai/dsh-tool-debug`。主要边界是环境性的：适配器可用性取决于安装了哪些调试器，来宾以经清洗的环境启动、从不继承机密。

## 目录

- [缝（Seam）](#the-seam)
- [适配器与配置](#adapters-and-config)
- [环境说明](#environment-note)
- [连接模式](#connection-modes)
- [测试](#testing)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

面向 DeepSeek Harness 的调试适配器协议（DAP）能力缝（`ctx.dap`）——适配器解析加一个会话管理器：通过所派生的 DAP 适配器（debugpy、lldb-dap、gdb、dlv 等）启动/附加、设置源码/函数/指令/数据断点、继续、暂停、单步、列出线程与栈帧、读取作用域与变量、求值表达式、读写内存、反汇编、列出模块/已加载源、捕获程序输出，并终止调试会话。

移植自 [oh-my-pi](https://github.com/oh-my-pi/oh-my-pi) 的 `coding-agent/src/dap/*`（MIT），并适配到 DSH 的子进程与 node:net 桥接。

<a id="the-seam"></a>
## 缝（Seam）

`ctx.dap` 是每个挂载会话上一个服务实例（agent 预设把它挂进一个隔离的 `debug` realm，类似 LSP 的 `lsp-query` —— 见 `apps/cli/config/agent-presets/cordis/agent.cordis.yml`）。与 LSP 缝不同，provider 不可能是远程的：DAP 适配器是拥有被调试进程的本地二进制，因此本包既是服务定义又是 provider。面向模型的表面属于 [`@deepseek-ai/dsh-tool-debug`](../tool-debug)。

<a id="adapters-and-config"></a>
## 适配器与配置

- 内置适配器表（debugpy、gdb、lldb-dap、dlv、js-debug-adapter、netcoredbg、rdbg、php/bash/dart/kotlin/elixir 调试器）：见 `DEFAULT_ADAPTERS`。
- `dap.json`（内容严格为 JSON 时才可用 `dap.yaml`）中的按工作区与按用户覆盖层：工作区 `dap.json`，然后 `$DSH_HOME|~/.dsh/dap.json`，再 `~/dap.json`。后源优先。
- 启动适配器按扩展名、再按根标记自动选择；附加按端口时优先已安装适配器（debugpy 最优先）。

<a id="environment-note"></a>
## 环境说明

适配器以经清洗的父环境外加 `NON_INTERACTIVE_ENV` 覆盖项（无分页器/编辑器/提示）启动。需要凭据的来宾必须显式传入——它们永远不会继承 DSH 机密。

<a id="connection-modes"></a>
## 连接模式

- `stdio`（默认）：debugpy、gdb `-i dap`、lldb-dap …
- `socket`：Delve（`dlv dap`）——Linux 上为 unix socket，macOS/其他平台为拨号回连。
- `tcp`：js-debug-adapter（`${port}` 被替换进 `args`）。

<a id="testing"></a>
## 测试

用 `pnpm --filter @deepseek-ai/dsh-dap test`（vitest）运行包测试。测试套件驱动一个脚本化适配器进程——无需系统调试器——另加一层框架/保真单元测试和一个门控的 debugpy 实机往返。

<a id="model-experience"></a>
## 模型体验

间接地，经由 `dsh-tool-debug` 消费方，它拥有面向模型的工具 schema，并渲染模型读取的每条会话快照。

#### KV 缓存效果

前缀稳定：本包不拥有任何引导文本，因此只安全地改动服务表面不会影响模型可见前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **适配器可用性取决于环境** —— 解析结果取决于安装了哪些调试器（debugpy/lldb-dap/gdb/dlv …）；缺失的适配器会连同安装命令一起报告，绝不自动安装。
- **无远程 provider** —— DAP 适配器必须是本地二进制；远程端口适配器通过主机侧转发访问，而非远程 provider 缝。
- **YAML 配置为 v1 仅 JSON** —— `dap.yaml` 只解析严格 JSON 内容；更丰富的 YAML（锚点、合并键）留待后续配置历程。
- **从不继承凭据** —— 需要密文的来宾必须显式提供；清洗环境是有意为之，但可能让假定完整用户环境的适配器出问题。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
