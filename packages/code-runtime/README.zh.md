# code-runtime/ — 代码执行能力家族

[English](README.md) | 中文

代码执行能力 seam（参见[能力 seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.zh.md)）：运行时 Service Definition，用于对宿主提供的异步绑定执行模型编写的程序，并捕获它打印和返回的内容；可替换的提供方；以及工具注册表的 [Code Mode](../core/tools/README.zh.md) Consumer（`tools: { mode: code }`，即 `run_code` 工具和按所加载运行时 `language` 生成的 SDK）。设计见 [Code Mode Agent Note](../../.agents/notes/implemented/feature/2026-06-15-code-mode.zh.md)。这些全是**产品**包。

| 包 | 职责 | ctx key |
|---|---|---|
| [`code-runtime/`](code-runtime/README.zh.md) | Service Definition 与共享词汇 | `ctx.codeRuntime` |
| [`code-runtime-worker/`](code-runtime-worker-thread/README.zh.md) | Worker 线程后端（`typescript`） | 注册 `ctx.codeRuntime` |
| [`code-runtime-kernels/`](code-runtime-kernels/README.zh.md) | 面向模型的持久化 Python/JavaScript kernels（`run_kernel_code` 工具） | `ctx.tools` + `ctx.systemPrompt` |

提供方在不改变Consumer的情况下注册该服务。子 README 负责语言、隔离和执行预算细节。`code-runtime-kernels`（移植自 oh-my-pi——`port_omp.md` 一级第 1 项）不扩展该 seam：它自行 spawn 长寿命 python3/node 子进程 kernel 并暴露一个工具，完全自包含。

子系统参考——运行请求/结果、绑定命名空间、失败分类体系——见 [docs/subsystems/code-runtime.md](../../docs/subsystems/code-runtime.zh.md)。
