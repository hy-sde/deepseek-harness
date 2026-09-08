# Agent Graph (opt-in)

English | [中文](README.zh.md)

Mount the Agent Graph slices on a deployment with this composition patch: it adds
the host row for the graph assembly, re-enables the host compaction row
`graph-host` requires, and points the web composition's `storage-sqlite` row at
the graph control unit's database.

## Applying the patch

```sh
dsh web --patch apps/cli/config/examples/graph/cordis.yml
```

The patch must load after the base composition (same convention as
[`../schedule/cordis.yml`](../schedule/cordis.yml)). Before applying, replace the
placeholder `rootSessionId` with the graph root session id of the deployment and
confirm the `subagentProvider` name (`spawn` is registered by
`@deepseek-ai/dsh-subagent-spawn-in-process`).

The patch also re-enables the base `compaction-basic` host row: `graph-host`
injects the host-plane `compaction` service, and the shipped Web composition
disables that row because compaction ownership moved to agent presets. Presets
keep their isolated per-agent engines; the re-enabled host row serves
host-plane consumers such as `graph-host`.

## Planes

- **Host composition** (`cordis.yml` above): `graph-host` publishes the graph
  services (`agentGraphController`, `graphHostServices`) — exactly one row for
  the process.
- **Graph root session's agent preset**: `tool-graph` (the three supervisor
  tools + `orchestration:graph` section) and `graph-projection` (the `graph`
  session-projection unit) are per-session contributions; they consume host
  services and publish nothing:

```yaml
# graph root session's agent preset (agent.cordis.yml)
- id: tool-graph
  name: '@deepseek-ai/dsh-tool-graph'
- id: graph-projection
  name: '@deepseek-ai/dsh-graph-projection'
```

The tools are root-only: they answer only for calls whose session equals the
graph root session id. Full slice contracts: the
[graph subsystem doc](../../../../../docs/subsystems/graph.md) and the
package READMEs of `packages/graph/*`.
