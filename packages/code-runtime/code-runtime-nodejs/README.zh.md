# @deepseek-ai/dsh-code-runtime-nodejs

[English](README.md) | 中文

DeepSeek Harness [代码执行 seam](../code-runtime/README.md) 的一个持久化 JavaScript 后端：`ctx.codeRuntime`，`language: 'typescript'`、`isolation: 'process'`、**`persistent: true`**。它是让 seam 的 `sessionId`/`reset` 字段与 `executionCount` 对 JavaScript 程序变为现实的后端。

每个会话语义由一条常驻的 `node` 子进程运行[自包含内核](./src/runner.ts)（仅 Node 内置模块——无需任何依赖；构建产物中内核位于 `lib/runner.cjs`）。内核保有一个持久的 `state` 对象与进程全局对象，因此一个程序中的值会在下一个程序中保留；每个 cell 以异步函数体运行，顶层 `await` 与 `return` 与 worker-thread 后端如出一辙。工具绑定（`tools.*`）经 NDJSON 线路桥接：程序是 hostile peer，每条入站 frame 都被重新校验，且只做自有属性查找，防止伪造的成员名沿原型链访问未声明的可调用对象。线路契约与 Python 后端逐字节同构，两端宿主驱动保持对称。

## 服务注册

本包默认导出 `NodeJsCodeRuntime`，一个注册 `ctx.codeRuntime` 的 `CodeRuntime` 子类：

```yaml
- id: code-runtime-nodejs
  plugin: '@deepseek-ai/dsh-code-runtime-nodejs'
  config:
    maxWallMs: 600000
```

## 配置

| Key | 默认值 | 含义 |
|---|---|---|
| `nodePath` | `node` | 显式 node 可执行文件路径；默认经 `PATH` 自动发现。 |
| `maxWallMs` | `600000` | 每次运行的墙钟预算；中断按 SIGINT → SIGTERM → SIGKILL 逐级升级（内核无响应时）。上限 `2147483647`（Node 的 `setTimeout` 最大延迟）。 |
| `maxOutputBytes` | `67108864` | 序列化日志、完成值与失败消息的总字节上限（超出报 `'output-limit'`）。 |
| `sessionIdleMs` | `0` | 收割闲置至少这么多毫秒的会话内核（`0` 关闭；丢失内核状态是显式代价）。 |
| `interruptEscalationMs` | `5000` | 发送 SIGINT 后等待多久升级为 SIGTERM，再同样等待后升级为 SIGKILL。 |
| `startupTimeoutMs` | `15000` | 等待引导 `ready` 握手，超时则判定内核启动失败。 |
| `shutdownGraceMs` | `1000` | `exit` frame 之后等待内核退出的宽限期。 |

## 语义

- **会话。** 携带非空 `sessionId` 的运行在该会话的内核中执行；`executionCount` 上报累计次数。`reset: true` 先关闭旧内核，再由全新内核应答，把重置变成修复损坏状态的恢复原语。
- **一次性。** 不含 `sessionId` 时后端为恰好一个程序新建并随后关闭一个内核——与 worker-thread 后端形态一致的一次性行为。
- **持久化。** cell 内 `state` 是长期共享的对象，宽松模式下的赋值（如 `x = 41`）落在进程全局对象上——两者都保留到会话重置或内核退出为止。cell 顶层的 `const`/`let`/`var`/`function`/`class` 声明限定在该 cell 内（异步函数体），与使用顶层 `await` 的 Node REPL 行完全一致，因此需要持久化的定义放在 `state` 或 `globalThis` 上。cell 以可选值完成：`return <json>` 得到无损完成值，无 `return` 则是无值运行；任何无法表示为无损 JSON 的值（循环引用、`BigInt`、函数）都会变成 `'invalid-output'` 失败。
- **预算与失败种类。** 墙钟超时上报 `'timeout'`；请求取消或内核被强杀上报 `'abort'`；抛出的异常与非 JSON 完成值分别上报 `'exception'` 与 `'invalid-output'`；总输出溢出上报 `'output-limit'`；内核自行死亡时经会话注册表的替换并重试路径上报 `'worker-exit'`。它们全部是结果中的字段，绝不会让 `run()` reject。

## 模型体验

间接经由 `dsh-tools` 的 Code Mode——挂载持久后端时，`run_code` 现在暴露可选的 `session`/`reset` 参数（与 worker 后端相同的 `language: 'typescript'` 呈现）：模型可以播种一个会话、在多次调用间保留数据，并以一等成本（一次 reset 调用，而非多次重试）从损坏状态恢复。

## 已知限制与后续工作

- **忙碌的同步 cell 无法被 SIGINT 中断**——`while (true) {}` 会阻塞事件循环，中断处理器无法运行，真正停止它的是宿主的升级梯（SIGTERM 再 SIGKILL，间隔 `interruptEscalationMs`），代价是内核状态。让出事件循环的 cell（定时器、I/O、await 工具调用）会被干净取消，内核得以存活。
- **Consumer 暂未透传每次运行的 `cwd`/`env`**——请求携带时内核会尊重它们，但 `run_code` 目前不传。
- **`undefined` 完成值是无值运行**（与 worker 后端一致）：无 `return` 的程序 resolve 后没有 `value`，不算错误；`return` 一个无法 JSON 化的值才是 `'invalid-output'` 错误。
- **进程隔离，而非安全边界**——模型代码与 bash 同等信任，与 worker 后端一致。

## 开发说明

内核是单文件 [`src/runner.ts`](./src/runner.ts)，只依赖 Node 内置模块，因此可由 tsdown 编译为构建产物中进程实际启动的 CommonJS [`lib/runner.cjs`](./lib/runner.cjs)；开发测试直接启动原始源码（Node 22.18+ / 24+ 可直接运行 erasable TypeScript）。`tests/kernel.spec.ts` 在真实线路驱动单个内核，`tests/provider.spec.ts` 覆盖完整的 seam 契约（真实子进程）。
