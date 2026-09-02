---
description: "Task-window countdown chip for browser-side UI plugins, showing remaining time and restart controls for bounded assistant work."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-countdown

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-countdown` is a browser-side UI plugin that renders a countdown chip for a task window owned by another plugin: it displays the remaining time in compact `h m`/`m s` units, offers `Start` and `Restart` controls, and exposes a settings surface for the timer duration (including custom minutes). It is presentation only — the plugin that owns the window declares the deadline, and this plugin renders it without changing model context.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside the plugin that owns the task window. It reads the owning plugin's deadline state through the client slot contract and re-renders the chip on each tick.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `durationMinutes` | plugin-owned | Timer duration exposed by the owning window; `Custom minutes` overrides it. |
| `autoStart` | plugin-owned | Whether the countdown starts on mount or waits for the user to press `Start`. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin is a pure client-surface component: it keeps no server state and owns no host service. Ticks are browser-side only, so a host suspension or a page refresh resets the visible remaining time.

-----

<a id="further-exploration"></a>
## Further Exploration

- [UI primitives](../../client/ui-primitives/README.md) — the chip and button components this plugin composes.
- [Client slots](../../client/ui-slots/README.md) — the contract through which the owning plugin publishes its deadline.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The timer is browser-side only; host suspension or refresh resets it.
- No cross-window synchronization; duplicate open sessions each run their own countdown.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
