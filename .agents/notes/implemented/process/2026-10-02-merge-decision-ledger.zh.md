# Agent Note: 上游合并决策账本（持久化、按键索引、解决冲突前必读）

Status: implemented

[English](2026-10-02-merge-decision-ledger.md) | 中文

## 问题

0.1.5/0.1.6 同步中唯一一次静默功能回归 —— fork 的字节感知实时写入批处理与 `compressionLevel` 被 `12f54ae41d` 以"upstream wins"整体采用上游重写的 session 包而丢弃（[回移](2026-09-20-upstream-merge-post-merge-validation.zh.md)）—— 以及更早审计中丢失的 `llm-pi-ai` 空 compat 修复，共享一个事后扫描器无法解决的根本原因：**原始合并会话中的按键决策账本从未成为可查阅的产物。** `13bcd9930e` 的合并信息原话："keyed-decision ledger NOT ported." 差异扫描器在合并之后才检测到丢失；没有任何东西在解决冲突时告诉人或代理，之前的合并对该 key 已经做过什么决定。知识丢失在代码丢失的上游。

## 决策

一个持久化、按键索引的决策账本存放在 pi-durable 代理中（Route A：`@hy-sde-org/dsh-pi-durable`，数据库 `~/.dsh/storages/pi-agent.sqlite`）。每个决策是一条 `decision` 类型的条目，数据为 `{ledger: 'upstream-merge-decisions', merge, key, side, status, what, refs}`，`requestId = ledger:<merge>:<key>`，因此重新播种是恰好一次 —— 重跑会重放到相同提交而非产生重复。条目原文存于 sqlite（永不被 ACP 压缩）并与转录原子性提交。2026-10-02 从 2026-09-12 与 2026-09-24 两次合并丢失审计播种：20 条，脚本 `/Users/hui/Documents/workspace/seed-merge-ledger.mjs`。

### 查阅仪式（约束性）

1. **解决任何上游合并冲突之前**，翻阅持久代理历史并按 key、包或文件过滤 `kind=decision`。已记录的决策具有约束力，除非队长明确推翻；推翻时写一条取代旧 key 的新条目。
2. **解决之后**，按上述 schema 追加一条决策条目（`requestId = ledger:<merge>:<key>` 保证幂等）。记录 `side`、理由与 refs —— "因为"才是承重部分。
3. **保留检测层。** 覆盖 `--first-parent` fix/feat 提交的 mb 差异扫描器仍在合并后运行；账本是预防，扫描器是检测。二者互不替代。

### 运维

`durable_agent_*` 工具挂在 cordis-plus 预设（web profile 组合中 host 平面的 `pi-durable` 引擎行）。脚本侧直接 import 引擎 dist 并以相同 resolved config 调用 `writeEntry`；host 进程持有 `LOCAL_API_KEY`，但账本写入从不需要生成（`writeEntry` 是被动的 —— 绝不触发模型调用）。

### 已播种决策（2026-10-02）

- `session-persistence/live-batching-compression` — fork 胜，回归由 `9248da21c0` 修复（被 `12f54ae41d` "upstream wins" 丢失，由 3 个红的 jsonl.spec 测试暴露）。
- `agent-loop/cancel-claimed-input` — fork 胜，由 `e0bfc3472e` 修复（取消永不擦除已认领输入；合并前即存在的代码/测试错配）。
- `scope-lifecycle/persona-field` — fork 胜（`persona` → `personaPrefix`），上游陈旧测试文案已修复。
- `process/merge-validation-vitest-gap` — 教训：合并验证必须运行所触及包的完整 vitest 套件（批处理丢失正是在没有 vitest 的关卡下溜走的）。
- `wiki/apiproxy` 被取代 · `tools/run-code-session-reset-params` 被取代 · `client/popup-ri-reveal` 与 `client/popup-wo-reveal` 上游已采纳 · `ui-workspace/recency-init` 被取代 · `subagent/workspace-capability` 仍在 · `worker-thread/no-warnings` 已废弃 · `codebase-memory/gitignore` 已恢复 · `tool-str-replace-editor/643-line-deletion` 属刻意删除 · `control-types/SubagentControlError-map` 属上游刻意重设计 · `AGENTS.md/package-layout-edit-ast` 未决（仅文档） · `docs/generated-catalog` 属预期翻录 —— 均出自 2026-09-24 审计。
- `llm-pi-ai/empty-compat` 已修复 · `client/browser-catalog-ordering` 已决（采用上游 oldest-first；fork 的翻转作为可选后续，需同时翻转 index.ts 与 spec 期望） · `client/pointer-hover-close` 存活 —— 出自 2026-09-12 审计。
- `process/consult-convention` — 承载本仪式的元条目。
