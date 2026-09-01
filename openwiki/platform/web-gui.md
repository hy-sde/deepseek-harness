---
type: Reference
title: Web GUI Host and Client
description: The two halves of the dsh web GUI — the host/ group (HTTP server, API gateway, controllers, SPA serving, directory picking) and the client/ group (browser shell, modules, connection, ui-* slots and themes).
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-029b0704543da5726cc8a37f
    resource: repo://packages/api/README.md
  - id: openwiki-source-d00c2e25805ac1ea746ce22e
    resource: repo://packages/client/README.md
  - id: openwiki-source-a2641692449c863dbedd223e
    resource: repo://packages/host/README.md
  - id: openwiki-source-4ad0dbea9a6404b60e12c5b2
    resource: repo://packages/host/webserver/README.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# Web GUI Host and Client

The dsh web GUI is split across two halves. The `host/` group provides the browser-facing server side: a plain HTTP server, the SPA dist server that serves the built Web shell, the workspace-directory picking seam (native, browse, and adaptive composition packages), and the read-only plugin inventory projection. The `client/` group runs the browser half: it boots the web shell, loads browser-side plugin modules, keeps browser-to-host RPC and event delivery alive, and provides the shared client services and UI feature plugins that render the application. The composed application is `apps/cli` booting the `dsh-base` bundle that serves the web app under `apps/web/`.

## The host half

| Package | Role | ctx key |
| --- | --- | --- |
| `webserver/` | Browser HTTP server: named routes, upgrades, index taps, and the fallback seat | `ctx.webServer` |
| `frontend-static/` | SPA dist server on the webserver fallback seat | consumes `ctx.webServer` |
| `directory-picker/` | Workspace-directory picking seam: capability contract and error vocabulary | `ctx.directoryPicker` |
| `directory-picker-native/` | Native-OS-chooser backend for operators at the host display | registers `ctx.directoryPicker` |
| `directory-picker-browse/` | In-app directory-browser backend, including for remote clients | registers `ctx.directoryPicker` |
| `directory-picker-auto/` | Host-adaptive chooser that mounts the matching backend at boot | mounts a backend |
| `plugin-inventory/` | Read-only projection of current Loader entries | Remote `pluginInventory/list` |

`dsh-host-webserver` is a `node:http` server where other plugins register named routes, upgrade routes, index startup inputs, and one fallback handler. It knows no harness concepts and serves no files — the `/api` bridge, plugin bundles, the HMR event stream, and the SPA dist belong to the plugins that register them. Route matching is fixed: exact over the whole table, then longest prefix, then the fallback handler. It serves browsers only; Electron loads dist over `file://` and carries fetch over an IPC bridge.

The Remote layer sits in the `api/` group: a Client environment can call the business capabilities running on the Host — manage goals, run commands, list the plugin inventory, discover file and session references — as typed method calls, and receive the results or forwarded Host events. `remotes` decides which capabilities are exposed and how each call reaches the right session's agent; `gateway` carries the calls and their results between Client and Host over the shared Connection (`ctx.typertGateway` / `ctx.remote`). Streaming session data is deliberately outside it.

## The client half

The kernel packages boot and serve the page; the UI feature packages present it:

- **Kernel** — `web/` boots the browser shell; `modules/` loads browser-side client modules (`ctx.clientModules`); `connection/` maintains browser-host RPC communication and event delivery (`ctx.connection`); `store/` provides React-free observable and snapshot-store primitives; `hmr/` refreshes client plugins during development; `locale/` provides localization preferences and message dictionaries.
- **Slot composition** — UI features compose through the slot system: `ui-slots/` defines how UI features register and compose extension slots, `ui-renderer/` binds slot data to React and mounts the assembled application (`ctx.uiRenderer`), and `ui-session/` adapts Session Controller state into standard Slot sources and hooks.
- **UI features** — `ui-theme/` applies the selected color theme; `ui-primitives/` provides shared React controls, icons, and content renderers; `ui-attachment/` registers composer and message-image attachment presentation; `ui-layout/` arranges the main application regions; `ui-sidebar/` presents workspace and session navigation; `ui-brand-official/` fills the generic browser-brand slots with the official name and marks; `ui-workspace/` provides workspace selection and creation surfaces.

Each plugin fills declared extension slots with typed props and stores, and the shell renders the assembled tree. All client packages are product packages named `@deepseek-ai/dsh-client-<name>`.

## Related pages

- [Plugin Architecture and Composition](../architecture/overview.md) — how the GUI is composed from profile bundles.
- [SDK and ACP Application Servers](sdk-acp.md) — the out-of-process siblings of this in-process GUI.
