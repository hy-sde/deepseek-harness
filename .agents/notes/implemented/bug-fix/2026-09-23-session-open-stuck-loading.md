# Agent Note: A Session open can hang in "Loading history…" forever

Status: implemented

English | [中文](2026-09-23-session-open-stuck-loading.zh.md)

## Problem

Switching back to a session in the Web GUI could leave the chat pane stuck at "Loading history…" with no error, no retry, and no recovery — reopening the session from the sidebar did not help. The same session showed a stale "Deep diving…" running status, so the user could not tell whether the agent was still working.

## Root cause

The client `Session.open()` is a one-way latch: `openState` moves `cold → loading → open | error`, and a never-settling open leaves a permanent `openPromise` that makes every later `open()` call return the same hung promise. Two paths could get there:

1. **A non-Remote throw inside the first-frame publish escapes open().** `SessionEventStream.open()` (a `RemoteJournalStream`) publishes the opening snapshot synchronously inside `open()` — through `replaceGeneration → publish → installWindow → ClientAssistantStream.replace → expandAssistantStream → validateRecord`. A malformed opening `assistantStream` baseline (e.g. a `text-chunks` record whose `dt` length is not `members - 1`) throws a plain `TypeError` there. `doOpen`'s catch ran `if (!isRemoteFailure(error)) throw error`, so this raw throw escaped while `openState` stayed `loading`, and `openPromise` never settled.
2. **`failEventStream` had the same rethrow hole.** A non-Remote failure delivered through the stream's `failed` sink was thrown from the sink, which is an unhandled rejection — the Session was never told.

There was also no wall-clock guard: a first frame that never arrives (network edge, stalled gateway) hung `loading` indefinitely.

## Decision

In [session.ts](../../../../packages/api/session-controller/src/client/sessions/session.ts):

- `doOpen` catch now normalizes **any** error into `openState = 'error'` with `openError` — `isRemoteFailure(error) ? error : remoteFailureOf(error)`, where `remoteFailureOf` wraps non-Remote throws as `new RemoteError('gateway/internal', message, {}, { cause })` (mirroring `remote-stream.ts` `terminalStreamFailure`). `events.dispose()` is also called in the catch.
- `failEventStream` no longer rethrows; same normalization.
- New wall-clock guard: `openWithTimeout` races `events.open()` against `SessionOptions.openTimeoutMs` (default `DEFAULT_OPEN_TIMEOUT_MS = 30_000`; `0` disables). A timeout throws a `RemoteError('gateway/internal', 'session open did not settle within …ms …')`, which lands in the same error path.
- New `Session.reopen()` (+ `ISession.reopen`) resets `openGeneration`, disposes the stale stream, clears `openPromise`/`openState`/`openError`, and re-runs the tail-page open. `resync()` now delegates to it (identical semantics). `open()` was already retryable from `error` once `openPromise` is null; the hang came from the never-settling promise.
- The Chat pane now renders a **Retry** button in the error state (common `t('retry')`), wired via `ChatViewInjected.retryOpen` → `session.reopen()`.

## Alternatives considered

- **Only normalize Remote failures.** Leaves the malformed-baseline and sink-throw holes, and no timeout — the reported hang persists.
- **Reject from `open()`.** The service's `attachOpening` resolves its reference on settle regardless of state; making `open()` reject would change that contract and still leaves the pane without a retry affordance.
- **Retry automatically.** An open retry loop can mask a permanently broken session and multiply gateway traffic; the explicit button keeps the failure visible and user-driven.

## Consequences

- Any open failure (malformed baseline, non-Remote stream error, never-arriving first frame) now lands in `openState = 'error'` instead of hanging `loading` — with a retry button.
- `openError` always reports a `RemoteError`; snapshots that read `openError.code` keep working (code is always `gateway/internal` for wrapped errors).
- `reopen()` is a new public `ISession` verb: all test fixture `SessionFace` literals and the hand-written `api-catalog.ts` declaration mirror it; `FixtureSession` gains the standard fail-loud stub.
- The stale "Deep diving…" running bit is a separate symptom (fresh `Session` seeded from a stale `summary.running`); this fix does not change running-state clearing.

## Verification

- `session.client.spec.ts`: malformed opening baseline → `openState = 'error'` with `gateway/internal` (was: hang in `loading`); never-yielding first frame with `openTimeoutMs: 25` → error "did not settle within 25ms"; `reopen()` after a failed open lands the new window.
- `chat-view.client.spec.tsx`: error state renders the Retry button and clicking it calls `retryOpen`.
- `apply-inject.client.spec.tsx`: `injected.retryOpen()` calls `session.reopen()`.
- Existing suites (`reference-ownership`, `assistant-stream`, `conversation-registry`, plus the full session spec) pass; full client typecheck (`tsc -b tsconfig.client.json`) and oxlint clean.
