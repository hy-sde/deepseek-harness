# Agent Note：结构化 AST 搜索与重写工具

Status: implemented

[English](2026-08-18-structural-ast-search-and-rewrite-tools.md) | 中文

## 问题

harness 的 `grep` 与 `glob` 工具匹配的是文本，不是语法。agent（智能体）无法可靠地提出“匹配每一次 `foo()` 调用”而不连带命中注释或字符串，无法表达“匹配每个实现 `X` 的类”，也无法只在其声明位置重命名标识符。`str_replace_editor` 的字面字符串替换在跨多行重写时脆弱，并会静默漏掉在琐碎差异、顺序或嵌套上有别的节点。移植这些结构化操作需要一个覆盖广泛语法、且无需宿主机安装的开箱即用的语法感知引擎。

重写能力还需要变更纪律。就地重写（`-U` 风格）会绕过 harness 的文件系统 seam，因此观察规则、版本校验与沙盒策略将不适用于结构化编辑。

## 决策

在 `packages/ast/tool-ast` 新增 `@deepseek-ai/dsh-tool-ast`，作为基于**打包的 ast-grep 原生二进制**（`@ast-grep/cli`）的双工具、面向模型的包，移植自 @oh-my-pi coding-agent 工具套件：

1. `ast_grep`——基于树模式的只读结构化搜索，支持元变量（`$NAME` 绑定一个节点，`$_` 匹配任意单一节点，`$$$NAME` 捕获零个或多个节点）。返回带 1 基行／列的匹配、匹配节点文本及其 `$NAME` 捕获，按文件分组。
2. `ast_edit`——从 `pat` 到 `rewrite` 的结构化重写（`$NAME` 替换取自模式；空重写删除匹配节点）。**默认预览**（`apply: false` 返回每个文件的 `before`／`after` 变更块）；`apply: true` 时通过 `ctx.fs` 写入（`readText` → `fs/edit-intent` → `writeText`，带 `replaceIfVersion` 与沙盒策略）。

不需要宿主机安装 `ast-grep`：二进制内置于 npm 依赖中（其 postinstall 硬链接匹配平台的可选包可执行文件——macOS/Linux/Windows，x64/arm64）。每次调用都通过 `ctx.subprocess` seam 以固定 argv 向量启动二进制；受模型控制的值是普通 argv 元素，没有 shell 层，因此不涉及转义或注入。包注入 `tools`、`systemPrompt`、`subprocess` 与 `fs`。

## 引擎边界

seam 以 `--json=stream` 输出启动 `ast-grep` CLI；包负责 argv 构造、JSON 流解析、字节偏移对账与退出码分类。退出码通过 `AstError` 映射到稳定的 `AST_*` 词汇：

| ast-grep 退出码 | stderr | 工具结果 |
|---|---|---|
| 0 | 任意 | 成功；从 JSON 流解析出匹配 |
| 1 | 空 | 成功且零匹配 |
| 1 | `ERROR: <path>: ...` | `AST_FIND_ERROR`（目标缺失／无效） |
| 2 | `error: ...` | `AST_USAGE_ERROR`（不支持的语言、模式语法无效） |
| 其他 | 任意 | `AST_FAILED`；协作式超时或调用方取消触发进程树终止时变为 `AST_ABORTED` |

大型原始输出（默认 > 8 MiB）以 `AST_RAW_OUTPUT_OVERFLOW` 失败，从而让失控的匹配流大声浮出，而不是静默截断。包不暴露后台任务；调用只在 ast-grep 退出、被协作式超时终止、被中止或失败后返回。

## 变更保留在文件系统 seam 内

`ast_edit` 的应用模式不会让 ast-grep 自行写文件。它按字节偏移降序应用重写变更块来重建新文件文本，再通过 `ctx.fs` 变更：先发出 `fs/observed` 再发出 `fs/edit-intent`（观察水位线，因此“未观察即写”的失败不可能发生），并在部署的沙盒策略下以 `replaceIfVersion` 写入。引擎的 `-U/--update-all` 标志从不使用（它也与会 `--json` 冲突）。这沿用了[文件系统能力 seam](2026-06-17-filesystem-capability-seam.md) 的决策：结构化编辑继承与普通编辑完全相同的观察／版本／沙盒保证。

## 配置与上限

所有配置均为可选，默认值：`astGrepMaxMatches` 100、`astGrepMaxNodeBytes` 2000、`astEditMaxHunkBytes` 4000、`astEditMaxFiles` 200、`searchMetaMaxBytes` 65536、`rawOutputMaxBytes` 8388608、`graceMs` 3000、`stderrMaxBytes` 65536、`timeoutMs` 30000。`timeoutMs` 预算由 `dsh-tool-call-timeout-policy` 强制执行。

## 已考虑的备选方案

**使用纯 TS 解析器。** 结构化分析需要完整的语法集——`@ast-grep/cli` 发行版覆盖数十种语言，包括 TypeScript、Python、Rust、Go、Java、C/C++ 与 Ruby——纯 TS 解析器难以廉价地匹配这一点。

**让 ast-grep 就地写入（`-U`）。** 快，但绕过观察、版本校验与沙盒策略，且 `-U` 与 `--json` 冲突。以预览-验证-应用流程通过既有文件变更 seam 进行重写，能让结构化编辑与普通编辑保持同一纪律。

**合并为单一工具。** 分开搜索与重写，让只读工具不承担变更面，并让 `apply` 显式且先预览。

## 测试

- 引擎测试固定 argv 构造、退出码分类、JSON 流解析与字节偏移对账（纯函数部分从 `./src/core.ts` 导出）。
- 集成测试使用打包二进制：预览变更块、带观察／版本校验的应用流程、中止／超时分类与上限行为。`packages/ast/tool-ast/tests/` 共 23 项测试。
- 随附的 `code-edit` preset 冒烟测试断言 `ast_grep`、`ast_edit` 与 LSP 工具能挂载。

## 影响

结构化编辑是 1:1 的：除非语法允许，否则捕获无法在某一位置展开为兄弟节点，因此多节点重构可能需要若干次更小的重写或普通文件编辑。语法覆盖跟随 ast-grep，因此小众或非常新的语法可能缺失或滞后。匹配与变更块以字节为上限进行预览（带标记而非静默丢弃），整个引擎流受 `rawOutputMaxBytes` 约束。二进制按调用启动：没有常驻服务器，没有跨调用状态，代价是每次调用的进程启动延迟。
