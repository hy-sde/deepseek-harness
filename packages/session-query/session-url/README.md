# dsh-session-url

English | [中文](README.zh.md)

`session://` — an internal-URL scheme that makes the harness's own session
history navigable as **files** through the ported `read` / `grep` tools.

The handler registers into the shared internal-URL registry
(`ctx.internalUrls`) and reads the same live-preferred logical corpus the
session-query tools read (`ctx.sessionQuery`). No tool code changes: `read`
and `grep` already route any registered scheme through `ctx.internalUrls`.

## URL surface

| URL | Result |
| --- | --- |
| `session://*` (or `session://list`) | Directory listing of known sessions (newest first). |
| `session://<id>` | Rendered transcript — per event `seq \| type \| time` plus indented semantic text. |
| `session://<id>/event` | Directory index of that session's event seqs. |
| `session://<id>/event/<seq>` | One exact event as JSON. |
| `session://search?q=<terms>` (or `session://search/<terms>`) | FTS-backed cross-session hits (degraded when content search is disabled). |

Example:

```
read session://0a1b2c3d4e
grep tsconfig session://0a1b2c3d4e
read session://0a1b2c3d4e/event/42
list session://*
```

## Behavioral notes

- **Immutable:** every resource is read-only history — agents never edit a
  log through a file-shaped URL.
- **Bounded:** transcripts cap at 600 events for display (`read`) and 12 000
  for search consumers (`grep` via `pathOnly`); listings cap at 200 sessions;
  one event's JSON caps at 128 KiB (oversized events degrade to a text
  notice). Every cap is a module export.
- **Search degradation:** deployments that disable content search
  (`openAt: 'never'`) make `session://search` return an explanatory note;
  exact reads (`session://<id>`, `/event`) never depend on the index.
- **Safety:** session ids are unvalidated branded strings used only as the
  URL host; they are never treated as filesystem segments, and the handler
  performs no filesystem access.

## Mounting

Host-plane row alongside the registry it extends (the base bundle), *after*
`@deepseek-ai/dsh-internal-urls`:

```yaml
- id: session-url
  name: '@deepseek-ai/dsh-session-url'
```

Requires `ctx.internalUrls` and `ctx.sessionQuery`; fails loud at apply when
either is missing, so an assembly that mounts the row owns both services.

## Package layout

- `src/handler.ts` — `SessionProtocolHandler` (the scheme's resolve/complete).
- `src/index.ts` — plugin `apply` registering the handler into the registry.
- `src/invariant.ts` — package invariant companion (registration-only).
- `tests/handler.spec.ts` — handler + router-integration tests.

## Known Limitations and Deferred Work

- `session://search` needs a content-search-enabled session-query engine (FTS). A deployment that disables content search (`openAt: 'never'`) receives an explanatory degrade instead of cross-session hits — exact reads (`session://<id>`, `/event`) never depend on the index.
- Transcripts render the semantic event projection (`extractSessionEventText`); raw per-event payloads are readable only through `/event/<seq>` JSON, one event at a time.
- Session titles are best-effort: they appear when the title service captured one, and are absent otherwise.
- The handler requires `ctx.internalUrls` and `ctx.sessionQuery` to be mounted; it fails loud at apply rather than partially serving.
