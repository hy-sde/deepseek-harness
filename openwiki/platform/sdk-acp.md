---
type: Reference
title: SDK and ACP Application Servers
description: The out-of-process surfaces of DeepSeek Harness — the JSON-RPC SDK (protocol, TypeScript client, stdio server) and the automation-only ACP server, launched behind the sdk and acp profiles.
verified:
  - by: openwiki/0.4.3
    at: 2026-09-01T12:21:12.375Z
sources:
  - id: openwiki-source-115b2dad781e2a2c5b5a980d
    resource: repo://docs/architecture.md
  - id: openwiki-source-0f3fe8a7afb82373ae5a6e95
    resource: repo://packages/acp/README.md
  - id: openwiki-source-fa3d48fb0a355f9284c323f7
    resource: repo://packages/bundle/acp-app/README.md
  - id: openwiki-source-e745acffeb9e6089e3cd7d6d
    resource: repo://packages/bundle/sdk-app/README.md
  - id: openwiki-source-ac871c7d5968931a42b0f0b7
    resource: repo://packages/sdk/protocol/README.md
  - id: openwiki-source-c74d1bff84c2716bba1ad3d3
    resource: repo://packages/sdk/README.md
generated: { by: "harness", at: "2026-09-01T12:21:12.375Z" }
---

# SDK and ACP Application Servers

Two groups let another process drive a DeepSeek Harness runtime out of process: the **SDK** group (JSON-RPC over stdio, with TypeScript and Python clients) and the **ACP** group (the standard Agent Client Protocol, automation-only). Both run behind the `dsh` launcher as profile bundles, so neither defines a separate application.

## SDK: JSON-RPC over stdio

The `sdk` group lets another process drive a complete DeepSeek Harness runtime. The JSON-RPC wire protocol defines the messages, the server plugin serves external clients over stdio, and the TypeScript and Python clients launch `dsh` with a named profile and ordered patches. No package in this group defines a separate application or creates developer projects. SDK clients open sessions, send prompts, and observe session events, agent status transitions, and subagent completions as they happen. The TypeScript client is the design twin of the Python SDK, which speaks the same protocol.

- **`protocol/`** — `dsh-sdk-protocol` lets a runtime and its clients exchange JSON-RPC 2.0 messages over newline-delimited byte streams: one transport class plus the named request, result, and notification types both wire ends speak. It is a pure library — no plugin, no configuration, no registrations.
- **`server/`** — the `dsh-sdk-jsonrpc-server` plugin serves external clients over stdio.
- **`client/`** — the TypeScript client spawns a runtime subprocess and drives agent turns through high-level and protocol-level APIs.

## SDK application bundle

`dsh-sdk-app` is the SDK stdio application as a `dsh` profile bundle over `dsh-base`. Its patch sets the coding-agent persona, mounts an app-owned zero-option command provider, and starts `dsh-sdk-jsonrpc-server` only after that provider accepts the invocation — so `dsh --profile sdk --help` writes help and exits without claiming stdin or stdout. The startup provider binds stdin EOF to the launcher's bounded successful shutdown, and stdout is reserved for newline-delimited JSON-RPC frames. The bundle disables model-generated session titles because the SDK exposes no title surface; deterministic fallback titles remain durable. The standalone `sdk-minimal` bundle reuses the same startup provider with its own profile name, owning a complete explicit SDK tree without `dsh-base`.

## ACP: automation-only Agent Client Protocol

The `acp` group provides one package: a server that lets programs and automation run persistent DeepSeek Harness agents over the standard Agent Client Protocol. A client can create, list, resume, and close sessions; attach standard MCP servers; select model options; send text and image prompts; receive semantic updates; answer permission prompts; and cancel work without a human in the loop. The matching client for spawning such a server from another harness lives in `subagent/subagent-acp`.

`dsh-acp-app` is the automation-only ACP stdio application as a `dsh` profile bundle over `dsh-base`. Its patch sets the coding-agent persona and default model route, mounts an app-owned zero-option command provider, and starts `dsh-acp` only after that provider accepts the invocation. The shipped row creates sessions with `deepseek-official` and `deepseek-v4-flash`; a later patch can replace that row's complete config. Stdout is reserved for newline-delimited ACP JSON-RPC frames, and ACP connection close, SIGINT, and SIGTERM drain the bridge-owned agents and the root profile tree before exit.

## Profile selection

Both servers launch through the same `dsh` CLI: `dsh --profile sdk` and `dsh --profile acp` (the other shipped profiles being `web`, `headless`, and `sdk-minimal`). A deployment selects a different complete composition through profile bundles and patch files, not another app bin.

## Related pages

- [Plugin Architecture and Composition](../architecture/overview.md) — profiles and bundles behind these servers.
- [Web GUI Host and Client](web-gui.md) — the in-process GUI sibling of these out-of-process servers.
