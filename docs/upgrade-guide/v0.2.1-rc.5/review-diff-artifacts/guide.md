---
kind: upgrade-guide
description: "Oversized review assignments require spillStore and use complete diff artifacts instead of truncated per-file inline diffs."
---

# Large reviewer assignments use diff artifacts

English | [中文](guide.zh.md)

## Change

`dsh-tool-git` applies `maxReviewerDiffChars` to each reviewer's combined diff, not each file separately. Slices exceeding the limit are saved intact through `spillStore`; reviewers receive a locator and per-file line ranges instead of truncated inline diffs. Missing storage or failed writes fail the affected reviewer before it starts.

## Migration

1. Custom compositions using `review` must provide `spillStore`, for example through `@deepseek-ai/dsh-spill-local`, and make its locators readable by reviewers. Shipped profiles already provide spill storage.
2. Keep `maxReviewerDiffChars` as the total inline diff budget per reviewer; its default remains 40,000 characters. Run a review exceeding this limit and confirm its child task references a readable diff artifact and the review has no errors.
