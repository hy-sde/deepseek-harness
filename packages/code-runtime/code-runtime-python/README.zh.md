# @deepseek-ai/dsh-code-runtime-python

[English](README.md) | 中文

DeepSeek Harness [代码执行 seam](../code-runtime/README.md) 的一个持久化 Python 后端：`ctx.codeRuntime`，`language: 'python'`、`isolation: 'process'`、**`persistent: true`**。它是让 seam 的 `sessionId`/`reset` 字段与 `executionCount` 变为现实的后端。

每个会话语义由一条常驻的 `python3` 子进程运行[内嵌、自包含的内核](./src/python-runner.ts)（仅标准库——无需虚拟环境或额外依赖）。内核保有一个持久的命名空间与一个 asyncio 事件循环，因此一个程序中赋的值会在下一个程序中保留，且每个 cell 都支持顶层 `await`。工具绑定（`tools.*`）经 NDJSON 线路桥接，与 worker-thread 后端的传输语义一致：程序是 hostile peer，每条入站 frame 都被重新校验，且只做自有属性查找，防止伪造的成员名沿原型链访问到未声明的可调用对象。

## 服务注册

本包默认导出 `PythonCodeRuntime`，一个注册 `ctx.codeRuntime` 的 `CodeRuntime` 子类：

```yaml
- id: code-runtime-python
  plugin: '@deepseek-ai/dsh-code-runtime-python'
  config:
    maxWallMs: 600000
```

## 配置

| Key | 默认值 | 含义 |
|---|---|---|
| `pythonPath` | `python3` | 显式解释器路径；默认经 `PATH` 自动发现。 |
| `maxWallMs` | `600000` | 每次运行的墙钟预算；中断按 SIGINT → SIGTERM → SIGKILL 逐级升级（内核无响应时）。上限 `2147483647`（Node 的 `setTimeout` 最大延迟）。 |
| `maxOutputBytes` | `67108864` | 序列化日志、完成值与失败消息的总字节上限（超出报 `'output-limit'`）。 |
| `sessionIdleMs` | `0` | 收割闲置至少这么多毫秒的会话内核（`0` 关闭；丢失内核状态是显式代价）。 |
| `interruptEscalationMs` | `5000` | 发送 SIGINT 后等待多久升级为 SIGTERM，再同样等待后升级为 SIGKILL。 |
| `startupTimeoutMs` | `15000` | 等待引导 `ready` 握手，超时则判定内核启动失败。 |
| `shutdownGraceMs` | `1000` | `exit` frame 之后等待内核退出的宽限期。 |

## 语义

- **会话。** 携带非空 `sessionId` 的运行在该会话的内核中执行；`executionCount` 上报累计次数。`reset: true` 先关闭旧内核，再由全新内核应答，把重置变成修复损坏状态的恢复原语。
- **一次性。** 不含 `sessionId` 时后端为恰好一个程序新建并随后关闭一个内核——与 worker-thread 后端形态一致的一次性行为。
- **预算与失败种类。** 墙钟超时上报 `'timeout'`；请求取消或内核被强杀上报 `'abort'`；无法解析的程序、抛出的异常与非 JSON 完成值分别上报 `'exception'` 与 `'invalid-output'`；总输出溢出上报 `'output-limit'`；内核自行死亡时经会话注册表的替换并重试路径上报 `'worker-exit'`。它们全部是结果中的字段，绝不会让 `run()` reject。

## 模型体验

间接经由 `dsh-tools` 的 Code Mode——挂载本后端时，`run_code` 现在暴露可选的 `session`/`reset` 参数：模型可以播种一个会话、在多次调用间保留数据，并以一等成本（一次 reset 调用，而非多次重试）从损坏状态恢复。

## 已知限制与后续工作

- **中断粒度。** 被用户代码吞掉的 SIGINT（或持有 GIL 的 C 扩展）会升级为进程终止并丢失状态；该次运行会在全新内核上重试一次。
- **Consumer 暂未透传每次运行的 `cwd`/`env`**——请求携带时内核会尊重它们，但 `run_code` 目前不传。
- **进程隔离，而非安全边界**——模型代码与 bash 同等信任，与 worker 后端一致。
