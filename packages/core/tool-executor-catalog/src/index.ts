/** Catalog device presentation plugin: `dyn` transport over a hidden device registry. @module */
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  CATALOG_GUIDANCE,
  DYN_NAME,
  catalogSummary,
  createDynTool,
  projectToolSchema,
  ToolNotFoundError,
} from '@deepseek-ai/dsh-tools'
import type {
  CatalogEntry,
  ToolBatchInput,
  ToolBatchResult,
  ToolDefinition,
  ToolExecutionInput,
  ToolExecutionResult,
  ToolExecutor,
  ToolModelInput,
  ToolPromptSection,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * Presents visible capabilities as a one-line catalog: device tools keep their
 * full schemas out of the prompt and become reachable only through the reserved
 * `dyn` transport (`search` / `docs` / `invoke`), leaving the schema budget to
 * the eagerly-presented tools.
 */
export class CatalogToolExecutor implements ToolExecutor {
  private readonly pipeline: ToolExecutionPipeline
  private dynTransport: ToolDefinition | undefined

  constructor(private readonly ctx: Context, private readonly maxParallel: () => number = () => 10) {
    this.pipeline = new ToolExecutionPipeline(ctx, {
      get: (name, scope, toolSet) => name === DYN_NAME
        ? this.requireCatalogTransport()
        : this.ctx.tools.executable(name, scope, toolSet),
      reject: (name, nested) => {
        if (nested || name === DYN_NAME) return undefined
        const definition = this.ctx.tools.get(name)
        if (definition?.device === true) {
          return new ToolNotFoundError(name, `device tools are callable only through \`${DYN_NAME}\` — invoke \`${name}\` with \`{"op":"invoke","name":"${name}",…}\` instead`)
        }
        return undefined
      },
    })
    this.sections = [{
      name: 'tools:catalog',
      order: this.ctx.systemPrompt.getSectionOrder('CATALOG_ONLY'),
      text: (tools) => {
        const devices = [...tools]
          .filter(definition => definition.device === true)
          .map(definition => ({ name: definition.name, summary: catalogSummary(definition) }))
          .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        if (devices.length === 0) return CATALOG_GUIDANCE
        return `${CATALOG_GUIDANCE}\n\nMounted device tools (${devices.length})\n${devices
          .map(entry => `- ${entry.name} — ${entry.summary}`)
          .join('\n')}`
      },
    }]
  }

  /** Catalog guidance listing this step's mounted devices, when any. */
  readonly sections: readonly ToolPromptSection[]

  describe(tools: readonly ToolDefinition[]): ToolModelInput {
    const eager = tools.filter(definition => definition.device !== true)
    const schemas = eager.map(definition => projectToolSchema(definition, false))
    schemas.push(projectToolSchema(this.requireCatalogTransport(), false))
    return { schemas, knownNames: eager.map(definition => definition.name) }
  }

  execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    return executeToolBatch(input, this.pipeline, this.maxParallel)
  }

  /**
   * The reserved `dyn` catalog transport, built on first need. It never enters
   * the filterable registration layers; the executor appends its schema only on
   * the model surface, mirroring the PTC executor's `run_code` transport.
   * @returns the shared transport definition.
   */
  private requireCatalogTransport(): ToolDefinition {
    this.dynTransport ??= createDynTool({
      entries: agent => this.catalogDevices(agent),
      docsFor: (name, agent) => this.deviceDocs(name, agent),
      invoke: (name, args, exec) => this.invokeDevice(name, args, exec),
    })
    return this.dynTransport
  }

  /**
   * The bounded one-line catalog of a scope's visible device tools, sorted by
   * name. Shared by the prompt section and the `dyn` `search` operation, so the
   * model can never be advertised a device the registry would not resolve.
   */
  private catalogDevices(scope?: ScopeKey): CatalogEntry[] {
    return [...this.ctx.tools.definitions(scope)]
      .filter(definition => definition.device === true)
      .map(definition => ({ name: definition.name, summary: catalogSummary(definition) }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  }

  /**
   * Full docs + JSON schema for one device, or undefined when the name is
   * absent, restricted away, or not mounted as a device. The doc is the ONLY
   * surface that reveals a device's output schema — the native prompt never
   * carries it.
   */
  private deviceDocs(name: string, scope?: ScopeKey): string | undefined {
    const definition = this.ctx.tools.get(name, scope)
    if (definition === undefined || definition.device !== true) return undefined
    const schema = projectToolSchema(definition, true)
    const output = snapshotJsonValue(definition.output.schema)
    const outputText = output === undefined
      ? ''
      : `\n\n## Output schema\n\n${JSON.stringify(output, null, 2)}`
    return `# ${name}\n\n${definition.description}\n\n## Parameters (JSON schema)\n\n${JSON.stringify(schema.parameters, null, 2)}${outputText}`
  }

  /** Run one device through the guarded pipeline as a nested transport dispatch. */
  private async invokeDevice(name: string, args: unknown, exec: ToolRunContext): Promise<ToolExecutionResult> {
    const definition = this.ctx.tools.get(name, exec.agent)
    if (definition === undefined || definition.device !== true) {
      throw new Error(`no such device "${name}": run dyn search to list mounted devices`)
    }
    const input: ToolExecutionInput = {
      callId: ToolCallId(`${exec.callId}:catalog:${name}`),
      rootCallId: exec.rootCallId,
      name,
      arguments: args,
      ...exec.agent !== undefined ? { agent: exec.agent } : {},
      parent: exec.token,
      signal: exec.signal,
    }
    const prepared = await this.pipeline.prepare(input)
    if (prepared.kind !== 'dispatch') return prepared.result
    const outcome = await this.pipeline.dispatch(prepared.exec)
    return this.pipeline.complete(prepared.exec, outcome)
  }
}

/** Cordis plugin name. */
export const name = 'catalog-tool-executor'
/** Tool registration, scoped dispatch, and prompt section ordering. */
export const inject = ['tools', 'systemPrompt']

/**
 * Select catalog device presentation in the mounting scope.
 * @param ctx - context owning this executor's selection and lifetime.
 */
export function apply(ctx: Context): void {
  ctx.tools.setExecutor(new CatalogToolExecutor(ctx))
}
