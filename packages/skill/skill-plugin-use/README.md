---
description: "The composition-declared plugin-advice skill provider enabling deployments to publish per-plugin usage advice as gesture-addressable skills."
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-plugin-use

English | [中文](README.zh.md)

## Summary

Deployments can declare one advice skill per mounted plugin through this provider's configuration: each entry publishes a skill whose body advises the model to prefer that plugin's tools for the current response. Users reach the advice through the `/name` gesture in the chat window or the model reaches it through the standard skill tool; the advice lasts for the response in which it was loaded and nothing binds the session or reroutes tools. Bodies are inline configuration text or a markdown file, and declared tool names render as a trailing tool-map line in the loaded body.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Add one configuration entry per plugin whose usage deserves advice, mount the provider in a composition, and the advices appear in the session skill catalog under their configured names.

### When to choose it

Choose this provider when a deployment mounts tools that need first-party usage guidance — domain-specific tools whose value the model cannot infer from schemas alone — and wants that guidance addressable as `/name` in the chat window. Skip it for plugins whose tools are self-explanatory, and skip it when the requirement is enforcement: the advice is prompt text, not a binding or a route.

### Declare the advices

The provider reads its configuration from the composition. Each entry requires a kebab-case `name` (the same token is the gesture), a `description`, and exactly one of an inline `instructions` body or an `instructionsFile` path; optional `whenToUse` sharpens catalog routing, `tools` lists the plugin's tool names for the trailing tool-map line, and `modelInvocable: false` limits the advice to the user gesture.

```yaml
- name: '@deepseek-ai/dsh-skill-plugin-use'
  config:
    plugins:
      - name: github-ci
        description: Prefer the GitHub CI plugin tools for pipeline questions.
        whenToUse: When the user asks about pull request checks or CI runs.
        instructions: Prefer `ci_status` and `ci_retry`; never guess pipeline state.
        tools: [ci_status, ci_retry]
      - name: notebook
        description: Advise using the notebook plugin for data exploration.
        instructionsFile: advices/notebook.md
```

`instructionsFile` accepts absolute paths, `~`-expanded paths, and paths relative to `config.baseDir` (defaulting to the process working directory); file-backed bodies are re-read on every load, so edits apply without remounting. Entry validation runs at mount: a non-kebab name, a duplicate name, a missing description, or an entry with both or neither body source fails the composition load, while a configured file that is absent at discovery is omitted from the catalog like any other absent skill source.

### Name advices away from client commands

Slash commands resolve client-side before the prompt is assembled, and a configured advice never reaches that namespace: an advice named like a client command (for example `compact` or `plan`) would be shadowed by the command forever because the command intercepts the input first. Pick names that are not client commands.

### Observable success and failures

Configured advices appear in the session catalog under `source: composition` and load through the gesture or the skill tool with their tool-map line appended; a misconfigured entry fails the mount with a `skill-plugin-use:` TypeError naming the entry, and a file-backed advice whose file is missing is silently absent from the catalog.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the provider is wired; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The provider is a config-driven skill source: `apply()` validates and freezes the configured entries, then registers one provider that publishes one candidate per entry at the bundled skill rank (600) under the configured provider name (default `plugin-use`) with the `composition` source label. Inline entries carry their body on the locator; file-backed entries resolve their path at validation and re-check existence on every discovery, re-reading the body on every load.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry, config schema, entry validation, and the advice provider |
| [`tests/skill-plugin-use.spec.ts`](tests/skill-plugin-use.spec.ts) | Context-level registration, discovery, live-edit, omission, and validation-failure behavior |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the registry this provider registers on to how the advice reaches the model.

- [Skill subsystem reference](../../../docs/subsystems/skills.md) — the registry and provider contract this provider implements.
- [skill package](../skill/README.md) — the registry the provider registers on, and the shared rendering of loaded skills.
- [tool-skill package](../tool-skill/README.md) — how the gesture and the skill tool reach the session catalog and the model.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-skill`, which renders the provider's catalog entry and the selected advice body to the model.

#### KV Cache effect

Without advices the provider changes no request. Each configured advice adds one catalog entry to the system prompt, and each loaded advice body enters the conversation at the skill-invocation point; bodies are appended verbatim with the tool-map line, so the prefix grows once per loaded advice for the response in which it was loaded.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the provider does not do. They are current package constraints, not a task backlog.

- **Advice only, never binding** — the loaded body is prompt text: it cannot restrict tools, reroute calls, or survive into a later response, and nothing verifies the advice was followed.
- **Tool names are documentation, not contracts** — the `tools` list renders into the body verbatim; the provider has no access to the agent's tool registry, so it can neither validate the names nor observe the mounted tools.
- **No file watching** — a configured file that appears after discovery is invisible until the next catalog invalidation, and an entry's presence is frozen at discovery time.
- **Workspace skills override advices** — the bundled rank (600) loses to project and user skill ranks, so a same-name skill in the workspace shadows the advice.
- **Gesture names must dodge client commands** — an advice named like a client command is unreachable by gesture because commands resolve first client-side.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
