---
description: "为 DeepSeek Harness 提供持久化 Python 与 JavaScript 内核的自包含插件，给模型一等公民的 run_kernel_code 工具并保留跨调用会话状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-code-runtime-kernels

[English](README.md) | 中文

## 概述

`dsh-code-runtime-kernels` 为模型提供 `run_kernel_code` 工具，由跨调用保留会话状态的持久化 Python 与 JavaScript 内核支撑，以普通 Cordis 插件行挂载。当计算需要中间结果时用它替代草稿文件：相关调用共享同一 `session` id，一次性计算省略 `session`，会话状态损坏时传 `reset: true`。两个长寿命子进程运行自包含 runner（Python 仅标准库；Node 仅内置），共享同一个 host 驱动，并有可配置预算与中断升级。主要边界是 kernel 代码拥有 bash 级信任——这是为健壮性做的进程隔离，而非安全边界。

## 目录

- [挂载](#mounting)
- [配置](#config)
- [工具面](#tool-surface)
- [语义](#semantics)
- [开发](#development)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

为 DeepSeek Harness 提供**持久化 Python 与 JavaScript 内核**——一个自包含插件，给模型一个一等公民的 `run_kernel_code` 工具，跨调用保留会话状态。无需改动上游 Harness：它以普通 Cordis 插件行（通过 `cordis.patch.yml`）挂载，并在 `ctx.tools` 上注册一个工具，与内置工具完全一致。

两个长期存活的 kernel 子进程共享同一个 host 驱动：

- **Python** —— 一个长寿命 `python3` 子进程，运行[自包含内核](./src/python/runner.ts)（仅标准库，无需 venv/pip）。模块级变量与一个 asyncio 事件循环跨 cell 保留；支持顶层 `await`；最后一个表达式即 cell 的值。
- **JavaScript** —— 一个长寿命 `node` 子进程，运行[自包含内核](./src/nodejs/runner.ts)（仅 Node 内置）。持久 `state` 对象与进程全局对象携带跨 cell 的值；每个 cell 以 async 函数体运行，支持顶层 `await`/`return`；`return <json>` 携带完成值。

线上协议、kernel host 驱动（spawn + 握手、串行写入、敌对对端解析、SIGINT→SIGTERM→SIGKILL 升级、退出握手）、会话注册表、绑定校验与输出账本全部共享（`src/core/`），两个语言的语义完全一致。

这是**进程隔离，而非安全边界**：程序源码拥有与内置 `process` 隔离后端相同的 bash 级信任。驱动的职责是健壮性——伪造帧不会弄崩 host，无响应的 kernel 会被逐步升级到终止——而非隔离。

<a id="mounting"></a>
## 挂载

在任意 `cordis.yml` 中添加 bundle 行（或类似行）：

```yaml
- insert:
    - id: code-runtime-kernels
      name: '@deepseek-ai/dsh-code-runtime-kernels'
      config:
        languages: ['python', 'typescript']
        maxWallMs: 600000
        maxOutputBytes: 67108864
        sessionIdleMs: 0
        interruptEscalationMs: 5000
        startupTimeoutMs: 15000
        shutdownGraceMs: 1000
        toolTimeoutMs: 30000
```

所有行 id 带 `code-runtime-kernels-` 前缀以避免与内置行冲突（重复的 loader id 会导致启动失败）。随后模型即看到 `run_kernel_code` 工具。

<a id="config"></a>
## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `languages` | `['python', 'typescript']` | 启用的语言；调用未启用语言会被拒绝。 |
| `pythonPath` | `python3` | 显式 python 可执行文件（默认走 PATH 发现；缺失时首次 spawn 即失败）。 |
| `nodePath` | `node` | 显式 node 可执行文件（默认走 PATH 发现）。 |
| `toolTimeoutMs` | `30000` | 协作式工具调用超时（`exec.signal` 变为每次运行的 abort 源）。 |
| `maxWallMs` | `600000` | 每次运行的墙钟预算；中断按 SIGINT→SIGTERM→SIGKILL 升级。 |
| `maxOutputBytes` | `67108864` | 日志、完成值与失败消息合并后的字节上限（触发 `'output-limit'`）。 |
| `sessionIdleMs` | `0` | 空闲超过该毫秒数的会话被回收（`0` 禁用；状态丢失是显式代价）。 |
| `interruptEscalationMs` | `5000` | SIGINT 后等待再发 SIGTERM，再等同样时长发 SIGKILL。 |
| `startupTimeoutMs` | `15000` | 等待启动 `ready` 握手，超时判失败；子进程在握手前退出则立即以退出码判失败。 |
| `shutdownGraceMs` | `1000` | `exit` 帧后等待 kernel 退出的宽限期。 |
| `snapshot` | `true` | 命名空间持久化：每次成功运行后写快照，新 kernel 首次运行时恢复一次。`false` 禁用。 |
| `snapshotDir` | `~/.dsh/code-runtime-kernels/state` | 快照根目录；文件位于 `<language>/<session-id 哈希>.snapshot`。 |
| `snapshotMaxBytes` | `134217728` | 单个快照文件的合并字节上限；超限条目按名跳过。 |
| `snapshotMaxEntryBytes` | `8388608` | 单条目字节上限；超过该大小的条目被跳过并按名报告。 |
| `sandboxConfinement` | `false` | 经 sandbox seam（结构化 `confine` 能力，见 `@deepseek-ai/dsh-sandbox` 的 `SandboxProvider`）启动 kernel 子进程，而非直接 spawn 解释器。 |
| `sandboxProvider` | — | 约束能力；`sandboxConfinement: true` 时必填（fail closed）。 |
| `sandboxWorkspaceRoot` | `process.cwd()` | `workspace-write` 约束下的可写根目录。 |
| `sandboxMode` | `'workspace-write'` | 受约束 kernel 的文件副作用模式（`'read-only'` 或 `'workspace-write'`）。 |

<a id="tool-surface"></a>
## 工具面

`run_kernel_code` 参数：

| 参数 | 含义 |
|---|---|
| `language` | `python` 或 `typescript`。 |
| `code` | 程序源码，作为 async 函数体执行（可用顶层 `await`/`return`）。 |
| `session` | 可选非空 id；相同 id 的调用共享 kernel 状态。省略则为一次性运行。 |
| `reset` | 本次运行前丢弃该会话的旧 kernel 状态（一次 reset 胜过无尽重试）。 |

返回 seam 的结果信封——`value`（JSON 完成值）、`logs`、`executionCount` 与 `error { kind, message }`——错误词汇与内置 `run_code` 一致（`exception` / `timeout` / `abort` / `worker-exit` / `invalid-output` / `output-limit`），但带有本插件自有的持久会话字段（`session`、`reset`、`executionCount`）。

<a id="semantics"></a>
## 语义

- **会话**。带非空 `session` 的调用运行于该会话的 kernel；`executionCount` 报告累计次数。`reset: true` 先关旧 kernel 再开新 kernel 响应。
- **一次性**。没有 `session` 时，spawn 一个新 kernel，恰好运行一个程序后关闭。
- **持久化**。Python：模块级变量与循环状态跨 cell 保留。JavaScript：`state`（长寿命共享对象）与 sloppy 全局赋值跨 cell 保留；cell 顶层的 `const`/`let`/`function`/`class` 是每 cell 作用域（async 函数体），持久定义请放 `state`。cell 以 `return <json>` 携带完成值，或以无 `return` 结束为无值运行；非 lossless JSON 完成值（环、`BigInt`、集合）判为 `'invalid-output'`。
- **快照**。每次成功运行后保存命名空间（Python：`pickle` + 字节码用 `marshal`，按名报告丢失；JavaScript：V8 二进制序列化，`Map`/`Set`/`Date`/环引用可存活，但值中含函数的键整键按名丢弃）。该会话的新 kernel 对最后一份快照只恢复一次——恢复运行的日志带 `[dsh-kernels] restored N names from snapshot (could not restore: …)`。`reset: true` 先删除快照，被丢弃的状态绝不会复活。Python 字节码依赖 `marshal` 格式：跨 Python 次版本升级恢复时，函数/类条目应预期丢失（在通知中按名报告），数据不受影响。
- **预算与失败种类**。墙钟超时 → `'timeout'`；取消或被迫终止 → `'abort'`；抛异常 → `'exception'`；非 JSON 完成 → `'invalid-output'`；合并输出溢出 → `'output-limit'`；kernel 死亡 → 会话注册表替换 kernel 并重试一次。全部是结果字段，绝不会 reject 工具调用。
- **输出溢出恢复**。运行溢出 `maxOutputBytes`（`'output-limit'` 失败）时，工具调用 `ctx.spillStore.saveText()` 保存完整的捕获输出（日志加溢出的完成值），成功后（已加载 `spillStore` 后端且有会话属主）在失败消息后追加 `full program output preserved at <retrieval-hint>`，让溢出尾部可恢复而非被丢弃。spill 失败是最佳努力：绝不会让调用失败或改变截断后的结果。
- **约束**。`sandboxConfinement: true` 时，每次 kernel spawn 的完整 argv（解释器 + 参数 + 落地 runner）先经 `sandboxProvider.confine(argv, { mode, workspaceRoot })` 包装——即 sandbox seam 的结构化 confine 能力——包装后的 argv 成为进程组组长，中断升级阶梯经其逐级展开。约束是进程级文件副作用强制，不是安全边界。受约束 kernel 无法写 `sandboxWorkspaceRoot` 之外，因此 `snapshotDir` 必须位于其下（构造时校验；命名空间为临时性时可禁用 `snapshot`）。

<a id="development"></a>
## 开发

`pnpm check`（tsc）、`pnpm test`（vitest，真实 `python3`/`node` 子进程）、根 `tsdown` 导出（lib/）。布局：共享 host 驱动在 [`src/core/`](./src/core/)（协议、kernel host、会话注册表、账本），各语言在 [`src/python/runner.ts`](./src/python/runner.ts)（内嵌源码，每次 spawn 落地为临时 `.py`）与 [`src/nodejs/runner.ts`](./src/nodejs/runner.ts)（编译产物，`node --no-warnings` 启动），插件与工具在 [`src/index.ts`](./src/index.ts)。测试：[`tests/kernels.spec.ts`](./tests/kernels.spec.ts) 通过 `KernelManager` 驱动双内核；[`tests/snapshot.spec.ts`](./tests/snapshot.spec.ts) 固定命名空间持久化；[`tests/confinement.spec.ts`](./tests/confinement.spec.ts) 固定 sandbox seam 的 confine 包装及其 fail-closed 配置；[`tests/startup.spec.ts`](./tests/startup.spec.ts) 固定 kernel 提前退出的快速失败；[`tests/tool.spec.ts`](./tests/tool.spec.ts) 在真实 Cordis 上下文挂载插件并经 `ctx.tools.execute` 执行 `run_kernel_code`。

<a id="model-experience"></a>
## 模型体验

### 系统提示

#### 模型所见

本插件注册一个系统提示区块 `tool:code-runtime-kernels`（order 106）：计算且含中间结果时优先 `run_kernel_code` 而非读写草稿文件；复用同一 `session` id 携带状态；一次性计算省略 `session`；会话状态损坏或不需要时传 `reset: true`。

##### run_kernel_code 指南

```markdown
Prefer run_kernel_code to reading/writing scratch files when the work is computation with intermediate results — sessions keep kernel state (variables, imports, working data) across calls, AND snapshot it to disk after every successful run, so state survives a kernel crash or restart (the first run after a restore reports what was restored and what could not be). Omit `session` for one-off computations; give related calls the same `session` id to carry state forward, and pass `reset: true` when the session's state is corrupted or unwanted. Python programs persist module-level variables and functions; JavaScript programs persist via `state` and top-level assignments. A session reaps idle kernels after the configured timeout; a reaped session resumes from its snapshot on the next call with the same id.
```

#### Token 影响

插件激活期间每次请求的固定引导成本。

#### KV Cache 影响

插件作用域与引导文本不变时前缀稳定；激活或销毁可能使本区块的复用失效。

### 工具 schema

#### 模型所见

生成的 [`run_kernel_code` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-code-runtime-kernels)。`language` 与 `code` 必填；`session`（非空 id）跨调用携带状态；`reset` 在本次运行前丢弃该会话的旧 kernel 状态。

#### Token 影响

启用期间每次请求的固定 schema 成本；`toolTimeoutMs` 预算不会发送给模型。

#### KV Cache 影响

可见工具定义与顺序不变时前缀稳定；注册生命周期变化可能使自首个变更 schema token 起的复用失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- **繁忙的同步 cell 对 SIGINT 无响应。** `while (true) {}`/`while True:` 循环永不把控制权交还事件循环，因此中断处理器无法运行，真正停住它的是升级阶梯（SIGTERM 再 SIGKILL）——代价是 kernel 状态，因而也是会话。能让出控制权的 cell（对定时器／I/O／工具调用的异步 `await`）可干净取消，kernel 得以存活（墙钟/超时测试覆盖了这一分化）。
- **状态可能被污染。** 有缺陷的程序随时可能破坏会话状态；`reset: true` 是预期的恢复原语（它同时删除快照，被污染的状态无法回来）。
- **不是安全边界。** kernel 代码拥有与 bash 同等的信任，与该 harness 自身的进程后端一致——快照文件同样如此（`pickle`/`marshal` 不可安全读取不可信输入）。请保持 `snapshotDir` 仅用户可读写；被植入的快照会以宿主身份执行。
- **快照粒度按名。** Python：数据、模块、可按引用导入的调用对象、`__main__` 中定义的函数/类按值保存；用户类实例、对不可 pickle 项的闭包引用、超上限的条目在下一次恢复时按名报告丢失。JavaScript：`state` 与 sloppy 全局赋值按键保存；值中任意位置出现函数即丢弃整个键（按名报告）。
- **快照并非零成本。** 每次成功运行都要 pickle/序列化并写出命名空间。命名空间越大延迟越高；可调 `snapshotMaxBytes`/`snapshotMaxEntryBytes`，状态为临时性时用 `snapshot: false` 禁用。
- **空闲 kernel 占用一个进程。** 在 `sessionIdleMs: 0`（默认）下，会话 kernel 会一直存活到 reset 或插件销毁；被回收的会话在下次同 id 调用时从快照恢复。
- **约束把快照绑定到工作区。** 受约束 kernel 无法写 `sandboxWorkspaceRoot` 之外，因此 `snapshotDir` 必须位于其下（构造时校验；命名空间为临时性时可禁用 `snapshot`）。约束是进程级文件副作用强制，不是安全边界——模型代码仍以你的用户身份运行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
