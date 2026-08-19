# @deepseek-ai/dsh-code-runtime-python

English | [中文](README.zh.md)

A persistent Python backend for the DeepSeek Harness [code-execution seam](../code-runtime/README.md): `ctx.codeRuntime` with `language: 'python'`, `isolation: 'process'`, and **`persistent: true`**. It is the backend that makes the seam's `sessionId`/`reset` fields and `executionCount` real.

One long-lived `python3` subprocess runs an [embedded, self-contained kernel](./src/python-runner.ts) (standard library only — no virtualenv or packages needed). The kernel keeps a persistent namespace and one asyncio event loop, so state assigned in one program survives the next and top-level `await` works in every cell. Tool bindings (`tools.*`) bridge over an NDJSON wire exactly like the worker-thread backend's port: the program is a hostile peer, every inbound frame is re-validated, and own-property lookups keep forged member names from walking prototype chains.

## Service registration

The package default-exports `PythonCodeRuntime`, a `CodeRuntime` subclass registering `ctx.codeRuntime`:

```yaml
- id: code-runtime-python
  plugin: '@deepseek-ai/dsh-code-runtime-python'
  config:
    maxWallMs: 600000
```

## Config

| Key | Default | Meaning |
|---|---|---|
| `pythonPath` | `python3` | Explicit interpreter path; auto-discovery via `PATH` by default. |
| `maxWallMs` | `600000` | Per-run wall-clock budget; the interrupt gradates SIGINT → SIGTERM → SIGKILL when the kernel does not respond. At most `2147483647` (Node's max `setTimeout` delay). |
| `maxOutputBytes` | `67108864` | Combined serialized log-, completion-, and failure-message byte cap (an `'output-limit'` failure). |
| `sessionIdleMs` | `0` | Reap a session whose kernel sits unused for at least this many ms (`0` disables; loss of kernel state is the explicit cost). |
| `interruptEscalationMs` | `5000` | Wait after SIGINT before SIGTERM, then the same again before SIGKILL. |
| `startupTimeoutMs` | `15000` | Wait for the bootstrap `ready` handshake before failing the kernel. |
| `shutdownGraceMs` | `1000` | Grace period for the kernel to exit after the `exit` frame. |

## Semantics

- **Sessions.** A run with a non-empty `sessionId` executes in that session's kernel; `executionCount` reports the running count. `reset: true` shuts the old kernel down before a fresh one answers, making reset a recovery primitive for corrupted state.
- **One-shot.** Without `sessionId` the backend spawns a fresh kernel, runs exactly one program, and shuts it down — one-shot behavior identical in shape to the worker-thread backend.
- **Budgets and failure kinds.** Wall-clock expiry surfaces `'timeout'`; request cancellation or a kernel that had to be killed surfaces `'abort'`; unparseable programs, thrown exceptions, and non-JSON completions surface `'exception'` and `'invalid-output'`; combined output overflow surfaces `'output-limit'`; a kernel that died on its own surfaces `'worker-exit'` through the session registry's replace-and-retry path. All are result FIELDS, never rejections of `run()`.

## Model Experience

Indirectly, through Code Mode in `dsh-tools`, which now exposes `run_code`'s optional `session`/`reset` parameters when this backend is mounted: the model can seed a session, keep data between calls, and recover from corrupted state at first-class cost (one reset call instead of many retries).

## Known Limitations and Deferred Work

- **Interrupt granularity.** A SIGINT that user code swallows (or a C extension holding the GIL) escalates to process termination and state loss; the run is retried once on a fresh kernel.
- **No per-run `cwd`/`env` in the consumer yet** — the kernel honors them when a request carries them, but `run_code` does not pass any.
- **Process confinement, not a security boundary** — model code has bash-equivalent trust, mirroring the worker backend.
