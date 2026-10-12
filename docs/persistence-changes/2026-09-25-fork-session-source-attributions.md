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
    previous: "2026-10-05-working-directory-attribution"
    after: "202cf195c28c96acd0ea931a8e58a2ae9e000de1d4818f0ce8ea8426dfcd4e22"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "279893d785bcca4e7d375eb49a0c13b60eeea4e10f3cf33b212d8d5e67cc6ae6"
    decision: same-version
  - root: "event:graph/change"
    previous: null
    after: "d38454ae5ba07b11a92a88ce553df6781853437d4913f4a4020298af3b8e3263"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-07-title-reasoning-effort"
    after: "344f89c27240f492fd2d02e4810fde3310dfb6a28cc44bf0eacc272e28d05587"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-05-working-directory-attribution"
    after: "810ea3e4543b6d9567494d9a920a9c86e5fd2b11c2ec8297643f91f9c853e77f"
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
