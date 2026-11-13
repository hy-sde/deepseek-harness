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
    after: "1c5e32f989f10dddcc379f5eecd0094f35c027d21849ac138eec91f3ae5d439f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "bf53189b0f8b5b3c98f92551b29a0f2b3024bb44dfd2c3cec5eb23b52420ae4c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "cd23ce25d33666e2cfed7cf084bfbd601cba0e5245115550c78cdac3cab83539"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-25-fork-session-source-attributions"
    after: "c3ffea290e0c23698dfd000d4cf55b7c561065eeead7e8870a5a564f4534246d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The change only narrows compile-time unions; runtime parsing of sources and title-llm message lists stays structural and does not enumerate principal kinds or message variants. A current reader of an older Session log that carries a `share-viewer` principal or the removed title-llm variant still loads the row unchanged: the source `kind` stays 'user' and the extra fields ride along as inert data. The only component that recognized the `share-viewer` principal (the deleted LiveShare client) and the only writer of the removed title-llm variant (the deleted session-titles bundle) are gone, so no current code path branches on the removed variants and no new log writes them. SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-format-v3-to-v4/tests packages/session/session-persistence/tests: 20 files, 405 tests passed, covering source and message round-tripping through the released format migrations. pnpm run persistence-changes --check confirms the four narrowed roots match this record and no other roots differ.

<a id="dev-note"></a>
## Dev Note

None.
