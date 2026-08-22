# @deepseek-ai/dsh-tool-memory

English | [中文](README.zh.md)

**The model-facing memory surface** of DeepSeek Harness — the five tools
`retain`, `recall`, `reflect`, `memory_edit`, and `learn` over the host
`ctx.memory` service, plus a `memory:project` system-prompt section that
**reloads the session's project memory at the start of every session**.
Ported from the [@oh-my-pi](https://github.com/oh-my-pi) coding-agent memory
surface (see `port_omp.md` item 4); storage lives in
`@deepseek-ai/dsh-memory`.

This package is **agent-plane**: it mounts as a preset row and resolves the
host `memory` service, registering no service of its own — the
`standard`/`code` preset rows sit loose beside `tool-fs` and `tool-ast`.

## The five tools

- `retain` — store one or more durable facts (user preferences, project
  decisions, architectural choices) for future sessions. Batch related facts;
  entries are self-contained, normalized, and deduplicated.
- `recall` — relevance-ranked search over bank + lessons + summary. Returns
  ids that round-trip through `memory_edit`. Use proactively before questions
  about past decisions or preferences.
- `reflect` — synthesize an answer across many stored memories (blends,
  unlike `recall`). Grounding is memory-only; verify repository facts.
- `memory_edit` — `update` (replace content/importance), `forget` (hard
  delete), `invalidate` (soft supersede, optional `replacement_id`). Lesson
  and summary entries are read-only facts.
- `learn` — capture one durable lesson (what/when/why) into `learned.md`;
  write-path neutralization strips prompt-injection markers and secrets.

## Prompt injection

`apply()` registers `systemPrompt.section({ name: 'memory:project', order: 150 })`
whose text is evaluated at each assembly and returns the calling session's
project memory — `memory_summary.md` + `learned.md`, combined and head-tail
truncated to `injectionMaxChars` (default 16000 chars) — or `''` for a
project with no memory yet. The session identity comes from
`context.agent.session.header.cwd`, so each project sees its own bank and a
fresh process picks it up on the very first turn.

## Config

| Key | Default | Meaning |
|---|---|---|
| `root` | `<harness home>/memories` | Must match the `ctx.memory` row's root. |
| `injectionMaxChars` | `16000` | Combined char budget for the injected summary + lessons. |
| `enabled` | `true` | Set `false` to disable prompt injection while keeping the tools. |

## Tests

```sh
pnpm vitest run packages/memory/tool-memory
```
