# Agent Graph（可选启用）

[English](README.md) | 中文

用这份组合（composition）补丁在部署上挂载 Agent Graph 各切片：它添加图装配的 host 行与承载图控制单元的 sqlite 存储后端。

## 应用补丁

```sh
dsh web --patch apps/cli/config/examples/graph/cordis.yml
```

补丁必须在基础组合之后加载（与 [`../schedule/cordis.yml`](../schedule/cordis.yml) 同一约定）。应用前请把占位符 `rootSessionId` 替换为部署的图根会话 id，并确认 `subagentProvider` 名称（`spawn` 由 `@deepseek-ai/dsh-subagent-spawn-in-process` 注册）。

## 平面划分

- **宿主组合**（上文 `cordis.yml`）：`graph-host` 发布图服务（`agentGraphController`、`graphHostServices`）——整个进程仅一行。
- **图根会话的 agent preset**：`tool-graph`（三个监管工具 + `orchestration:graph` 段）与 `graph-projection`（`graph` 会话投影单元）是按会话的贡献；它们消费宿主服务且不发布任何服务：

```yaml
# graph root session's agent preset (agent.cordis.yml)
- id: tool-graph
  name: '@deepseek-ai/dsh-tool-graph'
- id: graph-projection
  name: '@deepseek-ai/dsh-graph-projection'
```

工具仅限根会话：它们只为 session 等于图根会话 id 的调用作答。完整切片契约见[图子系统文档](../../../../../docs/subsystems/graph.zh.md)与 `packages/graph/*` 各包 README。
