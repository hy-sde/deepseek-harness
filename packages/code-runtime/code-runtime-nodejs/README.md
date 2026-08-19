# @deepseek-ai/dsh-code-runtime-nodejs

English | [中文](README.zh.md)

A persistent JavaScript backend for the DeepSeek Harness [code-execution seam](../code-runtime/README.md): `ctx.codeRuntime` with `language: 'typescript'`, `isolation: 'process'`, and **`persistent: true`**. It is the backend that makes the seam's `sessionId`/`reset` fields and `executionCount` real for JavaScript programs.

One long-lived `node` subprocess runs a [self-contained kernel](./src/runner.ts) (Node builtins only — no packages needed; the kernel lives at `lib/runner.cjs` in the built output). The kernel keeps a persistent `state` object and the process-global object, so values from one program survive the next, and every cell runs as an async function body — top-level `await` and `return` work exactly like the worker-thread backend. Tool bindings (`tools.*`) bridge over an NDJSON wire: the program is a hostile peer, every inbound frame is re-validated, and own-property lookups keep forged member names from walking prototype chains. The wire contract is byte-for-byte the same shape as the Python backend's so the two host drivers stay symmetric.

## Service registration

The package default-exports `NodeJsCodeRuntime`, a `CodeRuntime` subclass registering `ctx.codeRuntime`:

```yaml
- id: code-runtime-nodejs
  plugin: '@deepseek-ai/dsh-code-runtime-nodejs'
  config:
    maxWallMs: 600000
```

## Config

| Key | Default | Meaning |
|---|---|---|
| `nodePath` | `node` | Explicit node executable path; auto-discovery via `PATH` by default. |
| `maxWallMs` | `600000` | Per-run wall-clock budget; the interrupt gradates SIGINT → SIGTERM → SIGKILL when the kernel does not respond. At most `2147483647` (Node's max `setTimeout` delay). |
| `maxOutputBytes` | `67108864` | Combined serialized log-, completion-, and failure-message byte cap (an `'output-limit'` failure). |
| `sessionIdleMs` | `0` | Reap a session whose kernel sits unused for at least this many ms (`0` disables; loss of kernel state is the explicit cost). |
| `interruptEscalationMs` | `5000` | Wait after SIGINT before SIGTERM, then the same again before SIGKILL. |
| `startupTimeoutMs` | `15000` | Wait for the bootstrap `ready` handshake before failing the kernel. |
| `shutdownGraceMs` | `1000` | Grace period for the kernel to exit after the `exit` frame. |

## Semantics

- **Sessions.** A run with a non-empty `sessionId` executes in that session's kernel; `executionCount` reports the running count. `reset: true` shuts the old kernel down before a fresh one answers, making reset a recovery primitive for corrupted state.
- **One-shot.** Without `sessionId` the backend spawns a fresh kernel, runs exactly one program, and shuts it down — one-shot behavior identical in shape to the worker-thread backend.
- **Persistence.** Inside a cell, `state` is a long-lived shared object and sloppy-mode assignments like `x = 41` land on the process-global object — both survive until the session resets or the kernel exits. `const`/`let`/`var`/`function`/`class` at cell top level are scoped to that cell (async-function body), exactly like a Node REPL line that uses top-level `await`, so persistent definitions go on `state` or `globalThis`. A cell completes with an optional value: `return <json>` for a lossless completion, or no `return` for a no-value run; anything not representable as lossless JSON (cycles, `BigInt`, functions) is an `'invalid-output'` failure.
- **Budgets and failure kinds.** Wall-clock expiry surfaces `'timeout'`; request cancellation or a kernel that had to be killed surfaces `'abort'`; thrown exceptions and non-JSON completions surface `'exception'` and `'invalid-output'`; combined output overflow surfaces `'output-limit'`; a kernel that died on its own surfaces `'worker-exit'` through the session registry's replace-and-retry path. All are result FIELDS, never rejections of `run()`.

## Model Experience

Indirectly, through Code Mode in `dsh-tools`, which now exposes `run_code`'s optional `session`/`reset` parameters when a persistent backend is mounted (same `language: 'typescript'` presentation as the worker backend): the model can seed a session, keep data between calls, and recover from corrupted state at first-class cost (one reset call instead of many retries).

## Known Limitations and Deferred Work

- **A busy synchronous cell is uninterruptible by SIGINT** — a `while (true) {}` loop blocks the event loop, so the interrupt handler cannot run and the host's escalation ladder (SIGTERM then SIGKILL, `interruptEscalationMs` apart) is what actually stops it, costing the kernel's state. Cells that yield to the event loop (timers, I/O, awaited tool calls) are cancelled cleanly and the kernel survives.
- **No per-run `cwd`/`env` in the consumer yet** — the kernel honors them when a request carries them, but `run_code` does not pass any.
- **`undefined` completions are no-value runs** (matching the worker backend): a program without `return` resolves with no `value`, and is not an error; `return`-ing a non-JSONable value is the `'invalid-output'` error.
- **Process confinement, not a security boundary** — model code has bash-equivalent trust, mirroring the worker backend.

## Development

The runner is a single TypeScript file, [`src/runner.ts`](./src/runner.ts), with Node builtins only, so it can be compiled by tsdown into the CommonJS [`lib/runner.cjs`](./lib/runner.cjs) that the built package spawns; development tests spawn the raw source directly (Node 22.18+ / 24+ runs erasable TypeScript). `tests/kernel.spec.ts` drives one kernel over the real wire and `tests/provider.spec.ts` covers the full seam contract with real subprocesses.
