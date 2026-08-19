# @deepseek-ai/dsh-code-runtime

English | [中文](README.zh.md)

The **`CodeRuntime`** (`ctx.codeRuntime`) defines WHAT a code runtime does — run one model-written program against a set of host-provided async bindings and report `{ value, logs, error? }` — without saying HOW.

This package owns the Service Definition role of the capability (the bash trio is the template — see [capability seams](../../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md)): providers subclass `CodeRuntime` and register the service; the Consumer is the tool registry's Code Mode, which generates the model-facing SDK and bridges tool dispatch — both specified in the [Code Mode Agent Note](../../../.agents/notes/implemented/feature/2026-06-15-code-mode.md), whose first provider is a Node worker-thread backend. The runtime knows nothing about tools or sessions: it is handed named async functions and a program string, and everything tool-shaped stays with the Consumer.

## Service API (`ctx.codeRuntime`)

| Member | Semantics |
|---|---|
| `run(request)` | Execute one program against the request's bindings. **Resolves with an error FIELD for every program outcome** — parse/transform failure, thrown exception, invalid completion, output overflow, budget expiry, abort, or substrate death (`CodeRunFailure`'s orthogonal `kind` taxonomy); it rejects only for caller misuse of the Service Definition contract (e.g. a run submitted after disposal). The program runs as the body of an async function: top-level `await`/`return` work, and a lossless JSON completion becomes `result.value`. |
| `language` | Readonly descriptor: the source language `run` expects. `'typescript'` and `'python'` are the well-known values — those `dsh-tools` presents; only `'typescript'` has a published backend. Informational, not gating — a consumer that generates language-specific presentation switches on it and fails loud on a language it cannot present. |
| `isolation` | Readonly descriptor: the execution substrate (`'worker-thread'`, `'process'`, `'container'`). A label for deployments and diagnostics, **not a security claim**. |
| `persistent` | Readonly descriptor, default `false`: whether this backend HONORS `sessionId`/`reset` (persistent kernel state across runs). A consumer reads it to decide whether session-shaped UI is on the table; it must tolerate either value. |

Semantics every implementation must honor (contract details in the class JSDoc): binding calls bridge complete lossless-JSON arguments and resolutions with no seam-level byte cap; the program is treated as a hostile peer (arbitrary binding names are own properties, malformed traffic never crashes the host); one-shot backends must not keep state between runs; a persistent backend keeps state ONLY for runs that carry the same `sessionId` and shuts every kernel down at disposal; disposal terminates in-flight runs AND awaits their exit before completing.

## Vocabulary

`CodeRunRequest` (`program`, `bindings`, `signal?`, `sessionId?`, `reset?`) carries everything the runtime acts on — defaulting (time budgets and outer-output cap) is the provider's validated config, never a hidden `??` inside `run()`. `bindings` is a list of `CodeBindingNamespace`s (`global` + `functions` + optional `errorClass`), each exposed to the program as one global object of async callables returning `CodeJsonValue`, the service-local structural equivalent of canonical `JsonValue` that keeps this Service Definition package independent of sessions. An `errorClass` descriptor names a real program-global constructor and the own property that receives the rejected member name; runtimes remain independent of Consumer terms such as `ToolCallError`. `CodeRunResult` reports the lossless JSON completion `value?`, ordered `logs: string[]`, the `executionCount?` of a persistent session (when the run used one), and the `error?` (`CodeRunFailure`: `kind` + model-feedable `message`). See `src/types.ts` for the full contracts.

**Persistence contract:** a run carrying a non-empty `sessionId` executes in the kernel state of runs that carried the same id — whenever the mounted backend is persistent. The backend owns the session lifecycle (spawn on first use, idle reaping, shutdown at disposal); callers MUST NOT rely on a session outliving the runtime. `reset: true` discards that session's state before the run and waits for the previous kernel's shutdown, so `reset` becomes a first-class recovery for programs that corrupted their own state.

Binding-global and error-class names are **language-portable**: they must match the identifier subset `[A-Za-z_][A-Za-z0-9_]*` (no JS-only `$`) and clear the seam-exported exclusion sets, so one `bindings` list is valid against every backend regardless of its `language`. The package exports the contract every backend enforces — `PORTABLE_RESERVED_WORDS` (ECMAScript ∪ Python reserved words), `RESERVED_BINDING_GLOBALS` (backend-owned globals such as `console`), `RESERVED_ERROR_MEMBERS` and `DUNDER_MEMBER` (error-member exclusions) — so a name like `$tools`, `lambda`, or `__dsh_main__` makes `run()` reject as seam misuse on any backend, not just some. See `src/index.ts` for the exact sets and rationale.

## Model Experience

Indirectly, through Code Mode in `dsh-tools`, which exposes `run_code` and returns program logs, values, or failures as retained tool-result tokens.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **`run()` collects logs to the resolved result** — `logs` arrive on the resolved `CodeRunResult` only; the seam exposes no streaming-log or progress API for a live program's output. A persistent kernel backend may emit finer-grained frames than the result can carry, and the Consumer still renders only the outer `logs`/`value`/`error`.
- **Persistence is backend-option, not universal** — the worker-thread backend stays one-shot and ignores `sessionId`/`reset`; the persistent `process` backends honor them (`@deepseek-ai/dsh-code-runtime-python` for Python and `@deepseek-ai/dsh-code-runtime-nodejs` for JavaScript). Every backend that adds persistence brings its own logging story, per the [Code Mode Agent Note](../../../.agents/notes/implemented/feature/2026-06-15-code-mode.md).
- **Only the worker-thread and Python backends ship** — `'container'` is a declared well-known `isolation` value with no implementation; a hard security boundary awaits a container backend.
- **Intermediate binding values have no byte cap** — implementations remain subject to structured-clone cost and process memory, while a provider or executor may already have imposed its own acquisition bound.
