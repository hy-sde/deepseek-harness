---
kind: upgrade-guide
description: "超限评审任务需要 spillStore，使用完整 diff 产物，而不再按文件截断内联 diff。"
---

# 大型评审任务改用 diff 产物

[English](guide.md) | 中文

## 变更

`dsh-tool-git` 将 `maxReviewerDiffChars` 应用于每个评审者的全部 diff，而非分别应用于各个文件。超过上限的切片通过 `spillStore` 完整保存；评审者收到定位符和逐文件行范围，而非截断后的内联 diff。缺少存储或写入失败时，受影响的评审者会在启动前失败。

## 迁移

1. 使用 `review` 的自定义组合必须提供 `spillStore`，例如挂载 `@deepseek-ai/dsh-spill-local`，并确保评审者能够读取其定位符。内置 profile 已提供 spill 存储。
2. 将 `maxReviewerDiffChars` 作为每个评审者全部内联 diff 的预算；默认值仍为 40,000 个字符。运行一次超过上限的评审，确认子任务引用了可读取的 diff 产物，且评审没有 errors。
