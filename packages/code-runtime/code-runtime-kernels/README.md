---
description: "Persistent Python and JavaScript kernels for DeepSeek Harness: a self-contained plugin that gives the model a first-class run_kernel_code tool with session state that survives across calls."
kind: "package-reference"
---

# @deepseek-ai/dsh-code-runtime-kernels

English | [中文](README.zh.md)

## Summary

`dsh-code-runtime-kernels` gives the model a `run_kernel_code` tool backed by persistent Python and JavaScript kernels whose session state survives across calls, mounting as a Cordis plugin row. Use it for computation with intermediate results instead of scratch files: share a `session` id, omit it for one-offs, and pass `reset: true` when state is corrupted. Two long-lived subprocesses run self-contained runners (Python standard library only; Node builtins only) under one shared host driver, with configurable budgets and interrupt escalation. The boundary is kernel code holding bash-equivalent trust — robustness, not a security boundary.

## Table of Contents

- [Mounting](#mounting)
- [Config](#config)
- [Tool surface](#tool-surface)
- [Semantics](#semantics)
- [Development](#development)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

**Persistent Python and JavaScript kernels for DeepSeek Harness** — one self-contained plugin that gives the model a first-class `run_kernel_code` tool with session state that survives across calls. No upstream harness changes are required: it mounts as an ordinary Cordis plugin row (via `cordis.patch.yml`) and registers one tool on `ctx.tools`, exactly like the shipped tools.

Two long-lived kernel subprocesses share one host driver:

- **Python** — a long-lived `python3` subprocess running a [self-contained kernel](./src/python/runner.ts) (standard library only — no venv, no pip). Module-level variables and one asyncio event loop persist across cells; top-level `await` works; the last expression is the cell's value.
- **JavaScript** — a long-lived `node` subprocess running a [self-contained kernel](./src/nodejs/runner.ts) (Node builtins only). A persistent `state` object plus the process-global object carry values across cells; every cell runs as an async function body, so top-level `await` and `return` work; `return <json>` carries the completion value.

The wire protocol, kernel host driver (spawn + handshake, serialized writes, hostile-peer parsing, SIGINT with SIGTERM/SIGKILL escalation, shutdown-to-exit), session registry, binding validation, and output ledger are shared (`src/core/`), so both languages behave identically.

This is **process confinement, not a security boundary**: program source has bash-equivalent trust, exactly like the harness's own `process`-isolated backends. The driver's job is robustness — a forged frame never crashes the host, an unresponsive kernel is graded up to termination — not isolation.

## Mounting

Add the bundle row (or a similar row in any `cordis.yml`):

```yaml
- insert:
    - id: code-runtime-kernels
      name: '@deepseek-ai/dsh-code-runtime-kernels'
      config:
        languages: ['python', 'typescript']
        maxWallMs: 600000
        maxOutputBytes: 67108864
        sessionIdleMs: 0
        interruptEscalationMs: 5000
        startupTimeoutMs: 15000
        shutdownGraceMs: 1000
        toolTimeoutMs: 30000
```

All row ids carry the `code-runtime-kernels-` prefix so they never clash with shipped rows (a duplicate loader id fails the boot). Then the model sees the `run_kernel_code` tool.

## Config

| Key | Default | Meaning |
|---|---|---|
| `languages` | `['python', 'typescript']` | Enabled languages; a call to a disabled language is refused at call time. |
| `pythonPath` | `python3` | Explicit python executable (PATH discovery by default; fails loud at first spawn when absent). |
| `nodePath` | `node` | Explicit node executable (PATH discovery by default). |
| `toolTimeoutMs` | `30000` | Cooperative tool-call timeout (`exec.signal` becomes the per-run abort). |
| `maxWallMs` | `600000` | Per-run wall-clock budget; interrupt gradates SIGINT → SIGTERM → SIGKILL when the kernel does not respond. |
| `maxOutputBytes` | `67108864` | Combined serialized log-, completion-, and failure-message byte cap (an `'output-limit'` failure). |
| `sessionIdleMs` | `0` | Reap a session whose kernel sits unused for this long (`0` disables; state loss is the explicit cost). |
| `interruptEscalationMs` | `5000` | Wait after SIGINT before SIGTERM, then the same again before SIGKILL. |
| `startupTimeoutMs` | `15000` | Wait for the bootstrap `ready` handshake before failing the kernel. |
| `shutdownGraceMs` | `1000` | Grace for the kernel to exit after an `exit` frame. |

## Tool surface

`run_kernel_code` takes:

| Parameter | Meaning |
|---|---|
| `language` | `python` or `typescript`. |
| `code` | Program source: for `typescript` an async-function body (top-level `await`/`return` work); for `python` a module (top-level `await` works, the last expression is the completion value — a top-level `return` is invalid Python and is reported as an `exception`). |
| `session` | Optional non-empty id; calls sharing one id keep kernel state. Omit for a one-shot run in fresh state. |
| `reset` | Discard the session's prior kernel state before this run (one reset instead of many retries). |

It resolves the seam's result envelope — `value` (JSON completion), `logs`, `executionCount`, and `error { kind, message }` — so the vocabulary matches the harness's own `run_code` (`exception` / `timeout` / `abort` / `worker-exit` / `invalid-output` / `output-limit`), but with the persistent-session fields this plugin owns (`session`, `reset`, `executionCount`).

## Semantics

- **Sessions.** A call with a non-empty `session` runs in that session's kernel; `executionCount` reports the running count. `reset: true` shuts the old kernel down before a fresh one answers.
- **One-shot.** Without `session`, a fresh kernel is spawned, exactly one program runs, and the kernel is shut down.
- **Persistence.** Python: module-level variables and loop state survive across cells. JavaScript: `state` (a long-lived shared object) and sloppy-mode global assignments survive; `const`/`let`/`function`/`class` at cell top level are per-cell (async body), so persistent definitions go on `state`. A cell completes `return <json>` for a completion value, or with no `return` for a no-value run; non-lossless completions (cycles, `BigInt`, sets) are `'invalid-output'`.
- **Budgets and failure kinds.** Wall-clock expiry → `'timeout'`; cancellation or a kernel that had to die → `'abort'`; thrown exceptions → `'exception'`; non-JSON completions → `'invalid-output'`; combined output overflow → `'output-limit'`; kernel death → the session registry replaces the kernel and retries once. All are result FIELDS, never rejections of the tool.
- **Output overflow recovery.** When a run overflows `maxOutputBytes` (an `'output-limit'` failure), the tool calls `ctx.spillStore.saveText()` with the FULL captured output (logs plus the overflowing completion value) and, on success (a `spillStore` backend is loaded and there is a session owner), appends `full program output preserved at <retrieval-hint>` to the failure message so the tail becomes recoverable instead of dropped. Spill failure is best-effort: it never fails the call or alters the truncated result.

## Development

`pnpm check` (tsc), `pnpm test` (vitest; real `python3`/`node` subprocesses), and the root `tsdown` export (lib/). Layout: shared host driver in [`src/core/`](./src/core/) (protocol, kernel host, session registry, ledger), languages in [`src/python/runner.ts`](./src/python/runner.ts) (embedded source, staged per spawn) and [`src/nodejs/runner.ts`](./src/nodejs/runner.ts) (compiled file, spawned with `node --no-warnings`), the plugin/tool in [`src/index.ts`](./src/index.ts). Tests: [`tests/kernels.spec.ts`](./tests/kernels.spec.ts) drives both kernels through `KernelManager`; [`tests/tool.spec.ts`](./tests/tool.spec.ts) mounts the plugin on a real Cordis context and executes `run_kernel_code` through `ctx.tools.execute`.

## Model Experience

### System prompt

#### What the model sees

One system-prompt section registered by this plugin — `tool:code-runtime-kernels` (order 106) — positions the tool: prefer `run_kernel_code` over scratch files for computation with intermediate results, reuse a `session` id for related calls, omit `session` for one-offs, and pass `reset: true` when a session's state is corrupted or unwanted.

##### run_kernel_code guidance

```markdown
Prefer run_kernel_code to reading/writing scratch files when the work is computation with intermediate results — sessions keep kernel state (variables, imports, working data) across calls. Omit `session` for one-off computations; give related calls the same `session` id to carry state forward, and pass `reset: true` when the session's state is corrupted or unwanted. Python programs persist module-level variables; JavaScript programs persist via `state` and top-level assignments. A session reaps idle kernels after the configured timeout, so long-lived work should resume promptly or persist to disk.
```

#### Token effect

Fixed guidance cost per request while the plugin is active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged; activation or disposal may invalidate reuse from this section.

### Tool schemas

#### What the model sees

The generated [`run_kernel_code` schema](../../../docs/tool-catalog.md#deepseek-aidsh-code-runtime-kernels). `language` and `code` are required; `session` (non-empty id) carries state across calls; `reset` discards the session's prior kernel state before the run.

#### Token effect

Fixed schema cost on every request while enabled; the `toolTimeoutMs` budget is never sent to the model.

#### KV Cache effect

Prefix-stable while the visible tool definition and order are unchanged; registration lifecycle may invalidate reuse from the first changed schema token.

## Known Limitations and Deferred Work

- **A busy synchronous cell resists SIGINT.** A `while (true) {}`/`while True:` loop never yields to the event loop, so the interrupt handler cannot run and the escalation ladder (SIGTERM then SIGKILL) is what actually stops it — costing the kernel's state, hence the session. Cells that yield (async `await` on timers/I/O/tool calls) cancel cleanly and the kernel survives (the wall-clock/timeout tests cover this split).
- **State can be poisoned.** A buggy program can corrupt the session's state at any time; `reset: true` is the intended recovery primitive.
- **No security boundary.** Kernel code has bash-equivalent trust, matching the harness's own process backends.
- **Idle kernels hold a process.** With `sessionIdleMs: 0` (default), session kernels stay alive until reset or plugin teardown, so long-lived work should resume promptly or persist to disk.

**Runtime invariant:** No companion is published. This package owns no continuous runtime relation that a same-process invariant could observe; its behavior is enforced by its package test suites.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
