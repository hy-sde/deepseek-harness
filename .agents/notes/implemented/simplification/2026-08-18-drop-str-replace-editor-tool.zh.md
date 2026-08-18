# Agent Note：彻底移除 str_replace_editor；`minimal` 成为 rich 双工具预设

Status: implemented

[English](2026-08-18-drop-str-replace-editor-tool.md) | 中文

## 问题

随附的 `minimal` 预设把持久 `bash` 加 `str_replace_editor`（`@deepseek-ai/dsh-tool-str-replace-editor`）作为其精确的双工具名册；另一个变体 `minimal-code-edit` 在相同的双工具契约下挂载 rich 编辑器（`tool-fs` 设 `enableEdit: false`，外加 `mode: auto` 的 `tool-edit`）。两个面向模型载体几乎相同的预设让随附表面产生歧义：到底哪个才是「那个」minimal agent？独立的 `str-replace-editor` 插件还重复了 rich 编辑器拥有的 read/write/edit 接缝，因此即使保持它随附（未挂载），也会在包目录与生成的文档里留下第三个编辑 schema。

## 决策

- 消除 `minimal` 与 `minimal-code-edit` 的重复：删除旧的 `minimal` 预设，把 `minimal-code-edit` 重命名为 `minimal`。重命名后的预设保留其原有组合契约——持久 `bash` 加基于 `tool-fs` read/write 的 rich `edit` 工具（replace / patch / apply_patch / hashline）——并接管 `极简模式` 显示名与名册顺序。
- 彻底删除 `packages/fs/tool-str-replace-editor` 与 `str_replace_editor` schema：包目录、bundle 行（base 与 web-app）、workspace 依赖、`tsconfig.host.json` 项目引用、benchmark／smoke 脚本特例、生成的 tool/config 目录及其中文镜像，以及把独立编辑器描述为随附能力的文档。
- 完全不随附字符串替换编辑器。`tool-fs` + `tool-edit` 提供的 read、write 与 `edit` 是仅有的面向模型变更表面。

本决策取代更早的 [单一编辑器决策](2026-08-10-default-presets-single-editor.md)，后者曾让 `minimal` 在持久 `bash` 之外使用 `str_replace_editor`；由于该插件已被删除而非仅仅未挂载，那条例外不再适用。

## 备选方案

**保留 `str_replace_editor` 作为可选独立包。** 否决：未挂载的随附包仍会出现在目录、模块图与发布产物中，且其 view/create/str_replace/insert 词汇与 rich `edit` 重叠，却没有 diff 渲染、观测策略集成以及编辑器提供的 patch 格式。

**保留 `minimal` 与 `minimal-code-edit` 两个预设。** 否决：一旦 `minimal` 的编辑器槽位切换到 rich 工具，两个双工具载体完全相同；组合几乎逐字节一致、显示名不同的两个预设只会让 Web 预设选择器更混乱。

## 后果

- 随附 `minimal` 预设现在挂载 bash（`dsh-tool-bash-persistent`）以及 read/write + `edit`（`tool-fs` 设 `enableEdit: false`、`tool-edit` 设 `mode: auto`），并在各自隔离的 realm 中提供 PTY 与裸 `fs-local` 后端。它的 persona 仍是完整系统提示词且抑制 runtime-context，上下文压缩依旧缺席。
- `examples/jsonrpc-agent/minimal.cordis.yml`（独立的 SDK 孪生）使用相同的 rich 编辑器行；Python SDK model-visible 快照与 SDK smoke 的模型跟进行现在驱动 `write` 而非 `str_replace_editor` 的 `create`。
- tool-catalog、config-catalog、module-graph、event-producer-consumer 与 subsystem 页面不再以任何语言列出 `str_replace_editor`。
- oh-my-pi edit-benchmark 驱动已移出 harness：独立字符串替换编辑器删除后，`scripts/run-edit-benchmark.ts` 与 `scripts/summarize-edit-benchmark.ts` 被删除（benchmark 现已位于独立的插件仓库），仓库内无任何引用。
- 预设组合测试把 minimal 名册固定为 `bash`、`edit`、`read`、`read_image`、`write`，并断言不出现 search/ask/todo 行；web minimal 快照与预设创作 golden 均已同步更新。2026-08-10 的 [单一编辑器笔记](2026-08-10-default-presets-single-editor.md) 保留其论据，但其 minimal 例外被本笔记取代；两者互相交叉链接。
