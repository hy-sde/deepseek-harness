# @deepseek-ai/dsh-tool-edit

[English](README.md) | 中文

面向模型的 DeepSeek Harness 富编辑工具：一个包含四种编辑模式的 `edit` 工具，移植自 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的编码 agent（`packages/coding-agent/src/edit`）。

- `replace` — 字面量 `old_string` → `new_string`，带渐进式模糊匹配回退阶梯（精确 → 修剪 → 注释前缀 → Unicode → 前缀 → 子串 → Levenshtein 模糊）以及出现位置预览错误。
- `patch` — 结构化 JSON hunks：`{ path, edits: [{ op: create|update|delete, rename?, diff? }] }`，每次调用处理一个文件。
- `apply_patch` — OpenAI-Codex 风格的 `*** Begin Patch … *** End Patch` 信封，一次调用处理多个文件。
- `hashline` — 默认模式：一种紧凑、以行为锚定的补丁语言，由 [`@deepseek-ai/dsh-hashline`](../hashline) 支撑。

它通过 harness 文件系统 seam（`ctx.fs`）执行，因此沙箱策略、fs 观察（先读后改）和 diff 卡片呈现与其他 fs 工具一样生效。当挂载了 `ctx.lsp` 时，它会通过 harness 的 LSP seam（`@deepseek-ai/dsh-lsp` / `@deepseek-ai/dsh-lsp-stdio`）执行 LSP 写透——`formatOnWrite` 和 `diagnosticsOnEdit`。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `mode` | `auto` | 编辑变体：`auto`/`hashline`/`replace`/`patch`/`apply_patch`。 |
| `fuzzyMatch` | `true` | 允许高置信度模糊替换匹配。 |
| `fuzzyThreshold` | `0.95` | 模糊匹配的相似度阈值。 |
| `enforceSeenLines` | `false` | hashline：要求补丁中带密封／已见行。 |
| `formatOnWrite` | `false` | 写入后用 LSP 格式化文件。 |
| `diagnosticsOnEdit` | `false` | 写入后收集 LSP 诊断并呈现。 |
| `diagnosticsDeduplicate` | `true` | 抑制已为某文件呈现过的诊断。 |
| `description` | 模式指南 | 可选的面向模型描述覆盖。 |

## 与 `tool-fs` 共存

两个包都注册名为 `edit` 的工具，因此一个 preset 只会挂载其中一个。要让 `read`/`write` 由 `tool-fs` 提供、而富 `edit` 由本包提供，可给 `tool-fs` 设置 `enableEdit: false`，例如：

```yaml
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
  config:
    enableEdit: false

- id: tool-edit
  name: '@deepseek-ai/dsh-tool-edit'
  config:
    mode: hashline
```

## 许可证／来源

移植自 @oh-my-pi/pi-coding-agent（MIT）。原始版权：
`Copyright (c) 2025 Mario Zechner, Copyright (c) 2025-2026 Can Bölük`。
源文件中保留了逐文件的署名头。
