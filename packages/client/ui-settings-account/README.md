---
description: "Sidebar settings launcher that opens the Settings panel"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-account

English | [中文](README.zh.md)

## Summary

Own the sidebar settings launcher: an icon-only trigger that opens a menu with a single Settings entry. Selecting Settings closes the menu, returns focus, and opens the Settings panel with the effective keyboard shortcut. The launcher keeps no account, credential, or model state.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Web application bundle mounts the launcher through the `settings.launcher` slot. The settings shell supplies the sidebar geometry (`wide`), the effective Settings shortcut, and the open action; the launcher owns no state of its own. Registration is unconditional: no remote-access grant, account snapshot, or credential state is consulted.

### Layout and behavior

The expanded row is 32px high and aligns its content and inset hover fill with navigation rows; the collapsed sidebar renders a centered 36 × 36px button. Buttons use border-box sizing. The Settings row shows the effective key combination supplied by the shell. Selecting an item closes the menu, returns focus to the launcher, and opens Settings. Escape dismisses the open menu without opening Settings; the shared Menu owns dismissal, hover, and focus.

<a id="understand-the-implementation"></a>
## Understand the implementation

`apply` registers the eight-language `settings.account` locale namespace and one `settings.launcher` slot occupant that renders `AccountMenu`. The component composes the shared `Menu` surface; `listClassName` styles the portaled card. Nothing else is registered: there is no account stream, no settings section, and no quota surface.

<a id="further-exploration"></a>
## Further Exploration

- `packages/client/ui-settings` declares the `settings.launcher` slot contract and owns the settings panel the launcher opens.
- `packages/client/ui-settings-models` hosts generic API-key provider onboarding.

## Model Experience

None, as the launcher opens panels and never enters model prompts, Session logs, or tool results.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

- The menu carries a single Settings entry; future sidebar entries would extend the item list.

### Dev Note

- After editing either README, re-record the paired-heading hashes with `pnpm run verify-translation-pairing --write packages/client/ui-settings-account/README.md`.
