---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-13-trim-removed-bundle-payload-variants

English | [中文](2026-11-13-trim-removed-bundle-payload-variants.zh.md)

## Summary

Removes the payload union variants contributed by the deleted LiveShare share-viewer client and the deleted session-titles bundle: the optional `principal` on `user`-kind message sources narrows to drop the `share-viewer` object, and the `session/title-llm-request` message list loses the bundle's request variant.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-13-trim-removed-bundle-payload-variants
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "3633c9d355bf1a8d4bfbbc4709adbfb39e83342677e8a8a32a1bda5de4bf3039"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "e35448e7c5d74e6be8a17c036585bd19e55b18d27dbde4180e8f2d2e272e6a35"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "e01be48a725f4c8de1b8e3589573e2d5f7c4c21398331742cfe8dcb184817c20"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "7ccc21809887f205941219fd96631b439f05051495b0474002b79ba4c5dbfc67"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The change only narrows compile-time unions; runtime parsing of sources and title-llm message lists stays structural and does not enumerate principal kinds or message variants. A current reader of an older Session log that carries a `share-viewer` principal or the removed title-llm variant still loads the row unchanged: the source `kind` stays 'user' and the extra fields ride along as inert data. The only component that recognized the `share-viewer` principal (the deleted LiveShare client) and the only writer of the removed title-llm variant (the deleted session-titles bundle) are gone, so no current code path branches on the removed variants and no new log writes them. SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests packages/session/session-persistence/tests: 20 files, 405 tests passed, covering source and message round-tripping through the released format migrations. pnpm run persistence-changes --check confirms the four narrowed roots match this record and no other roots differ.

<a id="dev-note"></a>

<a id="dev-note"></a>
## Dev Note

None.
