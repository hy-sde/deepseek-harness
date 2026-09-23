---
description: "Model-facing debug tool over the DSH DAP capability seam: one tool with 28 operations to launch/attach adapters, set breakpoints, step, evaluate, read memory, and more."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-debug

English | [中文](README.zh.md)

## Summary

`dsh-tool-debug` exposes the model-facing `debug` tool over the DSH DAP capability seam (`ctx.dap`): one tool with 28 operations covering launch/attach, breakpoints, continuing and stepping, threads and frames, variables and evaluation, memory, modules, custom requests, output, and termination. Use it when the agent must debug a real process or drive a debugger interactively. It mounts as a plugin row injecting `['tools', 'dap', 'systemPrompt']`, requires a session workspace cwd, and is not concurrency-safe — debug sessions are exclusive, one live session per agent. Boundaries: console interaction is not modeled and the harness does not tunnel debugger ports.

## Table of Contents

- [Plugin](#plugin)
- [Behavior notes](#behavior-notes)
- [Testing](#testing)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

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

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
