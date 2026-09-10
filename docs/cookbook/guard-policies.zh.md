# 层叠 guard 家族：repeat-tool-reminder × timeout-policy

[English](guard-policies.md) | 中文

DSH 内置一组小而专一的「guard」插件，分别在回合的不同时点塑造代理行为。本页说明 `repeat-tool-reminder` 与 `timeout-policy` 如何**组合成一个策略栈**——它们挂在不同的扩展点上，因此层叠不会冲突——并给出可直接复制的参考组合与调优建议。

## 一览

| Guard | 扩展点 | 触发时机 | 动作 | 默认状态 |
| --- | --- | --- | --- | --- |
| `timeout-policy` | `tools/execute` 包装 | 某个声明了 `timeoutMs` 的工具调用超时 | 用结构化的 `TOOL_TIMEOUT` 错误替换结果 | base bundle 已挂载 |
| `repeat-tool-reminder` | `tools/post-execute` | 同一工具连续调用 N 次（默认 `[3, 5, 8]`） | 向上下文补充提醒（不否决调用） | base bundle 已挂载 |

回合内时序：`timeout-policy` 包装派发生命周期（`tools/execute`）→`repeat-tool-reminder` 观察每次完成的调用（`tools/post-execute`）。卡住的调用先在超时处死亡；重复调用反模式则在该次调用返回后立刻被拦截。

## 可直接复制的组合

下面两行已经在 base bundle 中以这些精确配置挂载——这个区块是**用于微调的基线**，不是必须新增的内容。想自定义时，在 base 组合上叠加 patch 层，只重声明你要改的键。

```yaml
- id: timeout-policy
  name: '@deepseek-ai/dsh-tool-call-timeout-policy'

- id: repeat-tool-reminder
  name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # consecutive repeats that trigger a reminder
    argumentsPreviewChars: 500   # cap on quoted call arguments in the reminder
```

## 它们如何组合（而非冲突）

- **超时让提醒层的重试廉价且有界。** 卡死的工具会在 `timeoutMs` 处死亡，而不是钉死整回合；撑过超时的搅动式调用随后被提醒层接住，模型燃烧的是有界的重试预算，而不是无界序列。
- **两个 guard 都走工具调用管线。** `repeat-tool-reminder` 用额外上下文补全 `tools/post-execute` 决策；`timeout-policy` 用结构化错误替换卡死调用的结果。模型会看到分层建议——「你连续 3 次 `write`」——而死掉的调用不会悄悄拉长回合。
- **作用域各归其位。** 超时跟随每个工具自己的 `timeoutMs` 声明；提醒使用通配的工具名谓词。把*交互形态*策略（别反复锤同一个工具、别无界调用）放在这里。

## 调优

- **repeat-tool-reminder：** 更严 `thresholds: [2, 4, 6]`，更松 `[5, 10]`；`include`/`exclude` 是 `*` 通配的工具名谓词（例如 `exclude: [mcp_*]` 即使未注册该工具也合法）。
- **timeout-policy：** 时限来自工具声明的 `timeoutMs`，没有全局旋钮。想放宽内置工具的预算就重声明该工具，或在你自建工具时设置 `timeoutMs`。

## 何时不要用

- `timeout-policy` 只对声明了 `timeoutMs` 且遵守 `exec.signal` 的工具生效；没有 signal 的手写工具无法被约束。
- `repeat-tool-reminder` 观察已完成的调用，不观察 token 流；既不流式、又不重复调用的不合意输出，两个 guard 都抓不到——请改用逐工具或逐步骤策略。
- 这些 guard 只**观察与塑形**，不做沙箱：文件系统/网络围栏仍属于 `sandbox` / `sandbox-policy` 家族。
