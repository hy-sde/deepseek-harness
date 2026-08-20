# @deepseek-ai/dsh-tool-debug

English | [中文](README.zh.md)

Model-facing `debug` tool over the DSH DAP capability seam (`ctx.dap`): one tool, 28 operations — launch/attach, source/function/instruction/data breakpoints, continue/pause/step, threads/stack_trace/scopes/variables/evaluate, disassemble, read_memory/write_memory, modules, loaded_sources, custom_request, output, terminate, sessions.

Ported from [oh-my-pi](https://github.com/oh-my-pi/oh-my-pi)'s `coding-agent/src/tools/debug.ts` (MIT) and reworked onto the DSH tool contract (`ctx.tools` + `ctx.dap` + `ctx.systemPrompt`).

## Plugin

- `name`: `tool-debug`, `inject`: `['tools', 'dap', 'systemPrompt']`
- Config: `maxResultChars` (16000), `requestTimeoutSec` (30), `timeoutMs` (120000, enforced by `dsh-tool-call-timeout-policy`).
- Requires a session workspace cwd (`exec.agent.session.header.cwd`) and is not concurrency-safe: debug sessions are exclusive.

## Behavior notes

- One active session: an active session must be terminated (or has terminated/exited) before another launch/attach.
- Paths resolve against the session workspace; `cwd` overrides per call.
- Per-request timeout aborts via a combined `AbortSignal` (call + timeout).
- Adapter selection errors name the missing adapter and the install command.
- Breakpoint mutations are serialized per session, and (for js-debug session trees) propagated to every live session in the tree.


## Testing

`pnpm --filter @deepseek-ai/dsh-tool-debug test` (vitest) covers argument parsing, rendering, and an end-to-end launch/breakpoint/step/evaluate flow through a scripted DAP adapter.


## Model Experience

Indirectly, through the `ctx.dap` capability seam whose session snapshots this tool renders into launch, breakpoint, step, stack, and evaluate results.

#### KV Cache effect

Prefix-stable while the plugin is active: the tool schema and guidance never change mid-run, so earlier calls' prefixes remain reusable.

## Known Limitations and Deferred Work

- **Exclusive sessions** — one live debug session per agent at a time because the seam serializes breakpoint mutations; concurrent debugging across files is deferred.
- **Console interaction is not modeled** — launch arguments are passed statically; no interactive stdin/stdout debuggee console is exposed yet, only captured output.
- **No post-mortem attach helpers** — core-dump analysis and preload-based attach (dlv `--headless` patterns) are not wrapped; raw `attach` is available for port-based cases.
- **Remote targets** — attaching across hosts requires an adapter that speaks socket/tcp; the harness does not tunnel debugger ports itself.
