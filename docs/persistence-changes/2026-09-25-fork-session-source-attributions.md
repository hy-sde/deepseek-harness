---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-25-fork-session-source-attributions

English | [中文](2026-09-25-fork-session-source-attributions.zh.md)

## Summary

The fork's memory-extraction pipeline registers one new Session-source attribution kind (`dsh-memory-extraction`) whose messages enter the events `user/message`, `developer/message`, `agent/inbox/spliced`, and `session/title-llm-request`, and the fork adds one host-local graph supervision event root (`event:graph/change`). The new wire kind is declared additive through `@persistenceAttribution`, so readers preserve it without changing chronology or compatibility of any existing payload.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-25-fork-session-source-attributions
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "fde027b4b6f27abc1082db9a06cfeb7f3a0ecce294ffccb6e6209f18426e8b84"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "6d5239db992a5a47322b39a91bc6b2dfd335693835002bb6c8cce53894ce9230"
    decision: same-version
  - root: "event:graph/change"
    previous: null
    after: "d38454ae5ba07b11a92a88ce553df6781853437d4913f4a4020298af3b8e3263"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "187a88a7492775d7108d3323c31b31f979f86bd12ab564af90fa82ba596d751a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "6123dc94139968b7a71e40718ac36a3575943a6dcdabd039deb3d76af8ce45fe"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

All five transitions are acknowledged same-version. The new source kind is attribution-qualified: existing readers that preserve unknown kinds continue to accept the new kind, and the `event:graph/change` root is a new event root with `surface: false`, so it mirrors the accepted pattern of additive host events such as `event:goal/change`. No existing schema shape changes; no format version bump is required.

<a id="verification"></a>
## Verification

`pnpm run persistence-changes --check` reports zero version-bump-required changes after recording; `pnpm run verify-persistence-formats` reports v0 through v4 complete references; the merged workspace typecheck and the session-format corpus both pass with these types in place.

<a id="dev-note"></a>
## Dev Note

None.
