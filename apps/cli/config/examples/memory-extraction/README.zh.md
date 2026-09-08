# 自动记忆提取（可选启用）

[English](README.md) | 中文

在对话历史被压缩的同一检查点，自动从用户实际说过的话中提取持久事实。每次
`compaction/summary` 事件后，`@deepseek-ai/dsh-memory-extraction` 运行一个有
界、失败开放的流水线，把结果写入 `retain`/`learn` 使用的同一个项目记忆库 ——
对 DSH 显式记忆能力是叠加而非替代。

## 应用补丁

```sh
dsh web --patch apps/cli/config/examples/memory-extraction/cordis.yml
```

补丁必须在基础组合之后加载（与
[`../graph/cordis.yml`](../graph/cordis.yml) 相同的约定）。它添加一个承载
提取运行时的主机行，以及控制单元所在的 sqlite 存储后端。

## 行为

1. **观察**每个会话的 `compaction/summary` 事件（无作用域的主机监听器；按
   会话串行执行；默认排除子代理/子会话）。
2. **投影证据** —— 仅检查点范围内*用户撰写*的文本（助手文本仅作解读上下文，
   工具调用/结果/检查点保持不透明），有界且失败关闭：无法容纳证据预算的
   范围会被跳过，而不是静默截断。
3. **提出并规范化**持久事实，每个范围最多 3 次辅助模型调用（提案 →
   [本地化] → 规范化），每次调用受 `timeoutMs` 约束。准入逐字核验每条引文
   是否存在于有界证据中，并确定性拒绝含密钥的内容。
4. **提交**通过的事实到项目记忆库，来源为 `memory_extract`，重要性可配置
   （默认 `0.5`），提交前对记忆库做去重探测。
5. **只推进已提交的边界**：空范围仍然推进（记无操作回执，不调用模型）；
   失败范围变为一条待处理记录，由下一次触发重试一次后丢弃。每次运行按确定
   性操作 id 幂等，因此提交与回执之间崩溃通过去重自愈，而不是重复写入。

失败永远不会进入轮次：运行在压缩监听器之后即发即忘，所有错误都被记录并
包含。

## 平面

- **主机组合**（上面的 `cordis.yml`）：`memory-extraction` 是主机行 ——
  每进程一个控制单元、一个全局事件观察者。它注入主机的 `memory` 与 `llm`
  服务，不发布新服务。
- **无代理预设贡献**：显式 `retain`/`learn`/`memory_edit` 表面仍是面向模型
  的路径（Maka 的 `memory_remember`/`memory_extract` 动词被保留、未移植）。

完整契约见
[内存提取子系统文档](../../../../../docs/subsystems/memory-extraction.zh.md) 与
`packages/memory/memory-extraction` 的包 README。
