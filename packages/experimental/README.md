---
description: "The experimental group map: publicly installable pre-stable prototypes."
kind: "package-group"
---

# packages/experimental

English | [中文](README.zh.md)

## Summary

Install and compose experimental capabilities explicitly, without a product-support commitment. Package naming and publication follow the [experimental package policy](../../scripts/experimental-package-policy.ts). The [optional-bundle rule](../../.agents/notes/implemented/architecture/2026-09-21-experimental-capabilities-as-optional-bundles.md) determines which capabilities ship switched off with the installation for explicit selection in the GUI plugin manager’s Official group; the Liveshare owner bundle and its shared protocol package are among them. The [plugin manager page](../client/ui-plugin-manager/README.md#use-this-package) owns which bundles appear by default and how to enable hidden ones.

## Table of Contents

- [Experimental, optional, and Official](#status)
- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="status"></a>
## Experimental, optional, and Official

**Experimental** means the complete public capability remains under evaluation and is not a product-support commitment. Its behavior or API may change, and the capability may be withdrawn; engineering, security, documentation, testing, and released-data obligations still apply. A package belongs here only when its entire public contract is experimental or internal-only; an experimental option inside a product package stays with that product role.

**Optional** means a user explicitly selects the capability. **Official** means the project maintains and lists the package in the Plugins page. Neither describes maturity; publication, default installation, and GUI visibility do not determine maturity either. Product packages outside this group have maintained product roles, while their public APIs still follow the repository's pre-stable policy.

Promotion requires a named product role, documented public behavior and limitations, current consumers, release contents, and test evidence. Move the package to its product group, apply that group's naming rules, and update affected consumers together. The [subtree rules](AGENTS.md) govern dependency isolation and publication.

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`action-cards`](action-cards/README.md) | Optional action cards below answers: the proposal tool, card state, user actions and status notices | `ctx.actionCards` |
| [`client-ui-action-cards`](client-ui-action-cards/README.md) | Card frame below completed answers, kind bodies and the proposal process row | — |
| [`creation-recommendations`](creation-recommendations/README.md) | Explicit-need creation of persistent removable interface plugins | — |
| [`client-ui-creation-recommendations`](client-ui-creation-recommendations/README.md) | Personalized page card body with location selection and undo | — |
| [`plugin-recommendations`](plugin-recommendations/README.md) | Explicit-need official plugin recommendations in conversations | `ctx.pluginRecommendations` |
| [`client-ui-plugin-recommendations`](client-ui-plugin-recommendations/README.md) | Official plugin card body with catalog text and enabling | — |
| [`tool-session-query`](tool-session-query/README.md) | Workspace-authorized model session search, trace, and event reads | — |
| [`hook-protocol`](hook-protocol/README.md) | Hook bridge wire types and durable events | — |
| [`hooks-claude-code`](hooks-claude-code/README.md) | Claude Code hook bridge | — |
| [`hooks-codex`](hooks-codex/README.md) | Codex hook bridge | — |
| [`session-title-all-prompts-llm`](session-title-all-prompts-llm/README.md) | Session titles from all human prompts | — |
| [`tool-terminal`](tool-terminal/README.md) | Persistent terminal tools | — |
| [`tool-ralph`](tool-ralph/README.md) | Bounded repeated delegated tasks | — |
| [`skill-badge`](skill-badge/README.md) | The powered-by-dsh badge skill | — |
| [`speech-to-text`](speech-to-text/README.md) | Named speech recognition providers | `ctx.speechToText` |
| [`speech-to-text-sensevoice`](speech-to-text-sensevoice/README.md) | Managed local SenseVoice inference | — |
| [`api-speech-to-text`](api-speech-to-text/README.md) | Authenticated transient transcription Remote | `ctx.speechController` |
| [`agent-team`](agent-team/README.md) | Named teammates with direct messages and a durable shared task board | `ctx.agentTeams` |
| [`client-ui-agent-team`](client-ui-agent-team/README.md) | Team roster, task board, and teammate navigation for Web | — |
| [`client-ui-stats`](client-ui-stats/README.md) | Per-turn and per-step context, timing, cache, and tool cost for Web | — |
| [`subagent-oar`](subagent-oar/README.md) | Run standalone external coding-agent tasks through OAR | `ctx.subagents` |
| [`tool-subagent-oar`](tool-subagent-oar/README.md) | Select a configured external agent for each delegated task | `ctx.tools` |
| [`claude-code-mods`](claude-code-mods/README.md) | Run Claude Code mods as plugins: their hook chains on harness extension points and a band above the prompt | `ctx.claudeCodeMods` |
| `client-ui-claude-code-mods` | The Web band that draws a mod's tree above the prompt and sends button clicks back | — |
| [`ptc-runtime-python`](ptc-runtime-python/README.md) | CPython subprocess backend for the PTC execution seam | `ctx.ptcRuntime` |
| [CUA](cua/README.md) | Application/window objects, authorized execution, and permission controls. | `ctx.cuaAccess` |
| [`cua-bundle`](cua-bundle/README.md) | Optional Computer Use switch for PTC sessions | — |
| [`computer-use-cua-driver-mcp`](computer-use-cua-driver-mcp/README.md) | Use an installed Cua Driver through MCP | `ctx.computerUse` |
| [`computer-use-cua-driver-native`](computer-use-cua-driver-native/README.md) | Embed the Cua Driver native npm runtime | `ctx.computerUse` |
| [`browser-use-playwright-mcp`](browser-use-playwright-mcp/README.md) | Playwright browser tools over MCP | `ctx.browserUse` |
| [`browser-use-chrome-devtools-mcp`](browser-use-chrome-devtools-mcp/README.md) | Chrome DevTools inspection and browser control over MCP | `ctx.browserUse` |
| [`browser-use-stagehand-native`](browser-use-stagehand-native/README.md) | Stagehand browser operations with explicitly configured native models | `ctx.browserUse` |
| [`browser-use-runtime`](browser-use-runtime/README.md) | Session-owned browser resources shared by experimental providers | — |
| [`inspector`](inspector/README.md) | Cross-realm CDP hub for Host debugging, Client Runtime inspection, network capture, and Cordis trees | `ctx.inspector` |
| [`session-inspector`](session-inspector/README.md) | Sidebar tables for raw Session logs and Chat nodes | — |
| [`tool-agent-team`](tool-agent-team/README.md) | Nine tools that let the model create, message, and coordinate teammates | registers scoped tools on `ctx.tools` |
| [`webworker-packer`](webworker-packer/README.md) | Builds the gzip-compressed VFS image consumed by the browser worker preview | library and CLI — no ctx key |
| [`webworker-runtime`](webworker-runtime/README.md) | Runs the harness plugin tree inside a dedicated browser worker | library and worker entry — no ctx key |
| [`worktree`](worktree/README.md) | Creates a named Git worktree and changes the calling Session directory | `ctx.worktrees` |
| [`forge`](forge/README.md) | Code host provider registry with shared change request polling | `ctx.forge` |
| [`forge-github`](forge-github/README.md) | GitHub provider that reads pull requests through the host GitHub CLI | registers a provider on `ctx.forge` |
| [`forge-session`](forge-session/README.md) | Binds change requests to the Sessions that created, pushed, or tracked them | `ctx.forgeSession` |
| [`client-ui-forge`](client-ui-forge/README.md) | GUI panel for a Session's Git checkout, worktrees, and bound pull requests | `ctx.forgePanel` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Experimental publication reference](../../scripts/experimental-package-policy.ts) — public defaults and private exceptions.
- [Worktrees](../../docs/subsystems/worktrees.md) — explicit branch and checkout creation.
- [Forges](../../docs/subsystems/forge.md) — change request providers, status polling, Session bindings, and the panel.
- [Computer use](../../docs/subsystems/computer-use.md) — desktop provider choices.
- [Browser use](../../docs/subsystems/browser-use.md) — browser provider choices and Session ownership.
- [Agent Teams subsystem](../../docs/subsystems/agent-team.md) — durable Team types and the `ctx.agentTeams` service API.
- [Experimental subtree rules](AGENTS.md) — what experimental status does and does not relax.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
