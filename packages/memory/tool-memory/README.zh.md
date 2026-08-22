# @deepseek-ai/dsh-tool-memory

[English](README.md) | 中文

**DeepSeek Harness 面向模型的记忆表面**——在宿主 `ctx.memory` 服务之上的五个
工具 `retain`、`recall`、`reflect`、`memory_edit`、`learn`，外加一个
`memory:project` 系统提示区段，**在每次会话开始时重新载入该会话的项目记忆**。
移植自 [@oh-my-pi](https://github.com/oh-my-pi) 编程代理的记忆体系（见
`port_omp.md` 第 4 项）；存储位于 `@deepseek-ai/dsh-memory`。

本包位于**代理平面**：以预设行的方式挂载并解析宿主的 `memory` 服务，自身不
注册任何服务——`standard`/`code` 预设中的行与 `tool-fs`、`tool-ast` 一样松散
排列。

## 五个工具

- `retain` — 存储一条或多条持久事实（用户偏好、项目决策、架构选择），供未来
  会话使用。批量相关事实；条目自理、归一化、去重。
- `recall` — 在银行 + 教训 + 摘要上做相关性排序搜索。返回的 id 可回传给
  `memory_edit`。在回答过往决策或偏好的问题前主动使用。
- `reflect` — 跨多条记忆综合出答案（混合多条，区别于 `recall`）。仅以记忆为
  依据；仓库事实请先验证。
- `memory_edit` — `update`（替换内容/重要性）、`forget`（硬删除）、
  `invalidate`（软作废，可选 `replacement_id`）。教训与摘要条目是只读事实。
- `learn` — 将一条耐久教训（是什么/何时/为何）写入 `learned.md`；写入路径的
  中和会去除提示注入标记与密钥。

## 提示注入

`apply()` 注册
`systemPrompt.section({ name: 'memory:project', order: 150 })`，该区段文本在
每次组装时求值，返回调用会话的项目记忆——`memory_summary.md` + `learned.md`
合并后按 `injectionMaxChars`（默认 16000 字符）首尾截断——项目尚无记忆时返回
`''`。会话身份来自 `context.agent.session.header.cwd`，因此每个项目看到自己的
银行，新进程在第一个回合即可读到既有记忆。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `root` | `<harness home>/memories` | 必须与 `ctx.memory` 行的根一致。 |
| `injectionMaxChars` | `16000` | 注入摘要 + 教训的合并字符预算。 |
| `enabled` | `true` | 设为 `false` 关闭提示注入但保留工具。 |

## 测试

```sh
pnpm vitest run packages/memory/tool-memory
```
