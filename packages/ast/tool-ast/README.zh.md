---
description: "面向模型的结构化代码工具 ast_grep 与 ast_edit：内置 ast-grep 原生二进制、经子进程启动、通过文件系统缝隙先预览再重写——供选择“文本 grep 或字面量编辑力不从心”场景的 agent 使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ast

[English](README.md) | 中文

## 概述

`ast_grep` 与 `ast_edit` 让 agent 以精确、语法感知的方式访问代码库：找到与树模式匹配的每个函数、调用或类，或在预览精确变更块后把每个匹配重写为模板。二者都运行内置的 ast-grep 原生二进制，无需宿主机安装，每次调用都是有界子进程。当“形状”重要而文本 grep 只会产生噪音时使用 `ast_grep`；当改动是 1:1 结构化替换、且希望写入携带文件系统缝隙的观察与版本校验时使用 `ast_edit`。边界是语法作用域：除非语法允许，捕获无法在某个位置展开为兄弟节点。

## 目录

- [两个工具](#the-two-tools)
- [退出码分类](#exit-code-classification)
- [配置](#config)
- [引擎归属](#engine-ownership)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

**面向模型的结构化代码工具**——`ast_grep`、`ast_edit`——由**内置的 ast-grep 原生二进制**（`@ast-grep/cli`）驱动，移植自 [@oh-my-pi](https://github.com/oh-my-pi) 编程代理工具集。与文本 grep 或字面量编辑不同，这些工具基于目标文件的语法树执行：模式使用树元变量（`$NAME` 绑定一个节点、`$_` 匹配任意单个节点、`$$$NAME` 捕获零个或多个节点），因此“所有调用 `foo()` 的地方”或“把所有 `old` 字段重命名为 `new`”都能被精确表达。

无需宿主机安装 `ast-grep`：二进制随 npm 依赖一同分发（其 postinstall 会将匹配平台的可选包可执行文件硬链接到包根目录——macOS/Linux/Windows、x64/arm64），因此注册是无条件的，工具可在所有受支持平台上运行。每次调用都通过 `ctx.subprocess` 缝隙以固定 argv 向量启动二进制——模型控制的值只是普通 argv 元素；不存在 shell 层，因此无需引号转义也不会被注入。本包注入 `tools`、`systemPrompt`、`subprocess` 与 `fs`（后者用于 `ast_edit` 应用模式，写入经文件系统缝隙并遵循观察/版本校验与沙盒策略，而不是让 ast-grep 直接改动磁盘）。

```ts ignore-check
// A deployment adds the engine (already an npm dependency) and the two tools.
await ctx.plugin(LocalSubprocessRuntime)                     // @deepseek-ai/dsh-subprocess-local
await ctx.plugin(LocalFileSystem)                            // @deepseek-ai/dsh-fs-local
await ctx.plugin(ToolAst)                                    // @deepseek-ai/dsh-tool-ast
```

为何采用进程驱动：结构化分析需要完整的语法集——`@ast-grep/cli` 发行版覆盖数十种语言，包括 TypeScript、Python、Rust、Go、Java、C/C++ 与 Ruby——纯 TypeScript 解析器难以低成本匹敌；而重写最安全的形态是经过既有文件变更缝隙的“预览—确认—应用”流程，而非原始的 `-U` 文件写入。子进程缝隙负责进程派生、进程树终止、环境清洗与有界输出捕获；本包负责模式、校验、argv 构建、JSON 流解析、应用字节偏移对齐、结果上限/呈现以及超时声明。两个工具都不暴露后台任务——只有在 ast-grep 退出、被协作式超时终止、被取消或失败后，调用才返回。

<a id="the-two-tools"></a>
## 两个工具

- `ast_grep` — 只读的**结构化搜索**。`pat` 必填；`path`（默认为会话工作区；多个根以 `;` 分隔）、`include`（一个 glob 过滤器）、`lang`、`strictness` 用于收敛范围。返回带 1 基行列号的匹配、被匹配节点文本及其 `$NAME` 捕获——按文件分组。
- `ast_edit` — 结构化**重写**。`pat` + `rewrite`（`$NAME` 替换来自模式；空 rewrite 删除匹配的节点）。**默认先预览**——`apply: false` 返回逐文件的 `before`/`after` 变更块而不触碰磁盘；传 `apply: true` 才会写入。写入经 `ctx.fs`（`readText` → `fs/edit-intent` → `writeText` 搭配 `replaceIfVersion` 与沙盒策略），因此观察/版本校验与部署沙盒模式与普通编辑完全相同地生效。

<a id="exit-code-classification"></a>
## 退出码分类

ast-grep 的退出码被映射为稳定的 `AST_*` 词汇表：

| ast-grep 退出码 | stderr | 工具结果 |
|---|---|---|
| 0 | 任意 | 成功；自 JSON 流解析匹配 |
| 1 | 空 | 成功但零匹配 |
| 1 | `ERROR: <path>: ...` | `AST_FIND_ERROR`（目标缺失/无效） |
| 2 | `error: ...` | `AST_USAGE_ERROR`（不支持的语言、非法模式语法） |
| 其他 | 任意 | `AST_FAILED`；被杀死的进程树在协作式超时或调用方取消触发时报 `AST_ABORTED` |

原始输出过大（默认超过 8 MiB）报 `AST_RAW_OUTPUT_OVERFLOW`，让失控的匹配流显式浮现而非静默截断。

<a id="config"></a>
## 配置

所有键均可选，默认如下。

| 键 | 默认值 | 含义 |
|---|---|---|
| `astGrepMaxMatches` | `100` | 单次 `ast_grep` 调用内联返回的最大匹配数；其余匹配省略并给出提示。 |
| `astGrepMaxNodeBytes` | `2000` | 单条被匹配节点预览的字节上限（截断保持 UTF-8 边界并做标记）。 |
| `astEditMaxHunkBytes` | `4000` | `ast_edit` 单个 before/after 侧的字节上限。 |
| `astEditMaxFiles` | `200` | 单次 `ast_edit` 运行报告（应用模式下写入）的最大文件数。 |
| `searchMetaMaxBytes` | `65536` | 单次结果的 `presentationMeta` 序列化上限（UI 搜索/差异卡片负载）。 |
| `rawOutputMaxBytes` | `8388608` | 单次运行将要解析的最大原始引擎 stdout。 |
| `graceMs` | `3000` | ast-grep 进程树终止升级的宽限期，受平台最大定时器延迟约束。 |
| `stderrMaxBytes` | `65536` | 失败摘录保留的最大 stderr 尾部字节数。 |
| `timeoutMs` | `30000` | 两个工具共用的协作式工具调用超时预算。 |

<a id="engine-ownership"></a>
## 引擎归属

本包使用自有稳定错误码（`AST_*`，通过 `AstError`），使工具结果与回放保留失败类别，而不会耦合 ripgrep 的 `SEARCH_*` 或文件系统的 `FS_*` 词汇。纯函数部分——argv 构建、JSON 流解析、字节到索引转换——从 `./src/core.ts` 导出以供直接测试。

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到的内容

本插件独立注册了两个系统提示词区段——`tool:ast-grep`（顺序 105）与 `tool:ast-edit`（顺序 106）——用于定位结构化搜索与重写。按 scope 收紧的工具限制可以隐藏任一 schema，但不会移除其提示词区段。

##### ast_grep 指引

```markdown
Use ast_grep for STRUCTURAL code search (syntax-aware, not textual): find every function, call, class, or declaration matching a tree pattern. Patterns use metavariables like $NAME (bind one node) or $_ (wildcard); e.g. `console.log($MSG)` finds every console.log call. Prefer ast_grep over grep when the shape matters (e.g. "all calls to foo()", "every class implementing X"). A pattern that is only "kinda text-like" is often better served by grep.
```

##### ast_edit 指引

```markdown
Use ast_edit for STRUCTURAL rewrite: replace every node matching an AST pattern with a template that can reference captured metavars ($NAME). It always PREVIEWS first (apply defaults to false) so you can verify the hunks; pass apply: true to actually write the files. Rewrites are 1:1 structural substitutions: a capture cannot expand into sibling nodes unless the grammar permits it at that position.
```

#### Token 影响

插件处于活跃状态时，每次请求承担固定指引成本。

#### KV Cache 影响

只要插件 scope 与指引文本不变，前缀就保持稳定；激活或 dispose（资源释放）可能使从该区段起的复用失效。

### 工具 schema

#### 模型看到的内容

模型会看到生成的 [`ast_grep` 与 `ast_edit` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ast)。`ast_grep` 需要 `pat`；`ast_edit` 需要 `pat` 与 `rewrite`，并暴露先预览的 `apply` 开关。

#### Token 影响

启用期间，每次请求承担固定 schema 成本；`timeoutMs` 预算绝不会发给模型。

#### KV Cache 影响

只要可见工具定义与顺序不变，前缀就保持稳定；注册生命周期或 scope 限制可能使从第一个变化的 schema token 起的复用失效。

### 结果

#### 模型看到的内容

`ast_grep` 返回从 1 开始的 `path:line:column` 行，每行带匹配节点的文本及其捕获，按文件分组；被截断的结果以省略提示结尾。`ast_edit` 返回每个文件的 `before`／`after` 变更块（默认预览），应用模式下还返回文件结果——变更块在 UI 中渲染为 diff 卡片。空搜索会明确说明。呈现上限（`astGrepMaxMatches`、`astGrepMaxNodeBytes`、`astEditMaxFiles`、`astEditMaxHunkBytes`）只影响模型呈现；原始输出溢出会以 `AST_RAW_OUTPUT_OVERFLOW` 响亮失败。

#### Token 影响

每项工具结果按同样的呈现上限截断；调用与保留结果在压缩前一直留在历史中。

#### KV Cache 影响

工具结果追加在已缓存请求前缀之后，不会直接使其失效。

### UI 呈现

#### 模型看到的内容

无。客户端为 `ast_grep` 渲染通用搜索卡片——`{ card: 'generic', kind: 'search', title, locations }`——并为 `ast_edit` 渲染带建议变更块的 diff 卡片，二者都基于持久化的 `presentationMeta` 构建。

#### Token 影响

直接 token 影响为零，因为渲染只发生在客户端。

#### KV Cache 影响

无；UI 呈现位于模型请求之外。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **语法覆盖跟随 ast-grep**：支持数十种语言，但小众或非常新的语法可能缺失或滞后；模式中的语法错误可能以 `AST_USAGE_ERROR` 呈现。
- **结构化重写是 1:1**：除非语法允许，否则捕获无法在某一位置展开为兄弟节点；多节点重构可能需要若干次更小的重写或普通文件编辑。
- **预览大小上限**：匹配节点与变更块预览有字节上限；超大的匹配或变更块会被剪切（带标记）而非静默丢弃，`rawOutputMaxBytes` 则约束整个引擎流。

**运行时不变量：** 不发布伴生文件。本包不拥有任何可供同进程不变量观测的持续运行时关系；其行为由包测试套件保障。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
