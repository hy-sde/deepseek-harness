# @deepseek-ai/dsh-av

English | [中文](README.zh.md)

Agentic Automic Vault plumbing for the DeepSeek Harness: `ctx.av`, a host-plane, read-only wrapper around the [Automic Vault](https://www.automicvault.com/) `av` CLI via the `ctx.subprocess` seam. The model-facing tools in `@deepseek-ai/dsh-tool-av` resolve this host instance.

The service resolves the `av` executable (config → `DSH_AV_PATH` → PATH), probes it with `av --version`, and parses the JSON surfaces `av scan --json` (audit), `av doctor [tool] --json` (hardening verification), `av detectors --json` and `av hardeners --json` (catalogs), plus `av list` (saved secret **names only**).

## Executed commands

| Method | CLI invocation | Purpose |
|---|---|---|
| `probe` | `av --version` | reachability + version, never throws |
| `scan` | `av scan --json [detectors…]` | audit the Mac for credential exposures and hazards |
| `doctor` | `av doctor [tool] --json` | verify installed hardening |
| `detectors` | `av detectors --json` | detector catalog (feed `scan` filters) |
| `hardeners` | `av hardeners --json` | hardener catalog with hardened/applicable status |
| `list` | `av list` | saved secret names only |

All commands run through `ctx.subprocess` with bounded stdout/stderr collection, a wall-clock timeout, and SIGTERM→SIGKILL grace. A non-zero exit is returned as data on the run; only launch failure, signal kill, or timeout throws `AvCommandError`.

## Security boundary

- This service **never invokes the value-releasing verbs** (`av inject`, `av proxy`, `av save`, `av harden`) — they stay human-in-the-loop in a terminal the user controls.
- `av list` returns names only; the service has no method that returns a stored Secret Value, and no command carries a secret on argv.
- No command is shell-interpreted; argv is passed verbatim through the subprocess seam.

## Configuration

```ts
ctx.plugin(avPackage, {
  avPath: '/usr/local/bin/av', // default: DSH_AV_PATH env, else `av` on PATH
  timeoutMs: 120000,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  graceMs: 5000,
})
```

## Known Limitations and Deferred Work

- **No secret custody verbs** — saving, injecting, and proxying Secret Values are intentionally out of surface; `av save` itself is interactive-only (reads from `/dev/tty`), so a future custody tool needs an upstream CLI change.
- **Per-call shell-out** — no persistent connection to the Automic Vault app; each verb spawns `av` and collects bounded output.
- **Scan output can be large** — the 8 MiB stdout cap bounds one `av scan`; the tool layer summarizes before rendering.
