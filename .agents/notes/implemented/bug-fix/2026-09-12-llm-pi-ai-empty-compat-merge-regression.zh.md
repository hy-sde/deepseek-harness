# Agent Note: llm-pi-ai 空 compat 合并回归

Status: implemented

[English](2026-09-12-llm-pi-ai-empty-compat-merge-regression.md) | 中文

## Problem

上游 0.1.5-rc.1 合并回退了 `configuredCompatEntries`（`packages/llm/llm-pi-ai/src/catalog.ts`）中对空数组的判空过滤。设置 schema 会把缺失的 `compat` 物化为空值——`allowedFallbackModels: []`、`chatTemplateArgs: {}`、`chatTemplateKwargs: {}`——而合并后的过滤只跳过空对象，因此空数组会让路由看起来像配置了 `allowedFallbackModels`。于是手写声明的 `openai-completions` 路由（本部署的本地 vLLM 端点，设置中没有 `compat`）被拒绝：`sets compat "allowedFallbackModels", but no model on the route speaks a protocol that takes it; it exists on anthropic-messages`。提供方从未注册，其分区从模型选择器中消失，会话默认模型每一轮都以 `INVALID_CONFIG` 失败。树内回归测试（`ignores schema-materialized empty compat defaults a protocol does not take`）在合并后的 head 上失败。

## Decision

恢复合并前的过滤：空数组与空对象都视为*未配置*，字段落到下一层——先安装目录条目，再是 pi-ai 自身的检测——与键缺失完全一致。回归测试随之通过，手写提供方套件的其余部分同样通过。

合并还引入上游测试，断言 `allowedFallbackModels` 作为目录所有字段被*保留不给配置*。该前提与 fork 表面冲突：合并前后 `ANTHROPIC_COMPAT_GATE` 都把 `allowedFallbackModels` 标记为 `anthropic-messages` 的 `offer`（在该协议上可配置，数组形状由 schema 校验），而 `supportsMidConvoEffort` 被保留不给配置。测试现改为钉住真实契约：`supportsMidConvoEffort` 以 `which is not configurable here` 拒绝；`allowedFallbackModels` 在 `anthropic-messages` 上往返可用，并在 `openai-completions` 上以 `no model on the route speaks a protocol that takes it` 拒绝。

## Alternatives considered

**把空数组视为已配置。** 这是合并后的行为，也正是回归来源；空列表不携带任何开关，与键缺失完全一致，因此不应拒绝路由。

**直接照搬上游测试（继续保留不配置 `allowedFallbackModels`）。** 否决：fork 表面早于合并——pi-ai 0.85.1 进入 fork 后，`ANTHROPIC_COMPAT_GATE` 就在 `anthropic-messages` 上 offer `allowedFallbackModels`，配置 schema 也校验其数组形状。为满足上游测试而保留它，等于移除一项文档化了的能力。

**改 schema 让 `true` 以目录消息失败。** 否决：类型不匹配按设计是 schema 边界错误；目录的 `which is not configurable here` 措辞用于 schema 刻意不认识的字段。

## Consequences

没有兼容 `compat` 的手写路由重新注册，本地提供方重新出现在模型选择器中，已配置的默认模型恢复服务。无 schema、wire 或设置格式变更；修复只是恢复合并前 fork 已交付的行为。运行时加载的是构建产物 `lib/`，因此运行中的部署需要一次 `build:lib:host` 才能观察到它。

## Testing

`packages/llm/llm-pi-ai/tests` 326/326 通过；目录回归用例与调整后的 compat-upgrade 契约都在套件内。
