# 层叠 guard 家族：stream-rules × repeat-tool-reminder × timeout-policy

[English](guard-policies.md) | 中文

DSH 内置一组小而专一的「guard」插件，分别在回合的三个不同时点塑造代理行为。
本页说明 `stream-rules`、`repeat-tool-reminder` 与 `timeout-policy` 如何**组合成
一个策略栈**——它们挂在不同的扩展点上，因此层叠不会冲突——并给出可直接复制的
参考组合与调优建议。

## 一览

| Guard | 扩展点 | 触发时机 | 动作 | 默认状态 |
| --- | --- | --- | --- | --- |
| `timeout-policy` | `tools/execute` 包装 | 某个声明了 `timeoutMs` 的工具调用超时 | 用结构化的 `TOOL_TIMEOUT` 错误替换结果 | base bundle 已挂载 |
| `repeat-tool-reminder` | `tools/post-execute` | 同一工具连续调用 N 次（默认 `[3, 5, 8]`） | 向上下文补充提醒（不否决调用） | base bundle 已挂载 |
| `stream-rules` | `session/event` 的 `assistant/chunk` + `agent.cancel` | 正则匹配**实时 token 流** | 中止、注入规则、从同一点重试 | base bundle 已挂载 |

回合内时序：`timeout-policy` 包装派发生命周期（`tools/execute`）→
`repeat-tool-reminder` 观察每次完成的调用（`tools/post-execute`）→
`stream-rules` 观察生成本身，命中原样中止部分回合，把规则作为插件来源的提醒注入
后再生成。因此 stream-rules 的重试会像任何一次尝试一样再次经过
timeout/reminder 层。

## 可直接复制的组合

下面三行已经在 base bundle 中以这些精确配置挂载——这个区块是**用于微调的基线**，
不是必须新增的内容。想自定义时，在 base 组合上叠加 patch 层，只重声明你要改的键。

```yaml
- id: timeout-policy
  name: '@deepseek-ai/dsh-tool-call-timeout-policy'

- id: repeat-tool-reminder
  name: '@deepseek-ai/dsh-repeat-tool-reminder'
  config:
    thresholds: [3, 5, 8]        # consecutive repeats that trigger a reminder
    argumentsPreviewChars: 500   # cap on quoted call arguments in the reminder

- id: stream-rules
  name: '@deepseek-ai/dsh-stream-rules'
  config:
    contextMode: keep            # keep rules in context after a match
    interruptMode: always        # always abort+inject+retry on match
    repeatMode: once             # one retry per rule scope per turn
```

## 它们如何组合（而非冲突）

- **超时让 stream-rules 的重试廉价且有界。** 卡住的工具会在 `timeoutMs` 处死亡，
  而不是钉死整回合；再叠加一个匹配反模式的 stream-rule，话痨模型燃烧的是有界的
  重试预算，而不是无界序列。
- **两个提醒层走同一条上下文通道。** `repeat-tool-reminder` 用额外上下文补全
  `tools/post-execute` 决策；`stream-rules` 的非中断命中以同样方式折进所匹配
  工具的结果。模型会看到分层建议——「你连续 3 次 `write`」加上「而且这个文件
  不能超过 N 行」——两个 guard 互不踩踏。
- **作用域各归其位。** `stream-rules` 按仓库生效（工作区下
  `.dsh/rules/**/*.md`，每回合重新扫描）；工具提醒与超时是全局的。把*项目*
  不变量放进 stream-rules，把*交互形态*策略（别反复锤同一个工具、别无界调用）
  放进另外两个。

## 调优

- **stream-rules：** `interruptMode: never` 把它变成纯观测层；`contextMode:
  forget` 重试一次后丢弃规则；`repeatMode: always` 允许一回合内多次触发。
  内联规则（`config.rules`）适合机器生成的策略。
- **repeat-tool-reminder：** 更严 `thresholds: [2, 4, 6]`，更松 `[5, 10]`；
  `include`/`exclude` 是 `*` 通配的工具名谓词（例如 `exclude: [mcp_*]`
  即使未注册该工具也合法）。
- **timeout-policy：** 时限来自工具声明的 `timeoutMs`，没有全局旋钮。想放宽
  内置工具的预算就重声明该工具，或在你自建工具时设置 `timeoutMs`。

## 何时不要用

- `timeout-policy` 只对声明了 `timeoutMs` 且遵守 `exec.signal` 的工具生效；
  没有 signal 的手写工具无法被约束。
- `stream-rules` 匹配*实时*助手流——从不流式输出的纯 `assistant/message`
  它观察不到；这种情况用 `repeat-tool-reminder` 或 `tools/result` 观测。
- 这些 guard 只**观察与塑形**，不做沙箱：文件系统/网络围栏仍属于
  `sandbox` / `sandbox-policy` 家族。
