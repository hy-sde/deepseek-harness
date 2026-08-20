# @deepseek-ai/dsh-dap

English | [中文](README.zh.md)

Debug Adapter Protocol (DAP) capability seam (`ctx.dap`) for the DeepSeek Harness — adapter resolution plus a session manager that launches/attaches, sets source/function/instruction/data breakpoints, continues, pauses, steps, lists threads and stack frames, reads scopes and variables, evaluates expressions, reads/writes memory, disassembles, lists modules/loaded sources, captures program output, and terminates debug sessions through spawned DAP adapters (debugpy, lldb-dap, gdb, dlv, ...).

Ported from [oh-my-pi](https://github.com/oh-my-pi/oh-my-pi)'s `coding-agent/src/dap/*` (MIT) and adapted to the DSH subprocess and node:net bridging.

## The seam

`ctx.dap` is one service instance per mounted session (agent presets mount it inside an isolated `debug` realm, like `lsp-query` for LSP — see `apps/cli/config/agent-presets/cordis/agent.cordis.yml`). Unlike the LSP seam, the provider cannot be remote: a DAP adapter is a local binary that owns the debuggee, so this package is both the service definition and the provider. The model-facing surface lives in [`@deepseek-ai/dsh-tool-debug`](../tool-debug).

## Adapters and config

- Built-in adapter table (debugpy, gdb, lldb-dap, dlv, js-debug-adapter, netcoredbg, rdbg, php/bash/dart/kotlin/elixir debuggers): see `DEFAULT_ADAPTERS`.
- Per-workspace and per-user overlays in `dap.json` (or `dap.yaml` when the content is strictly JSON): the workspace `dap.json`, then `$DSH_HOME|~/.dsh/dap.json`, then `~/dap.json`. Later sources win.
- Launch adapter auto-selection by extension then root markers; attach picks the first installed adapter (debugpy preferred when attaching by port).

## Environment note

Adapters spawn with the harness scrubbed parent environment plus `NON_INTERACTIVE_ENV` overrides (no pagers/editors/prompts). Guests needing credentials must pass them explicitly — they never inherit DSH secrets.

## Connection modes

- `stdio` (default): debugpy, gdb `-i dap`, lldb-dap …
- `socket`: Delve (`dlv dap`) — unix socket on Linux, dial-back on macOS/others.
- `tcp`: js-debug-adapter (`${port}` substituted into `args`).


## Testing

Run package tests with `pnpm --filter @deepseek-ai/dsh-dap test` (vitest). The suite drives a scripted adapter process — no system debugger required — plus a framing/fidelity unit layer and a gated live debugpy round-trip.


## Model Experience

Indirectly, through the `dsh-tool-debug` consumer, which owns the model-facing tool schema and renders every session snapshot the model reads.

#### KV Cache effect

Prefix-stable: this package owns no guidance text, so model-visible prefixes are unaffected by safe updates to the service surface.

## Known Limitations and Deferred Work

- **Adapter availability is environmental** — resolution depends on which debuggers are installed (debugpy/lldb-dap/gdb/dlv ...); a missing adapter is reported with its install command, never auto-installed.
- **No remote providers** — a DAP adapter must be a local binary; remote-port adapters are reached through host-side forwarding, not a remote provider seam.
- **YAML config is v1 JSON-only** — `dap.yaml` parses only strictly-JSON content; richer YAML (anchors, merge keys) is deferred to a future config pass.
- **Credentials are never inherited** — guests that need secrets must be given them explicitly; the scrubbed environment is intentional but may trip adapters that assume a full user environment.
