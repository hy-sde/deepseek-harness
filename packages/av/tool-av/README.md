# @deepseek-ai/dsh-tool-av

English | [中文](README.zh.md)

Model-facing [Automic Vault](https://www.automicvault.com/) tools over the host `ctx.av` service. The surface is deliberately read-only: audit the Mac for exposed credentials, verify hardening, inspect the detector/hardener catalog, and list saved secret names — never release a Secret Value into model context.

## Tool surface

- `av_scan [severity] [detector] [max_findings]` — full audit; findings carry severity, explanation, remediation, affected files/lines, and the detectors that produced them.
- `av_doctor [tool]` — hardening verification; healthy/issue per hardener with remediation and stub/target paths.
- `av_catalog [scope] [max_entries]` — which detectors and hardeners Automic Vault knows (names + docs links + status), so the agent can target `av_scan` and `av_doctor` correctly.
- `av_list` — saved secret **names only**, never values.

When the `av` CLI is missing or broken, every tool degrades to a structured `{ available: false, reason }` value with an installation hint (`brew install --cask automic-vault/isotopes/automic-vault`) instead of throwing.

## Security rules

1. No tool output ever contains a Secret Value. `av_list` returns names only; scan/doctor/catalog return paths, configs and advice.
2. The agent reports exposures and proposes the documented fix; running `av harden <tool>`, storing secrets, or injecting into a command stays a human decision in a terminal the user controls.
3. The tools never bypass, disable, or auto-approve an Automic Vault Authorization Gate or Approval.

## Configuration

```ts
ctx.plugin(toolAvPackage, {
  maxFindings: 30, // av_scan finding cap
  maxCatalogEntries: 60, // av_catalog entries per scope
  enabled: true, // av:tools prompt section
})
```

## Model Experience

### Tool schemas

#### What the model sees

Tool descriptions ground the [`av_scan`, `av_doctor`, `av_catalog`, and `av_list` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-av) and state the read-only contract, directing remediation to a human-run `av harden` command so the model audits and reports rather than mutating the system.

#### Token effect

Each tool call adds one tool schema to the request prefix (four small schemas, no enum explosion beyond the three severities), and execution is one subprocess round-trip whose raw stdout is summarized into a compact text render.

#### KV Cache effect

No dynamic fields depend on earlier calls; `av_catalog` output can be re-used across turns but carries no request-prefix invalidation.

### Result values

#### What the model sees

Findings, doctor results, catalog entries, and secret names as plain data — no secrets, no raw CLI trace. The renderer emits the same facts as text for the conversation pane.

#### Token effect

Large audits are capped by `maxFindings` and the summary counts the rest, so token cost stays bounded regardless of machine state (100+ detector configs can otherwise produce large reports).

#### KV Cache effect

Result values are per-call snapshots; no caching layer and no read-back that would change the model's rerun prefix.

### Prompt section

#### What the model sees

One compact card reminding the model that every output is read-only, that hardening/storing/injecting remains a human terminal decision, and that a missing CLI reports an install hint.

#### Token effect

Three short sentences added once to the request prefix; negligible per turn.

#### KV Cache effect

Static section text — no invalidation.

## Known Limitations and Deferred Work

- **No secret custody verbs** — `av save`, `av inject`, and `av proxy` are intentionally absent; `av save` is interactive-only, and value release stays human-in-the-loop. A custody tool is deferred until the upstream CLI gains a non-TTY handoff and can guarantee values never reach model context or argv.
- **No hardening automation** — the tools verify and recommend; `av harden` (root system mutation) is deliberately left for the user to run. A plan-only harden preview could be added later without relaxing that boundary.
- **Filtering is pass-through** — `severity` filtering happens after the CLI returns the full report, so it bounds rendering but not the subprocess output cap.
