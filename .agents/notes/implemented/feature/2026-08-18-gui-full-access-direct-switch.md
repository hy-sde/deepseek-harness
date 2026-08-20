# Agent Note: GUI Full access switches directly (no risk confirmation)

Status: implemented

English | [中文](2026-08-18-gui-full-access-direct-switch.zh.md)

Supersedes [2026-07-31-gui-full-access-confirmation.md](2026-07-31-gui-full-access-confirmation.md) — the risk gate it introduced is removed.

## Problem

The approved-change flow from 2026-07-31 gated every GUI path into `danger-full-access` behind the shared `RiskConfirmation` dialog. With Full access now the default for new sessions and approval prompts off (`approval/policy: never`), that gate became a per-pick tax: the preset everyone starts in still demands a checkbox + confirm on every change away and back, and the whole harness currently runs with approvals disabled.

## Decision

**Every permission picker writes Full access directly — the `RiskConfirmation` dialog, its checkbox gate, and the per-popup confirmation state machines are removed.** Selecting `danger-full-access` in the composer chip, the `/permission` popup, or the General-settings Permission row submits the same write path as any other preset on the first click.

- The settings row (`PermissionRow`) drops its `confirmingFullAccess`/`acknowledged` state and calls `select('danger-full-access')` like any other option.
- The `/permission` popup decoration no longer attaches a `confirmation` payload; the ui-commands shell's generic gate (`SelectOption.confirmation`, the popup controller's `confirming`/`acknowledged` transitions, and the `PopupSelectView` swap) is deleted entirely, since the Full-access gate was its only consumer.
- The composer chip (`PermissionSelect`) drops the confirmation component state and submits `/permission danger-full-access` through the same injected `command` callback as every other pick.
- `RiskConfirmation` (ui-primitives), its module CSS, and its exports are deleted: no surface uses it.

Copy cleanup follows each surface: the `confirm.*` keys in `settings.permission`, the `permission.access` namespace (and `accessZh`/`accessEn`), and the `access.confirm.*` keys in `conversation` locales all go with it.

## Consequences

The product label `Full access` stays (it is presentation, not the gate); only the dialog goes. New picker surfaces no longer have an acknowledgement-gate building block — reintroducing one means bringing `RiskConfirmation` and the gate states back. Acceptance: `permission-row.spec.tsx`, `browser-plugin.spec.ts`, `input-bar.spec.tsx`, `popup.spec.ts`, `popup-view.spec.tsx`, and the Web e2e replays assert the direct write instead of the dialog.
