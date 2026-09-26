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
    previous: "2026-09-16-session-format-v4"
    after: "abb5e92aa6abf81f3f00ca72ee24419a537c1b2ea177749071f316e3227dfe95"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "008d25f03fc5d95a06baf2d165260d89a685f5b9adbbb920045c51abbe7a99e7"
    decision: same-version
  - root: "event:graph/change"
    previous: null
    after: "d38454ae5ba07b11a92a88ce553df6781853437d4913f4a4020298af3b8e3263"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "a8d915218db440181a3b3ed282244ce60b0ff544771b544cccafd12ba2e16626"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "1fdbe666fd2560d997d6f70d46586990cd4f95e38de00cf5cc8c6854085753f8"
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
