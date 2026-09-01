---
type: Reference
title: Sandbox, Subprocess and Terminal Execution
description: The execution world of DeepSeek Harness — the process-confinement sandbox seam with per-platform backends, the shared subprocess service, the bash/pwsh shell family, persistent PTY terminals, the approval stack, and loop-hygiene guards.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-0c3c7284faf2d3834e3ebeca
    resource: repo://docs/subsystems/approval.md
  - id: openwiki-source-03562e464dac204331bace93
    resource: repo://packages/guard/README.md
  - id: openwiki-source-35b87d78ae08b3e6275206bb
    resource: repo://packages/guard/timeout-policy/README.md
  - id: openwiki-source-b45de972bd8126ab032244c2
    resource: repo://packages/sandbox/README.md
  - id: openwiki-source-1f7d2c01e2e54677bd6f48db
    resource: repo://packages/sandbox/sandbox-local/README.md
  - id: openwiki-source-8fd3c14dec84d3f8332cdd78
    resource: repo://packages/shell/README.md
  - id: openwiki-source-8b8534aa9521116117cdf8db
    resource: repo://packages/subprocess/README.md
  - id: openwiki-source-e4f4ab38ed51f5d843977971
    resource: repo://packages/terminal/README.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# Sandbox, Subprocess and Terminal Execution

Every child process and terminal session the harness runs — bash commands, language servers, persistent shells, and out-of-process subagent backends — starts, observes, and terminates through one shared service (`ctx.subprocess`), with a local provider running them on the host machine. Around it sit the sandbox capacity (process confinement), the shell family (model-facing command execution), the terminal family (persistent PTY sessions), the approval stack, and loop-hygiene guards.

## Sandbox: process confinement

The `sandbox/` group confines subprocess execution to a file-effect policy: commands run `read-only`, write only under the session workspace (`workspace-write`), or run unrestricted (`danger-full-access`). Four packages deliver it: the confinement service (`sandbox/`, `ctx.sandbox`), the per-platform backends (`sandbox-local/`), the shared policy resolver (`sandbox-policy/`, `ctx.sandboxPolicy`), and the Windows write-restriction backend (`sandbox-windows-acl/`, mounted by `sandbox-local` as the win32 backend). A confined call that a policy denies can retry through a user-approved one-time escalation. Confinement is same-world only: it shares the host kernel and filesystem, while containers, microVMs, and remote executors replace whole capabilities instead of registering here.

`sandbox-local` selects one runner per host — Linux runs commands under `bwrap` when that works, otherwise under the Landlock launcher; macOS uses Seatbelt (`sandbox-exec`); Windows uses the ACL restricted-token runner — so every command, and everything it spawns, runs confined. When no runner is usable the provider fails closed with `SANDBOX_UNAVAILABLE`: a command never silently runs unconfined. Each wrap reports how completely the backend enforces the mode (`full` or `partial`) plus the backend's denial signatures, so consumers can tell a broken sandbox apart from a denied command.

- The **bwrap** profile combines a read-only host root, a fresh `/dev`, and `/proc` from a private PID namespace; `workspace-write` adds an ephemeral `/tmp` and a writable workspace bind.
- The **Seatbelt** profile is allow-default with `(deny file-write*)` plus write allow-lists derived from the shared `writableRoots` helper, so exactly the mode's promised file effects are governed.
- The **Windows ACL rung** keeps one deterministic write SID and standing ACE per workspace and a random private temp directory with a distinct SID per live session/workspace pair; it reports `partial` enforcement because the restricted token must retain Everyone and NTFS hard links alias one file object across paths.

## Subprocess: the shared child-process service

`ctx.subprocess` provides executable lookup, bounded output capture with spill recovery, whole-tree termination, and a scrubbed starting environment for every child. The service keeps process lifetime across consumer reloads; consumers own what a process means (a bash command, a language server) and every default that shapes one.

## Shell: the bash/pwsh family

The shell group provides command execution to agents: run a foreground command and read its bounded output, or start a background process and poll it, on POSIX with Bash and on Windows with PowerShell. Exactly one executor implementation is mounted per composition; the sandboxing executors (`bash-sandbox`/`pwsh-sandbox`) confine every command through the sandbox capability, and the model-facing `bash` and `pwsh` tools (plus owner-isolated persistent variants) sit on top of whichever executor is mounted. A profile layer selects exactly one executor (a win32 layer swaps the POSIX rows for the pwsh ones; mounting two fails loud on the duplicate service registration). `shell-env` supplies the managed `DSH_*` environment every shell command receives.

## Terminal: persistent PTY sessions

The `terminal/` group gives agents persistent, owner-scoped terminal sessions: shell and REPL state — cwd, exported variables, activated environments, running interactive children — survives across tool calls. `terminal/` provides the owner-scoped session service behind `ctx.terminals` (sessions get opaque ids, and every operation stays fenced to the owning agent); `terminal-bash/` starts an interactive bash or pwsh shell under the shared sandbox policy; and `tool-terminal/` exposes six model-facing tools with bounded results. A terminal complements the one-shot bash and filesystem tools: use it when work needs interactive stdin or cross-call state. Sessions are process-local and do not survive a harness restart.

## Approval

The user-approval seam of `dsh-user-approval` answers one question: may this specific action proceed? It owns the shared request/outcome vocabulary, the `ctx.approval` dispatch service, the `approval/request` answerer waterfall, the log-only audit pair (`approval/asked` + `approval/decided`), and the per-session `ask`/`never` policy. UI channels may provide human answerers; the ACP automation bridge provides one-shot machine decisions for its own agents. `ApprovalOutcome` is closed and fail-closed: `allowed-once` grants only the asked-about action, and callers deny on `rejected`, `cancelled`, and `unavailable` — a missing, non-owning, throwing, or non-conforming answerer becomes `unavailable` rather than opening the gate.

## Loop-hygiene guards

The `guard/` group keeps the agent loop productive by watching for two common failure patterns. `repeat-tool-reminder` notices when the model repeats the exact same tool call and reminds it to change approach or finish. `timeout-policy` arms a cooperative deadline for tool calls that declare a limit: it asks the tool to stop through `exec.signal`, then maps a settled cancellation to a clear `Error: tool call timed out after <ms>ms` result, and never hard-stops downstream work. Both ship enabled in the `dsh` base bundle; a composition can tune or remove them.

## Related pages

- [Capability Seams](../architecture/seams.md) — the seam pattern behind these families.
- [Filesystem Capability Family](filesystem.md) — the shared execution world's other half.
- [Tool Registry and Execution Pipeline](tools-pipeline.md) — where these consumers execute.
