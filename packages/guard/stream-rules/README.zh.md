---
description: "行为 guard 插件：项目规则平时保持休眠，直到某条正则匹配实时 token 流，guard 随即中止请求、把规则作为系统提醒注入，并从同一位置重试。"
kind: "package-reference"
---

# stream-rules — 时间旅行流规则

[English](README.md) | 中文

## 概述

该行为 guard 插件让项目规则保持休眠，直到某条正则匹配到实时 token 流，随即中止请求、把规则作为系统提醒注入，并从同一位置重试——把 oh-my-pi 的 Time-Traveling Stream Rules 移植到 harness 的 `guard/` 家族。由于规则仅在实际被违反时才参与 prompt，强制执行不消耗每轮上下文，且能挺过压缩。项目需要硬性约定（不留调试日志、不留 debugger 语句）且不想每轮都为此付费时选用本包。主要成本是被中断的轮次本身：被中止的输出作为普通 interrupted 消息落地、该轮次被重新生成；非中断模式则把匹配折入工具结果或建议性通知。

## 目录

- [工作原理](#how-it-works)
- [规则格式](#rule-format)
- [中断模式](#interrupt-modes)
- [修复被中断的轮次](#repairing-the-interrupted-turn)
- [配置](#configuration)
- [未跟踪范围（未来工作）](#untracked-scope-future-work)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

一个面向 harness 的行为 guard 插件：项目规则平时保持休眠，直到某个正则匹配到**实时 token 流**，guard 随即中止请求、把规则作为系统提醒注入，并从同一位置重试。这是把 `oh-my-pi` 的 Time-Traveling Stream Rules（`TtsrManager` + `TtsrCoordinator`）移植到 harness 的 `guard/` 家族。

由于规则**仅**在实际触发时才参与 prompt，强行执行不消耗任何每轮上下文，且能挺过压缩（compaction）——规则本来就没有进入过请求。

<a id="how-it-works"></a>
## 工作原理

```
token stream (assistant prose / reasoning / tool-call args)
      │
      ▼  session/event `assistant/chunk`
┌─────────────────────┐   condition matches   ┌────────────────────────────┐
│ TtsrManager buffers  ├──────────────────────►│ agent.cancel({kind:'hook'}) │
└─────────────────────┘                        └─────────────┬──────────────┘
                                                             ▼
                        turn ends `aborted` (partial output kept or discarded)
                                                             │
                        ┌────────────────────────────────────┘
                        ▼
      agent.followup(rule as plugin-sourced `user/message` notice)
                        │
                        ▼
       the turn is regenerated with the rule in context (retry from the same
       point: the original prompt is untouched, nothing else is repeated)
```

- **观察流**无需对 LLM 流做手术：guard 在 `session/event` 上监听 `assistant/chunk` 事件（`text-delta`、`reasoning-delta`、`tool-call-delta`），按来源累积各缓冲区。
- **中止**走 loop 自身的取消路径（`agent.cancel({ kind: 'hook', reason })`，inbox 保留），所以被截断的轮次作为普通的 `interrupted` assistant 消息落地——与用户停止完全一致——清理、回放和客户端 UI 都照常工作。
- **重试**使用 `agent.followup(...)`：规则成为插件来源的 `user/message` `notice`（以可折叠卡片展示，摘要命名被执行的规则），driver 从相同上下文重新生成该轮次。
- **非中断**规则（见 `interruptMode`）从不中止：工具调用匹配通过 `tools/post-execute` 的 `additionalContexts` 折入所匹配工具的结果（与 `dsh-repeat-tool-reminder` 使用的通道相同），prose 匹配则在 assistant 消息之后变成一条建议性通知。

<a id="rule-format"></a>
## 规则格式

规则文件是带 YAML frontmatter 块的 Markdown。默认情况下 guard 读取 `<cwd>/.dsh/rules` 下的每个 `**/*.md`（可用 `rulesDir` 覆盖；目录缺失只意味着没有文件规则）。文件规则在每个轮次开始时按 mtime 门控的缓存重新扫描，因此编辑规则会在下一轮生效。

```markdown
---
description: Never leave debug logging behind
globs: ["**/*.ts"]
scope: ["text", "tool:edit(*.ts)", "tool:write(*.ts)"]
condition:
  - console\.log
interruptMode: always
---
Never commit or leave behind `console.log` / `console.debug` calls...
```

| Frontmatter 键 | 含义 |
|---|---|
| `name` | 规则名（默认为文件名主干） |
| `description` | 人类可读的摘要 |
| `globs` | 规则适用的文件 glob（与工具调用参数中的候选文件路径匹配） |
| `condition` | 触发规则的正则表达式模式——`condition: "(?i)todo"` 行内标志会被转换为原生 `RegExp` 标志 |
| `scope` | 规则监视的流（见下文） |
| `interruptMode` | `always` · `prose-only` · `tool-only` · `never`（回退到 `config.interruptMode`） |
| `alwaysApply` | 为兼容而接受；静态的每轮注入尚未实现 |
| `astCondition` | 为兼容而解析；AST 模式匹配尚不受支持——只有 AST 条件的规则会带警告跳过 |

### Scope 记号

- `text` — assistant prose
- `thinking` — 推理文本
- `tool` | `toolcall` — 每个工具调用的参数流
- `tool:<name>` — 某一个工具的参数流（例如 `tool:edit`）
- `tool:<name>(<glob>)` — 某一个工具的参数**以及**对这些参数中文件路径的 glob（例如 `tool:edit(*.ts)`）
- 形似文件 glob 的裸 `condition`（例如 `*.rs`、`**/*.test.ts`）是展开为 `tool:edit(<glob>)` + `tool:write(<glob>)` 并带捕获一切条件的简写。

### 行内规则

规则也可以直接在插件配置中提供：

```yaml
- id: stream-rules
  name: '@deepseek-ai/dsh-stream-rules'
  config:
    rules:
      - name: no-debugger
        content: Never leave a `debugger` statement behind.
        condition: 'debugger\b'
        scope: [text, tool:edit]
```

### 重复门控

`repeatMode: once`（默认）使每条规则每个会话至多触发一次；`repeatMode: gap` 会在规则触发 `repeatGap` 轮后重新武装（默认 10）。注入记录在规则重载后仍然保留，因此编辑文件不会重新武装一条已经触发过的规则。

<a id="interrupt-modes"></a>
## 中断模式

- `always` — 范围内的任何匹配都中止流
- `prose-only` — 只在文本/推理匹配时中止；工具参数匹配变为建议（折入工具结果）
- `tool-only` — 只在工具参数匹配时中止；prose 匹配变为建议性通知
- `never` — 从不中止；每次匹配都是建议性的

<a id="repairing-the-interrupted-turn"></a>
## 修复被中断的轮次

`contextMode` 配置决定对被中止步骤已生成的部分 assistant 输出如何处理：

- `keep`（默认）— `interrupted` assistant 消息保留在转录中，提醒被追加；模型带着自己已中止的输出继续。无需历史手术。
- `discard` — 通过表层重写把被中止步骤的 assistant/工具表层节点替换为提醒，因此重试从干净上下文重新生成。如果重写失败（例如在并发历史变更下），guard 回退到 `keep`，确保重试总会发生。

<a id="configuration"></a>
## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `rulesDir` | `<cwd>/.dsh/rules` | 规则文件目录（绝对路径或相对 cwd 的路径） |
| `rules` | `[]` | 行内规则 |
| `contextMode` | `keep` | 如何修复被中断的轮次 |
| `interruptMode` | `always` | 未声明时的默认中断模式 |
| `repeatMode` | `once` | 重复门控 |
| `repeatGap` | `10` | `repeatMode: gap` 下重新触发间隔的轮数 |

<a id="untracked-scope-future-work"></a>
## 未跟踪范围（未来工作）

- `astCondition` 匹配：harness 的 ast-grep 引擎每次运行都要把二进制拉起来，对流中检查来说太重。可以在不改变中止/重试机制的前提下叠加一个去抖的单次工具调用 AST 检查。
- `alwaysApply` 规则的静态注入（harness 已有常开的 `agent-instructions` 子系统——未来的移植可以把 `alwaysApply` 规则喂给它）。
- 注入规则名的跨会话持久化（目前按会话维护，因此重启后规则可能再次触发）。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 规则按注册顺序匹配；重叠规则需有意排序。
- 守卫只能在提供商发出流式文本后看到；规则后置应用可能截断已经可见的输出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
