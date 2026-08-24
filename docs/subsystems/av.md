# Av

English | [中文](av.zh.md)

The read-only Automic Vault seam is split across a Host Service ([dsh-av](../../packages/av/av), `ctx.av`) and a Consumer ([dsh-tool-av](../../packages/av/tool-av), the `av_scan`, `av_doctor`, `av_catalog`, and `av_list` schemas). The service shells out to the `av` CLI through the [subprocess seam](subprocess.md); the tool layer owns the model-facing contract. It works with the developer-tool credential manager [Automic Vault](https://www.automicvault.com/) (macOS).

Source: [`packages/av/av/src/service.ts`](../../packages/av/av/src/service.ts)

## Service surface

`ctx.av` is a thin, stateless, read-only wrapper: one instance serves every session and holds no durable state. It resolves the `av` executable (config → `DSH_AV_PATH` → PATH), probes with `av --version`, and parses the CLI's JSON surfaces:

- **Audit** — `scan` runs `av scan --json` (optionally narrowed to named detectors), returning finding-level detail: severity, explanation, remediation, affected files/lines, and the detectors that produced each finding.
- **Hardening verification** — `doctor` runs `av doctor [tool] --json`, returning per-hardener health and `issues` with remediation and stub/target paths.
- **Catalogs** — `detectors` and `hardeners` parse `av detectors --json` / `av hardeners --json` (names, docs links, hardened/applicable status).
- **Secret names** — `list` runs `av list` and returns saved secret **names only**, never values.

Every command runs with its own wall-clock timeout, a `SIGTERM→SIGKILL` grace, bounded collected output, and an abort signal forwarded to the spawned process.

## Security boundary

The seam is read-only by construction and never releases a stored Secret Value:

- No method invokes the value-releasing verbs (`av inject`, `av proxy`, `av save`, `av harden`); `av save` itself is interactive-only (it reads the value from `/dev/tty` with `termios` echo suppression), so there is no non-TTY custody path to wrap.
- `av_list` returns names only, and no command carries a secret on argv.
- Hardening, secret storage, and value injection stay human-led decisions in a terminal the user controls; the tools report exposures and remediation steps rather than mutating the system.

## Model-facing tools

- `av_scan [severity] [detector] [max_findings]` — full audit; findings carry severity, explanation, remediation, affected files/lines, and detectors.
- `av_doctor [tool]` — hardening verification with per-issue remediation and stub/target paths.
- `av_catalog [scope] [max_entries]` — which detectors and hardeners Automic Vault knows, with status and docs links.
- `av_list` — saved secret names only.

When the `av` CLI is missing or broken, every tool degrades to a structured `{ available: false, reason }` value with an installation hint (`brew install --cask automic-vault/isotopes/automic-vault`) instead of throwing.

## Configuration

- `dsh-av` — `avPath`, `timeoutMs`, `maxStdoutBytes`, `maxStderrBytes`, `graceMs`; binary resolution also honors the `DSH_AV_PATH` environment variable.
- `dsh-tool-av` — `maxFindings`, `maxCatalogEntries`, `enabled` (the `av:tools` prompt section).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxav--avservice"></a>

### `ctx.av` — `AvService`

The `ctx.av` service.

```ts cordis-catalog
/**
 * Check whether the `av` CLI is reachable and answering `av --version`.
 * Never throws: an unavailable binary, launch failure, or timeout surfaces
 * as `{ available: false, reason }`.
 * @returns reachability, CLI version when present, and a human reason on failure.
 */
async probe(): Promise<AvProbe>

/**
 * Audit the Mac for supported credential exposures and hazards
 * (`av scan --json`).
 * @param detectors - optional detector-name filter (from `detectors()`); empty means all.
 * @returns the parsed `av scan --json` report.
 */
async scan(detectors: readonly string[] = []): Promise<ScanReport>

/**
 * Verify installed hardening (`av doctor [tool] --json`).
 * @param selector - optional tool name (e.g. `gh`); empty means all.
 * @returns the parsed `av doctor [tool] --json` report.
 */
async doctor(selector?: string): Promise<DoctorReport>

/**
 * Print detector metadata (`av detectors --json`).
 * @returns the parsed report.
 */
async detectors(): Promise<DetectorsReport>

/**
 * Print hardener metadata (`av hardeners --json`).
 * @returns the parsed report.
 */
async hardeners(): Promise<HardenersReport>

/**
 * List saved secret names (`av list`). NAMES only — never values; the
 * value-releasing verbs are deliberately out of this service's surface.
 * @returns sorted saved secret names (only names, never values).
 */
async list(): Promise<string[]>

/**
 * Run one `av` command. A non-zero exit code is returned as data on the run
 * (callers decide whether it is an error); only a launch failure, a signal
 * kill, or a timeout throws {@link AvCommandError}.
 * @param argv - av arguments (never shell-interpreted).
 * @param options - cwd (required), abort signal, stdin text, timeout override.
 * @returns exit code, collected stdout/stderr, and killed flag; throws {@link AvCommandError} on launch/timeout/signal failures.
 */
async run( argv: readonly string[], options: { cwd: string; signal?: AbortSignal | undefined; stdin?: string | undefined; timeoutMs?: number }, ): Promise<CommandRun>
```

Types: [CommandRun](git.md)

Source: [`packages/av/av/src/service.ts`](../../packages/av/av/src/service.ts)
<!-- END GENERATED cordis-surface -->
