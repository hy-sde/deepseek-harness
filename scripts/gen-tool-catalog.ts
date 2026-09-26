/**
 * Generate `docs/tool-catalog.md` from schemas collected by booting each tool
 * plugin. Runtime registration is the source of truth for computed schemas;
 * the manifest is checked against every on-disk `tool-*` package. `--check`
 * verifies the committed artifact. The original decision is recorded in
 * `.agents/notes/archived/process/2026-07-02-tool-schema-catalog.md`.
 */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import GoalService from '@deepseek-ai/dsh-goal'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type Config as ToolsConfig } from '@deepseek-ai/dsh-tools'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment, StoredImageAttachment } from '@deepseek-ai/dsh-attachment'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as WebSearchPublic from '@deepseek-ai/dsh-web-search-public'
import * as WebFetchLocal from '@deepseek-ai/dsh-web-fetch-http'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider, SubagentReportDelivery } from '@deepseek-ai/dsh-subagent'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import * as ToolSubagentReport from '@deepseek-ai/dsh-tool-subagent-report'
import * as ToolSubagentListAgents from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as ToolBashPersistent from '@deepseek-ai/dsh-tool-bash-persistent'
import * as ToolPwshPersistent from '@deepseek-ai/dsh-tool-pwsh-persistent'
import CordisHostRunner from '@deepseek-ai/dsh-cordis-host-runner'
import * as ToolCordis from '@deepseek-ai/dsh-tool-cordis'
import * as ToolPresent from '@deepseek-ai/dsh-tool-present'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolEdit from '@deepseek-ai/dsh-tool-edit'
import * as ToolGraph from '@deepseek-ai/dsh-tool-graph'
import * as ToolStrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolAst from '@deepseek-ai/dsh-tool-ast'
import Memory from '@deepseek-ai/dsh-memory'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import * as KernelTools from '@deepseek-ai/dsh-code-runtime-kernels'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import * as ToolPty from '@deepseek-ai/dsh-tool-terminal'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as ToolSchedule from '@deepseek-ai/dsh-schedule'
import Lsp from '@deepseek-ai/dsh-lsp'
import * as ToolLsp from '@deepseek-ai/dsh-tool-lsp'
import Dap from '@deepseek-ai/dsh-dap'
import * as ToolDebug from '@deepseek-ai/dsh-tool-debug'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as ToolSessionQuery from '@deepseek-ai/dsh-tool-session-query'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import BrowserUseRegistry from '@deepseek-ai/dsh-browser-use'
import * as StagehandBrowserTools from '@deepseek-ai/dsh-experimental-browser-use-stagehand-native'
import type TeamService from '@deepseek-ai/dsh-experimental-agent-team'
import * as ToolTeam from '@deepseek-ai/dsh-experimental-tool-agent-team'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import type PluginManager from '@deepseek-ai/dsh-plugin-manager'
import * as PluginManagerTools from '@deepseek-ai/dsh-plugin-manager/tools'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { registerListSubagentModels } from '../packages/subagent/tool-subagent/src/list-models.ts'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import Git from '@deepseek-ai/dsh-git'
import * as ToolGit from '@deepseek-ai/dsh-tool-git'
import Browser from '@deepseek-ai/dsh-browser'
import * as ToolBrowser from '@deepseek-ai/dsh-tool-browser'
import Av from '@deepseek-ai/dsh-av'
import * as ToolAv from '@deepseek-ai/dsh-tool-av'
import * as ToolLogseq from '@deepseek-ai/dsh-tool-logseq'
import * as ToolCodebaseMemory from '@deepseek-ai/dsh-tool-codebase-memory'
import * as ToolAgentsview from '@deepseek-ai/dsh-tool-agentsview'
import * as ToolOpenWiki from '@deepseek-ai/dsh-tool-openwiki'
import WorkflowEngine from '@deepseek-ai/dsh-workflow'
import type { WorkflowRun, WorkflowStartRequest } from '@deepseek-ai/dsh-workflow'
import * as ToolRalph from '@deepseek-ai/dsh-tool-ralph'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import * as ToolWorkspaceDependencies from '@deepseek-ai/dsh-tool-workspace-dependencies'
import { githubSlug } from './verify-md-links.ts'

/** Attachment seam marker that makes the attachments-conditional `read_image` schema harvestable. */
class CatalogAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = Object.freeze({
    maxImageBytes: 1,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1,
    maxImagePixels: 1,
    maxImageDimension: 1,
    mediaTypes: Object.freeze(['image/png'] as const),
  })

  override validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.reject(new Error('gen-tool-catalog: attachment validation is unreachable during schema harvest'))
  }

  override saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.reject(new Error('gen-tool-catalog: attachment writes are unreachable during schema harvest'))
  }

  override readImage(_ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.reject(new Error('gen-tool-catalog: attachment reads are unreachable during schema harvest'))
  }
}

const root = resolve(import.meta.dirname, '..')
const OUT = 'docs/tool-catalog.md'

/** Workflow tools expose their schemas without executing a program. */
class CatalogWorkflowEngine extends WorkflowEngine {
  start(_request: WorkflowStartRequest): WorkflowRun {
    throw new Error('gen-tool-catalog: workflow execution is unavailable during schema harvest')
  }
}

/**
 * Register the descriptor needed to mount schema-producing consumers. Declares
 * the full capability set of the shipped in-process providers so consumers
 * mount under their shipped defaults (tool-subagent's default numeric maxDepth
 * requires `depthLimit`).
 */
function registerCatalogSubagentProvider(ctx: Context, name: string): void {
  const provider: SubagentProvider = {
    name,
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true, workspace: true },
    inheritsParentContext: false,
    start: () => Promise.reject(new Error('tool-catalog provider cannot start a child')),
    // Declared so consumers configured for continuable background mode mount.
    prepareContinuable: () => Promise.reject(new Error('tool-catalog provider cannot prepare a child')),
  }
  ctx.subagents.registerProvider(provider)
}

/** Minted child-scope keys for packages whose tools are never global. */
const catalogChildScopes = new WeakMap<Context, Agent>()

/**
 * Install one scope-local tool package into an agent-like child scope for
 * schema harvest, without starting a model, Agent loop, or persistence backend.
 * @param ctx - catalog context owning the scope.
 * @param mountScoped - package installer for the scoped context.
 * @param key - agent-like scope key exposed to the package's scope selector.
 * @param inject - services the package installer must await before mounting.
 */
async function mountCatalogChildScope(
  ctx: Context,
  mountScoped: (childCtx: Context) => void,
  key: Agent = { id: SessionId('tool-catalog-child') } as Agent,
  inject: string[] = ['tools', 'systemPrompt', 'subagents'],
): Promise<void> {
  await ctx.plugin(Object.assign((inner: Context) => {
    mountScoped(createScope(inner, key).ctx)
  }, { inject }))
  catalogChildScopes.set(ctx, key)
}

/**
 * Tool package plus its hand-maintained boot recipe. The caller mounts the
 * prompt and registry; each recipe supplies only package-specific seams and
 * config, while `dir` participates in the completeness check.
 */
export interface ToolPackage {
  /** The npm package name, used as the catalog section heading. */
  pkg: string
  /** The `packages/<group>/<dir>` leaf name — matched by the completeness guard. */
  dir: string
  /**
   * Repo-relative implementation source linked per harvested tool. Packages
   * whose tools share one plugin may use a string; split plugins map each tool
   * name to its own source.
   */
  source: string | Readonly<Record<string, string>>
  /** Services or owning runtimes the package requires at execution time. */
  requires: string[]
  /** Session events or other visible state the tools write or affect. */
  writes: string[]
  /** Additional model-visible names shipped by example/app config. */
  shippedNames?: string[]
  /** Plug the injected seams + the tool plugin onto a context that already
   * carries `systemPrompt` + `tools`. */
  mount: (ctx: Context) => Promise<void>
  /** Agent-like scope key whose tool view is catalogued instead of the global view. */
  scope?: (ctx: Context) => Agent
  /**
   * Config for the caller's `ToolRuntime` mount. The registry itself ships a
   * model-facing tool (`run_code`, registered under a non-native `mode`), so
   * ITS catalog entry boots the registry in the mode that exposes it;
   * every other entry uses the default (native) registry.
   */
  toolsConfig?: ToolsConfig
  /**
   * A deployment note rendered after the package's tools, for a fact that
   * booting the package alone cannot show. The registered tool NAME can be a
   * load-time config (`tool-subagent`'s `toolName`), so one package may appear
   * under several names across deployments — the boot yields the package
   * DEFAULT, and this note records the shipped alternatives the model sees.
   */
  note?: string
}

/**
 * The boot manifest: every shipped tool package (a `tool-*` leaf under
 * `packages/`). Ordered by package name (the render order); the completeness
 * guard proves it is exhaustive against the on-disk glob.
 */
const TOOL_PACKAGES: ToolPackage[] = [
  {
    pkg: '@deepseek-ai/dsh-plugin-manager',
    dir: 'plugin-manager',
    source: 'packages/boot/plugin-manager/src/tools.ts',
    requires: ['ctx.tools', 'ctx.pluginManager', 'ctx.sandboxPolicy'],
    writes: ['tool/call', 'tool/result', 'user/message'],
    async mount(ctx) {
      // Schema harvest never executes a management method or opens a profile.
      ctx.provide('pluginManager', {} as PluginManager)
      await ctx.plugin(SandboxPolicy)
      await ctx.plugin(PluginManagerTools)
    },
  },
  {
    pkg: '@deepseek-ai/dsh-mcp-resources',
    dir: 'mcp-resources',
    source: 'packages/mcp/mcp-resources/src/tools.ts',
    requires: ['ctx.tools', 'ctx.mcpResources'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(McpResources)
      ctx.mcpResources.register('catalog', {
        request: () => Promise.reject(new Error('gen-tool-catalog: MCP requests are unreachable during schema harvest')),
      })
    },
  },
  {
    pkg: '@deepseek-ai/dsh-experimental-browser-use-stagehand-native',
    dir: 'browser-use-stagehand-native',
    source: 'packages/experimental/browser-use-stagehand-native/src/index.ts',
    requires: ['ctx.browserUse', 'ctx.agents', 'ctx.tools', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(BrowserUseRegistry)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(StagehandBrowserTools, {
        mode: 'launch', model: { modelName: 'openai/gpt-5.4-mini', apiKey: 'catalog-placeholder' },
      })
    },
  },
  {
    pkg: '@deepseek-ai/dsh-tool-ask-user',
    dir: 'tool-ask-user',
    source: 'packages/interaction/tool-ask-user/src/index.ts',
    requires: ['ctx.tools', 'ctx.userQuestions'],
    writes: ['tool/call', 'tool/result after a UI/provider answers the question'],
    async mount(ctx) {
      await ctx.plugin(UserQuestionService)
      await ctx.plugin(ToolAskUser)
    },
    note:
      'ask_user_question pauses the tool call until the active UI provider returns a human answer.',
  },
  {
    pkg: '@deepseek-ai/dsh-tools',
    dir: 'tools',
    source: 'packages/core/tools/src/ptc.ts',
    requires: ['ctx.tools', 'ctx.ptcRuntime (execution time)', 'ctx.systemPrompt'],
    writes: ['tool/call', 'one tool/ptc-dispatch-start + tool/ptc-dispatch pair per bridged sub-call', 'tool/result'],
    // The registry's OWN tool: run_code exists only under a non-native mode
    // (the registry registers it in its constructor; the PTC runtime is read
    // at assembly/execution time, so the schema harvest needs none mounted).
    toolsConfig: { mode: 'ptc' },
    async mount() {},
    note:
      'Owned by the tool registry as a reserved transport outside filterable capability layers under `mode: ptc` / `mode: both` (see the PTC mode Agent Note). Under `ptc` it is the registry\'s only wire contribution; the other visible capabilities are declared in a generated SDK section in the loaded runtime\'s language, and a program calls them through bindings scheduled under the native concurrency contract (submission-ordered starts and policy; concurrency-safe bodies overlap up to `maxParallelSubCalls`) that re-enter the complete guarded tool pipeline and link each nested execution to this outer result.',
  },
  {
    pkg: '@deepseek-ai/dsh-plan-mode',
    dir: 'plan-mode',
    source: 'packages/plan/plan-mode/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt', 'ctx.userQuestions (execution time, opportunistic)'],
    writes: ['tool/call', 'plan/mode inactive on an approved review', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(PlanModeController, { section: 'Tool catalog schema harvest.' })
    },
    note:
      'exit_plan_mode stays in the model-facing schema while planning is inactive so transitions add no tool-catalog churn on top of the plan-policy change. Its execute path rejects calls outside plan mode; in plan mode it presents the plan over the user-questions seam (approve / keep planning with feedback), and approval logs plan mode inactive at the step boundary.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-bash',
    dir: 'tool-bash',
    source: 'packages/shell/tool-bash/src/index.ts',
    requires: ['ctx.tools', 'ctx.shell', 'ctx.systemPrompt', 'ctx.shellEnv', 'ctx.jobs for run_in_background and the job-backed foreground path'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(BashEnvPlugin)
      await ctx.plugin(LocalBashExecutor)
      // The shipped profiles compose the job registry, and the tool's
      // background surface follows it: harvest the job-backed schema.
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(ToolBash)
    },
    note:
      'The bash tool is the model-facing consumer of the bash executor seam. With a job registry composed every call registers with the generic `ctx.jobs` runtime as it starts, collected/stopped through the `job_*` tools from `@deepseek-ai/dsh-tool-jobs`; without one, or with `enableRunInBackground: false`, the tool registers a foreground-only schema without the `run_in_background` parameter.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-present',
    dir: 'tool-present',
    source: 'packages/deliverables/tool-present/src/index.ts',
    requires: ['ctx.tools', 'ctx.fs', 'ctx.sessionProjections'],
    writes: ['tool/call', 'deliverables/presented after a successful final result', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(ToolPresent)
    },
    note: 'Deliveries belong to the calling Session; Web ui-deliverables supplies source-file opening and cards.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-pwsh',
    dir: 'tool-pwsh',
    source: 'packages/shell/tool-pwsh/src/index.ts',
    requires: ['ctx.tools', 'ctx.shell', 'ctx.systemPrompt', 'ctx.shellEnv', 'ctx.jobs for run_in_background and the job-backed foreground path'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // The pwsh tool consumes the bash executor seam; the schema harvest
      // mounts the pwsh-local implementation so the inject resolves without
      // executing anything (registration never spawns a process). The job
      // registry is composed for the same reason as the bash entry.
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(BashEnvPlugin)
      await ctx.plugin(PwshLocalExecutor)
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(ToolPwsh)
    },
    note:
      'The pwsh tool is the PowerShell-dialect consumer of the bash executor seam for Windows compositions (a PowerShell executor such as `@deepseek-ai/dsh-pwsh-local` backs `ctx.shell`); it mirrors the bash tool call-for-call minus sandbox controls — `run_in_background` runs register with the generic `ctx.jobs` runtime and are collected/stopped through the `job_*` tools, and the managed `DSH_*` environment comes from `@deepseek-ai/dsh-shell-env`. Each call runs in a fresh process (no persistent PTY session), with native `C:\\...` paths and `$env:NAME` variables.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-cordis',
    dir: 'tool-cordis',
    source: 'packages/extensions/tool-cordis/src/index.ts',
    requires: ['ctx.tools', 'ctx.cordisInspect'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(CordisHostRunner)
      await ctx.plugin(ToolCordis)
    },
    note:
      'Creator mode provides two read-only runtime inspection tools. The Cordis host runner supplies the inspection registry; Client queries require a connected page. Author persistent changes as bundles and install them with plugin_manager.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-bash-persistent',
    dir: 'tool-bash-persistent',
    source: 'packages/shell/tool-bash-persistent/src/index.ts',
    requires: ['ctx.tools', 'ctx.terminals', 'an owning Agent at execution time'],
    writes: ['tool/call', 'PTY shell state', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(TerminalSessionService)
      await ctx.plugin(ToolBashPersistent)
    },
    note:
      'One owner-isolated persistent bash tool; deployment composition supplies the PTY backend and may override the model-facing environment description.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-edit',
    dir: 'tool-edit',
    source: 'packages/edit/tool-edit/src/index.ts',
    requires: ['ctx.tools', 'ctx.fs', 'ctx.systemPrompt', 'ctx.lsp (optional: format-on-write / diagnostics-on-write)'],
    writes: ['tool/call', 'fs/write-intent or fs/edit-intent for mutations', 'fs/observed after read presence/absence or successful file operation', 'tool/result'],
    async mount(ctx) {
      // The rich editor injects `fs` like tool-fs; the bare provider suffices
      // for schema harvest. LSP is optional (read via ctx.get), so no server
      // seam is mounted here.
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(ToolEdit)
    },
    note:
      'Four-mode `edit` (replace / patch / apply_patch / hashline) ported from @oh-my-pi. Mount alongside tool-fs with `enableEdit: false` so the rich editor owns the `edit` name.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-pwsh-persistent',
    dir: 'tool-pwsh-persistent',
    source: 'packages/shell/tool-pwsh-persistent/src/index.ts',
    requires: ['ctx.tools', 'ctx.terminals', 'an owning Agent at execution time'],
    writes: ['tool/call', 'PTY shell state', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(TerminalSessionService)
      await ctx.plugin(ToolPwshPersistent)
    },
    note:
      'One owner-isolated persistent pwsh tool, the Windows counterpart of the persistent bash tool; deployment composition supplies a pwsh-dialect PTY backend and may override the model-facing environment description.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-str-replace-editor',
    dir: 'tool-str-replace-editor',
    source: 'packages/fs/tool-str-replace-editor/src/index.ts',
    requires: ['ctx.tools', 'ctx.fs'],
    writes: ['tool/call', 'fs/observed after view presence/absence, edit absence, or successful mutation', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(ToolStrReplaceEditor)
    },
    note:
      'Standalone view/create/unique literal replace/line insert tool over the filesystem seam; it composes with any shell or terminal API.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-fs',
    dir: 'tool-fs',
    source: 'packages/fs/tool-fs/src/index.ts',
    requires: ['ctx.tools', 'ctx.fs', 'ctx.systemPrompt', 'ctx.attachments (image-tool registration)', 'ctx.llm + an image-capable route (image-tool execution)'],
    writes: ['tool/call', 'fs/write-intent or fs/edit-intent for mutations', 'fs/observed after read presence/absence or successful file operation', 'durable attachment (read_image)', 'tool/result'],
    async mount(ctx) {
      // The tool needs `fs`; the bare provider is sufficient because policy
      // changes behavior, not schema shape. The catalog seam marker opts into
      // the attachments-conditional image schema without attachment I/O.
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(CatalogAttachmentStore)
      await ctx.plugin(ToolFs)
    },
    note:
      'The read-before-write/edit policy is added by `@deepseek-ai/dsh-fs-observation-policy` (an `fs/*` event-gate plugin, no schema change); a deployment that loads these tools is expected to also load it. The image tool is not registered without `ctx.attachments`; its schema is route-independent, and execution refuses unless the exact routed model declares image input.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-graph',
    dir: 'tool-graph',
    source: 'packages/graph/tool-graph/src/index.ts',
    requires: ['ctx.tools', 'an owning Agent at execution time (root/direct-only enforcement is host-side)', 'the optional `agentGraphController` service (read via ctx.get)'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(ToolGraph)
    },
    note:
      'Agent Graph supervisor tools over a host-provided controller (Maka port, slice P4): exactly three model-facing tools, view_agent_graph / update_agent_graph / yield_agent_graph, plus the orchestration:graph prompt section. The controller service is optional (ctx.get) so a session creates without a graph host; every call fails loud with [agent-graph-unavailable] until one is provided, and the host enforces root-only, direct-only addressing.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-fs-search',
    dir: 'tool-fs-search',
    source: 'packages/fs/tool-fs-search/src/index.ts',
    requires: ['ctx.tools', 'ctx.subprocess', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // The tools inject `subprocess` (search spawns the packaged ripgrep
      // binary through the seam, not ctx.fs); registration itself never
      // spawns, so the real local service is inert here. `ctx.spillStore` is
      // optional (read via ctx.get) and does not affect the schemas, so no
      // spill backend is mounted.
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: true })
    },
    note:
      'glob and grep are unconditional discovery tools that spawn the packaged ripgrep binary (`@vscode/ripgrep`) through ctx.subprocess as ordinary foreground calls (never background jobs) — no host `rg` install and no shell layer. The catalog uses `sampleOverCapGlobResults: true`; deployments must choose that behavior explicitly. Capped results save the complete formatted list through the optional ctx.spillStore backend; returned locators are follow-up-readable/searchable when the backend exposes local paths in co-located deployments.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-ast',
    dir: 'tool-ast',
    source: 'packages/ast/tool-ast/src/index.ts',
    requires: ['ctx.tools', 'ctx.subprocess', 'ctx.systemPrompt', 'ctx.fs (ast_edit apply)'],
    writes: ['tool/call', 'fs/observed + fs/edit-intent + fs/write-intent for ast_edit apply (via ctx.fs)', 'tool/result'],
    async mount(ctx) {
      // The tools inject `subprocess` (they spawn the packaged ast-grep binary
      // through the seam) and `fs` (ast_edit apply writes through ctx.fs with
      // observation + sandbox policy). Registration never spawns, and the sandbox
      // policy is optional (read via ctx.get), so the bare providers suffice.
      await ctx.plugin(LocalFileSystem)
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(ToolAst)
    },
    note:
      'ast_grep (structural search) and ast_edit (preview / apply structural rewrite) over the packaged ast-grep native binary (`@ast-grep/cli`) — no host ast-grep install and no shell layer. ast_edit always PREVIEWS first (apply defaults to false) and only writes with apply: true, through the filesystem seam (observation + version guard + sandbox policy).',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-memory',
    dir: 'tool-memory',
    source: 'packages/memory/tool-memory/src/index.ts',
    requires: ['ctx.tools', 'ctx.memory', 'ctx.systemPrompt'],
    writes: [
      'tool/call',
      'project memory files under the configured memory root on retain/learn/memory_edit (recall and reflect are read-only)',
      'tool/result',
    ],
    async mount(ctx) {
      // The tools inject `memory` (the host-plane store registered here),
      // `tools`, and `systemPrompt` (the `memory:project` first-turn injection
      // section) — the catalog harness already mounts SystemPrompt and
      // ToolRuntime. Schema harvest only registers the six tools; nothing
      // executes, so no disk writes occur here.
      await ctx.plugin(Memory)
      await ctx.plugin(ToolMemory)
    },
    note:
      'retain, recall, reflect, memory_edit, learn, and mine_sessions over the host `ctx.memory` service, plus a `memory:project` system-prompt section that reloads the session\'s project memory (summary + lessons + working entries) at the start of the next session (port_omp.md item 4). When the harness `sessionQuery` service is mounted alongside (the tool-session-query row), `recall`/`reflect` merge past-session hits (source `session`, read-only, sessionId/seq origin) and `mine_sessions` harvests lessons from completed session logs — digests from compaction summaries, failures from turn/end error reasons, all-completed todos — stored as `learn` entries attributed to the session and deduped per run; without the service every session feature degrades to a no-op. Local-only in this port; the registry seam stays open for Hindsight/Memnopi providers later.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-terminal',
    dir: 'tool-terminal',
    source: 'packages/terminal/tool-terminal/src/index.ts',
    requires: ['ctx.tools', 'ctx.terminals', 'ctx.systemPrompt', 'ctx.jobs at call time for run_in_background'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(TerminalSessionService)
      await ctx.plugin(ToolPty)
    },
    note:
      'The six terminal tools are opt-in and complement one-shot shell/filesystem tools. `terminal_send(run_in_background: true)` registers with `ctx.jobs`; TUI, named key sequences, BEL, resize, auto-start, and cross-agent sharing are absent from the schema.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-goal',
    dir: 'tool-goal',
    source: 'packages/goal/tool-goal/src/index.ts',
    requires: ['ctx.tools', 'ctx.agents', 'ctx.goals', 'ctx.systemPrompt', 'a calling Agent in an authorized open turn'],
    writes: ['tool/call', 'goal/change for mutations', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(GoalService)
      await ctx.plugin(ToolGoal)
    },
    note:
      'create, edit, pause, and resume require direct-human root authority; complete and blocked also accept the exact current goal round. The default blocked lower bound is three admitted rounds.',
  },
  {
    pkg: '@deepseek-ai/dsh-schedule',
    dir: 'schedule',
    source: 'packages/schedule/schedule/src/tools.ts',
    requires: ['ctx.tools', 'ctx.schedule', 'a live root Agent'],
    writes: ['tool/call', 'Schedule storage domain create, update, or delete', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(SessionStore)
      const session = ctx.sessions.create(SessionId('tool-catalog-schedule'))
      const agent = { id: session.id, session } as Agent
      await mountCatalogChildScope(ctx, (childCtx) => {
        ToolSchedule.registerScheduleTools(ctx, childCtx, agent)
      }, agent, ['tools', 'systemPrompt'])
    },
    scope: ctx => catalogChildScopes.get(ctx) as Agent,
    note:
      'Registered in live root Agent scopes while the Schedule service is loaded. '
      + 'Accepts after_seconds, explicit absolute at, bounded fixed-rate every_seconds, daily and weekly '
      + 'local times in an explicit IANA zone, and cron as a five-field expression. '
      + 'Management uses the Host storage domain; due messages resume the original Session.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-debug',
    dir: 'tool-debug',
    source: 'packages/debug/tool-debug/src/index.ts',
    requires: ['ctx.tools', 'ctx.dap', 'ctx.systemPrompt', 'a session workspace cwd'],
    writes: ['tool/call', 'tool/result', 'the composed debuggee process state via the mounted DAP adapter'],
    async mount(ctx) {
      // The tool registers from the seam alone; the 28-op schema is fixed. It
      // needs a real `ctx.dap` provider (this package) at runtime to act.
      // The seam provably spawns nothing during registration, so the real
      // local subprocess service is inert here (same pattern as tool-fs-search).
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(Dap)
      await ctx.plugin(ToolDebug)
    },
    note:
      'debug composes a real debugger (gdb/lldb-dap/debugpy/dlv/...) through the DAP capability seam (ctx.dap) with one exclusive active session: launch/attach, source/function/instruction/data breakpoints, continue/pause/step, threads/stackTrace/scopes/variables/evaluate, disassemble, read_memory/write_memory, modules, loaded_sources, custom_request, output, terminate, sessions. Requires a mounted DAP provider and the spawn seam; with none available, launch/attach return a structured "unavailable" error naming the missing adapter.',
  },
  {
    pkg: '@deepseek-ai/dsh-code-runtime-kernels',
    dir: 'code-runtime-kernels',
    source: 'packages/code-runtime/code-runtime-kernels/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt', 'python3 and node binaries on PATH (or config pythonPath/nodePath) at call time'],
    writes: ['tool/call', 'kernel subprocess session state (per session id, reset on reset: true)', 'tool/result'],
    async mount(ctx) {
      // Registration only registers the tool schema and the system-prompt
      // guide; kernels spawn lazily per run through node:child_process, so
      // nothing executes in the catalog harness.
      await ctx.plugin(KernelTools)
    },
    note:
      'run_kernel_code executes model code in a persistent kernel (python3 subprocess or node subprocess, standard library / builtins only) sharing one host driver: per-session id kernel state with reset, wall-clock budgets, SIGINT→SIGTERM→SIGKILL escalation, and hostile-peer parsing. Process confinement, not a security boundary — the same trust as the harness process backends (port_omp.md item 1).',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-lsp',
    dir: 'tool-lsp',
    source: 'packages/lsp/tool-lsp/src/index.ts',
    requires: ['ctx.tools', 'ctx.lsp', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // The tool registers from the seam alone; the schema does not depend on any provider.
      await ctx.plugin(Lsp)
      await ctx.plugin(ToolLsp)
    },
    note:
      'The lsp tool keeps provider selection and language-server subprocesses behind ctx.lsp, so its model-visible schema stays stable across providers. Requires a registered provider (e.g. `@deepseek-ai/dsh-lsp-stdio`) at runtime; without one, a query returns the structured `LSP_UNAVAILABLE` error rather than changing the schema.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-ralph',
    dir: 'tool-ralph',
    source: 'packages/workflow/tool-ralph/src/index.ts',
    requires: ['ctx.tools', 'ctx.workflowEngine', 'ctx.subagents', 'ctx.systemPrompt', 'a calling Agent (exec.agent parents every fresh round)'],
    writes: ['tool/call', 'tool/result', 'workflow and child session events during execution'],
    async mount(ctx) {
      await ctx.plugin(SubagentRuntime)
      registerCatalogSubagentProvider(ctx, 'mock')
      await ctx.plugin(CatalogWorkflowEngine)
      await ctx.plugin(ToolRalph, { subagentProvider: 'mock' })
    },
    note:
      'A fixed foreground workflow starts one fresh structured child per round; the model selects only the immutable objective and an optional round cap.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-skill',
    dir: 'tool-skill',
    source: 'packages/skill/tool-skill/src/index.ts',
    requires: ['ctx.tools', 'ctx.agents', 'ctx.skills'],
    writes: ['tool/call', 'tool/result', 'user/message replacement catalogs via agent.inject()'],
    async mount(ctx) {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(SkillFileSystem, {
        dshHome: resolve(root, '.tmp/tool-catalog/.dsh'),
        agentsHome: resolve(root, '.tmp/tool-catalog/.agents'),
      })
      await ctx.plugin(ToolSkill)
    },
  },
  {
    pkg: '@deepseek-ai/dsh-tool-session-query',
    dir: 'tool-session-query',
    source: 'packages/session-query/tool-session-query/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt', 'ctx.sessionQuery', 'a calling Agent for workspace authority'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(SessionStore)
      await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:' })
      await ctx.plugin(ToolSessionQuery)
    },
    note:
      'The five read-only tools hide provider cursors and authorize every result from the immutable calling agent session. The package is opt-in; compositions that need enforced deadlines or bounded inline output also mount the generic timeout or spill policies.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-subagent',
    dir: 'tool-subagent',
    source: {
      list_subagent_models: 'packages/subagent/tool-subagent/src/list-models.ts',
      subagent: 'packages/subagent/tool-subagent/src/index.ts',
    },
    requires: ['ctx.tools', 'ctx.subagents', 'ctx.systemPrompt', 'ctx.llm for model discovery and selected-route validation'],
    writes: ['tool/call', 'tool/result', 'child session events through the chosen provider'],
    shippedNames: ['subagent', 'subagent_fork'],
    async mount(ctx) {
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LlmRuntime)
      registerCatalogSubagentProvider(ctx, 'mock')
      await ctx.plugin(ToolSubagent, { provider: 'mock' })
      registerListSubagentModels(ctx, { routes: [{ provider: 'mock', model: 'mock' }] })
    },
    note:
      'The registered delegation name is the load-time `toolName` config (default `subagent`); the default schema above has model selection off, while the discovery schema is shown as the fixed companion available in an enabled Session. Web presets sample the Plugins preference for each new top-level Session and preserve that decision for its child Sessions; `subagent_fork` remains fixed-route. Each instance independently controls whether it reads model-selection settings and its background behavior through `modelSelectionSettings`, `backgroundMode`, and `enableRunInBackground`.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-subagent-control',
    dir: 'tool-subagent-control',
    source: {
      interrupt_agent: 'packages/subagent/tool-subagent-control/src/index.ts',
      list_agents: 'packages/subagent/tool-subagent-control/src/list-agents.ts',
      pending_decisions: 'packages/subagent/tool-subagent-control/src/index.ts',
      send_message: 'packages/subagent/tool-subagent-control/src/index.ts',
    },
    requires: ['ctx.tools', 'ctx.subagents', 'ctx.agents and ctx.sessionProjections (list_agents only)'],
    writes: ['tool/call', 'tool/result', 'child session events through ctx.subagents'],
    async mount(ctx) {
      await ctx.plugin(SubagentRuntime)
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SessionStore)
      await ctx.plugin(ToolSubagentControl)
      await ctx.plugin(ToolSubagentListAgents)
    },
    note:
      'The globally named control tools over continuable background subagents: provider-bound `tool-subagent` instances register distinct delegation tools, while this package registers `send_message` and `interrupt_agent` once, plus `list_agents` from its separately loaded `/list-agents` plugin (whose catalog rows use the sessionProjections and live Agent registries). `pending_decisions` surfaces the keyed open-decision ledger recorded from decision-shaped child reports.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-subagent-report',
    dir: 'tool-subagent-report',
    source: 'packages/subagent/tool-subagent-report/src/index.ts',
    requires: ['ctx.subagents', 'ctx.systemPrompt', 'a live continuable in-process child Agent'],
    writes: ['tool/call', 'tool/result', 'a user-role message in the direct parent session'],
    async mount(ctx) {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SubagentRuntime)
      const { reportDelivery } = ToolSubagentReport.Config({}) as { reportDelivery: SubagentReportDelivery }
      await mountCatalogChildScope(ctx, (childCtx) => {
        ToolSubagentReport.installReportTool(childCtx, ctx, reportDelivery)
      })
    },
    scope: ctx => catalogChildScopes.get(ctx) as Agent,
    note:
      'Registered per continuable in-process child rather than globally, so this schema is visible only '
      + 'inside such a child and survives its global `toolFilter`. The same contribution installs the '
      + 'child-scoped `tool:report` prompt section, which this catalog does not render. The parent-facing '
      + '`send_message` tool is installed independently.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-jobs',
    dir: 'tool-jobs',
    source: 'packages/jobs/tool-jobs/src/index.ts',
    requires: ['ctx.tools', 'ctx.jobs', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result', 'user/message via agent.inject() for background completion notices'],
    async mount(ctx) {
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(ToolJobs)
    },
    note:
      'The kind-agnostic background-job controller: background bash commands, PTY sends, and subagents are read, listed, and killed through the same three tools. Loading the plugin attaches the controller that arms producers\' `ctx.jobs.start()`.',
  },
  {
    pkg: '@deepseek-ai/dsh-experimental-tool-agent-team',
    dir: 'tool-agent-team',
    source: 'packages/experimental/tool-agent-team/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt', 'ctx.agentTeams', 'an exact live Team member Agent'],
    writes: ['tool/call', 'team/member', 'team/message/queued', 'team/message/delivered', 'team/task', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(SessionStore)
      const session = ctx.sessions.create(SessionId('tool-catalog-team-lead'))
      let agent!: Agent
      const membership = {
        get root() { return agent },
        id: session.id,
        role: 'lead' as const,
        name: 'lead',
      }
      ctx.provide('agentTeams', {
        tryMembership: (candidate: Agent) => candidate === agent ? membership : undefined,
        membership: () => membership,
      } as unknown as TeamService)
      await ctx.plugin(Object.assign(async (inner: Context) => {
        agent = {
          id: session.id,
          session,
          options: {},
          status: 'idle',
        } as unknown as Agent
        Object.assign(agent, { ctx: createScope(inner, agent).ctx })
        await inner.agents.register(agent)
      }, { inject: ['tools', 'systemPrompt', 'agents', 'agentTeams'] }))
      await ctx.plugin(ToolTeam)
      catalogChildScopes.set(ctx, agent)
    },
    scope: ctx => catalogChildScopes.get(ctx) as Agent,
    note:
      'All nine tools are scoped to implicit Team Leads and durable teammates. The shipped dsh-base bundle keeps the package disabled; the documented Agent Teams profile patch enables it while disabling the legacy continuable-child control names.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-todo',
    dir: 'tool-todo',
    source: 'packages/todo/tool-todo/src/index.ts',
    requires: ['ctx.tools', 'owning Agent session'],
    writes: ['tool/call', 'todo/write', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    },
    note:
      'todo_write is session-owned state; UIs render the latest todo/write event as a checklist. `allowParallelInProgress` is required with no default, so the catalog states its choice: `true`, whose description invites several `in_progress` items. A deployment choosing `false` receives the same tool with a description asking for exactly one active task.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-workflow',
    dir: 'tool-workflow',
    source: 'packages/workflow/tool-workflow/src/index.ts',
    requires: ['ctx.tools', 'ctx.workflowEngine', 'ctx.systemPrompt', 'a calling Agent (exec.agent parents the script children)'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      await ctx.plugin(SubagentRuntime)
      registerCatalogSubagentProvider(ctx, 'mock')
      await ctx.plugin(CatalogWorkflowEngine)
      await ctx.plugin(ToolWorkflow)
    },
  },
  {
    pkg: '@deepseek-ai/dsh-tool-workspace-dependencies',
    dir: 'tool-workspace-dependencies',
    source: 'packages/skill/tool-workspace-dependencies/src/index.ts',
    requires: ['ctx.tools'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // Schema harvest never prepares a payload; the directory need not exist.
      await ctx.plugin(ToolWorkspaceDependencies, { source: resolve(root, '.tmp/tool-catalog/primary-runtime') })
    },
  },
  {
    pkg: '@deepseek-ai/dsh-tool-web',
    dir: 'tool-web',
    source: 'packages/web/tool-web/src/index.ts',
    requires: ['ctx.tools', 'ctx.web', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // Mount search and fetch providers so both tools register. Their schemas
      // do not depend on provider identity or availability.
      await ctx.plugin(WebRuntime, { searchProvider: WebSearchPublic.PUBLIC_PROVIDER_ID })
      await ctx.plugin(WebSearchPublic)
      await ctx.plugin(WebFetchLocal)
      await ctx.plugin(ToolWeb)
    },
    note:
      'web_search and web_fetch keep provider selection behind ctx.web so model-visible schemas stay stable across backend swaps.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-git',
    dir: 'tool-git',
    source: 'packages/git/tool-git/src/index.ts',
    requires: ['ctx.tools', 'ctx.git', 'ctx.systemPrompt', 'ctx.subagents at call time for review'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // Schema harvest only registers tools; review resolves ctx.subagents at
      // execute time, so no subagent provider is needed to collect schemas.
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(Git)
      await ctx.plugin(ToolGit)
    },
    note:
      'Model-driven git commit + review: `commit` analyzes the staged diff and returns a plan skeleton plus lock-file autoplacement hints; `commit_apply` validates and executes (hunk-aware splits, dependency order, dry-run), and `review` fans the staged diff out to subagent reviewers and aggregates a ship/reject verdict.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-browser',
    dir: 'tool-browser',
    source: 'packages/browser/tool-browser/src/index.ts',
    requires: ['ctx.tools', 'ctx.browser', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // Schema harvest only registers tools; the browser service will not
      // connect anything until a tool call executes, so mounting it with the
      // default config is safe for schema collection.
      await ctx.plugin(Browser)
      await ctx.plugin(ToolBrowser)
    },
    note:
      'Browser tool (port of omp): open/close/run/state over launch (stealth-patched), CDP-attach, or the local relay + extension; observations are ARIA ref trees with click-by-selector, and screenshots write PNG paths.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-av',
    dir: 'tool-av',
    source: 'packages/av/tool-av/src/index.ts',
    requires: ['ctx.tools', 'ctx.av', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // Schema harvest only registers tools; the av service probes the CLI at
      // execute time, so mounting it with the default config is safe for
      // schema collection (binary resolution errors happen per call, not on
      // mount).
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(Av)
      await ctx.plugin(ToolAv)
    },
    note:
      'Read-only Automic Vault tools: av_scan audits the Mac for exposed dev-tool credentials and hazards, av_doctor verifies hardening, av_catalog lists detectors/hardeners, and av_list returns saved secret names only. Outputs never contain Secret Values and hardening stays a human terminal decision.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-logseq',
    dir: 'tool-logseq',
    source: 'packages/logseq/tool-logseq/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // Schema harvest only registers tools; the plugin spawns the logseq CLI
      // at execute time (CLI resolution errors happen per call, not on mount).
      await ctx.plugin(ToolLogseq)
    },
    note:
      'Graph-native Logseq CLI tools (logseq_list/show/search/query/upsert/remove/graph/server) that drive a Logseq database graph headlessly from the terminal — the local alternative to the desktop MCP bridge, adding Datalog query, removal, first-class tasks, and graph lifecycle.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-codebase-memory',
    dir: 'tool-codebase-memory',
    source: 'packages/codebase-memory/tool-codebase-memory/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // Schema harvest only registers tools; the plugin spawns the
      // codebase-memory CLI at execute time (CLI resolution errors happen per
      // call, not on mount).
      await ctx.plugin(ToolCodebaseMemory)
    },
    note:
      'Codebase-intelligence tools (codebase_list_projects/index_repository/index_status/search_graph/query_graph/trace_path/get_code_snippet/get_graph_schema/get_architecture/search_code/detect_changes/manage_adr/ingest_traces/delete_project) that run one-shot queries against the local codebase-memory daemon via the `codebase-memory-mcp cli --json` mode — the local alternative to the stdio MCP client row, sharing the same daemon, indexes, mutation locks and index supervisor.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-agentsview',
    dir: 'tool-agentsview',
    source: 'packages/agentsview/tool-agentsview/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // Schema harvest only registers tools; the plugin spawns the agentsview
      // CLI at execute time (CLI resolution errors happen per call, not on mount).
      await ctx.plugin(ToolAgentsview)
    },
    note:
      'Session-analytics tool (`agentsview` action=list/get/sessionUsage/health/stats/usage/search/recallQuery/recallBrief/exportSessions) that runs one-shot queries against the local agentsview archive — health grades and outcomes, windowed workspace stats, token-cost reports, fts/semantic/hybrid transcript search, the recall brief, and content-free export — built by the agentsview CLI directly from the DeepSeek Harness session store (it parses session.jsonl.zstd itself), the CLI-first pattern that made tool-codebase-memory viable.',
  },
  {
    pkg: '@deepseek-ai/dsh-tool-openwiki',
    dir: 'tool-openwiki',
    source: 'packages/openwiki/tool-openwiki/src/index.ts',
    requires: ['ctx.tools', 'ctx.systemPrompt'],
    writes: ['tool/call', 'tool/result'],
    async mount(ctx) {
      // Schema harvest only registers tools; the deterministic engine runs
      // in-process at execute time and touches no filesystem until a lifecycle
      // tool call resolves a repository root.
      await ctx.plugin(ToolOpenWiki)
    },
    note:
      'Repository wiki lifecycle tools (openwiki_begin/submit_plan/next_page/submit_page/finish) that run the ported openwiki 0.4 deterministic engine core in-process — resumable .run.json checkpoints, page manifests, Grounded Claims with repository evidence resolution, OKF front matter repair + index sync — with no external openwiki CLI, wired to codebase-memory for structural discovery.',
  },
]

/** One package's contribution to the catalog: its schemas plus attribution. */
interface CatalogPackage {
  pkg: string
  sources: Readonly<Record<string, string>>
  requires: string[]
  writes: string[]
  shippedNames?: string[]
  schemas: ToolSchema[]
  /** A deployment note (see {@link ToolPackage.note}), rendered after the tools. */
  note?: string
}

/** The whole catalog: one entry per booted tool package, in manifest order. */
export type ToolCatalog = CatalogPackage[]

/**
 * Assert the boot manifest covers every shipped tool package on disk (a
 * `tool-*` leaf under `packages/`).
 * Booting has no source declaration to enumerate, so this glob restores the
 * "a new tool cannot be silently undocumented" guarantee: an unlisted package
 * fails the generator (and the freshness gate) until it is added to
 * {@link TOOL_PACKAGES}. Exported for a direct negative test.
 *
 * `scanRoot` defaults to the repo root; a test may point it at a fixture tree.
 */
export function assertManifestComplete(packages: ToolPackage[] = TOOL_PACKAGES, scanRoot: string = root): void {
  const onDisk = globSync('packages/*/tool-*', { cwd: scanRoot }).map(p => basename(p)).sort()
  const listed = new Set(packages.map(p => p.dir))
  const missing = onDisk.filter(dir => !listed.has(dir))
  if (missing.length > 0) {
    throw new Error(
      `gen-tool-catalog: ${missing.length} tool package(s) not in the boot manifest: ${missing.join(', ')}. `
      + 'Add each to TOOL_PACKAGES in scripts/gen-tool-catalog.ts so its schema is catalogued.',
    )
  }
}

/**
 * Assert one manifest entry actually registered a tool.
 *
 * A tool package that boots without registering anything is a broken boot, not
 * an empty catalog section. The usual cause is an `inject` the entry's `mount`
 * does not satisfy: cordis leaves the plugin PENDING, every step here still
 * succeeds, and the generator writes a catalog missing that package's tools.
 * The freshness gate stays green because regeneration reproduces the omission.
 * {@link assertManifestComplete} cannot see this: the
 * package IS listed, it just contributed nothing.
 * @param entry - the manifest entry that was booted.
 * @param harvested - how many schemas its boot registered.
 * @throws when the boot registered no tool at all.
 */
export function assertToolsHarvested(entry: ToolPackage, harvested: number): void {
  if (harvested > 0) return
  throw new Error(
    `gen-tool-catalog: ${entry.pkg} booted without registering a single tool. `
    + 'Its plugin is most likely PENDING on a service this manifest entry does not mount — '
    + `compare the plugin's inject with mount() and requires: ${entry.requires.join(', ')}.`,
  )
}

/**
 * Boot each tool package on a fresh Context and harvest its model-facing
 * schemas. A fresh Context per package keeps attribution clean (each entry's
 * schemas come from exactly that package) and isolates a boot failure to its
 * own entry. Disposed after harvest so no executor/provider outlives the run.
 */
export async function collectToolCatalog(packages: ToolPackage[] = TOOL_PACKAGES): Promise<ToolCatalog> {
  assertManifestComplete(packages)
  const catalog: ToolCatalog = []
  for (const entry of packages) {
    const ctx = new Context()
    // Dispose in `finally` so a throw from `mount`/`schemas()` after earlier
    // plugins mounted still tears the context down (no leaked executor/provider
    // fiber) — the repo's "dispose must reach quiescence" rule.
    try {
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime, entry.toolsConfig ?? {})
      await entry.mount(ctx)
      const schemas = ctx.tools.schemas(entry.scope?.(ctx)).sort((a, b) => a.name.localeCompare(b.name))
      assertToolsHarvested(entry, schemas.length)
      catalog.push({
        pkg: entry.pkg,
        sources: Object.fromEntries(schemas.map(schema => [
          schema.name,
          toolSource(entry, schema.name),
        ])),
        requires: entry.requires,
        writes: entry.writes,
        schemas,
        ...entry.shippedNames !== undefined ? { shippedNames: entry.shippedNames } : {},
        ...entry.note !== undefined ? { note: entry.note } : {},
      })
    } finally {
      await ctx.fiber.dispose()
    }
  }
  return catalog
}

/** Resolve one harvested tool to the plugin source that registered it. */
function toolSource(entry: ToolPackage, toolName: string): string {
  if (typeof entry.source === 'string') return entry.source
  const source = entry.source[toolName]
  if (source === undefined) {
    throw new Error(
      `gen-tool-catalog: ${entry.pkg} has no source mapping for harvested tool ${toolName}`,
    )
  }
  return source
}

/** Escape `<>` in prose so VitePress does not read placeholder tokens as HTML, while keeping backtick code spans verbatim. */
export function escapeDescriptionHtml(description: string): string {
  return description
    .split(/(`+[^`]*`+)/)
    .map((segment, index) =>
      index % 2 === 1 ? segment : segment.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    )
    .join('')
}

/** Render one tool's entry: name, description, JSON-Schema parameters, source. */
function renderTool(schema: ToolSchema, source: string): string[] {
  const out = [`### \`${schema.name}\``, '']
  if (schema.description) out.push(escapeDescriptionHtml(schema.description), '')
  out.push('```json', JSON.stringify(schema.parameters, null, 2), '```', '')
  out.push(`Source: [\`${source}\`](../${source})`, '')
  return out
}

function codeList(values: string[] | undefined): string {
  return values?.length ? values.map(value => `\`${value}\``).join(', ') : '-'
}

function tableCell(value: string | undefined): string {
  return value ? value.replace(/\|/g, '\\|').replace(/\n/g, '<br>') : '-'
}

/** Render the full catalog (pure, deterministic given the manifest-ordered input). */
export function render(catalog: ToolCatalog): string {
  const lines: string[] = [
    '<!-- Generated by scripts/gen-tool-catalog.ts — do not edit by hand.',
    '     Run `pnpm run gen-tool-catalog` to regenerate. -->',
    '',
    '# Tool Schema Catalog',
    '',
    'Every model-facing tool a shipped plugin contributes to `ctx.tools`: the `name`, `description`, and JSON-Schema `parameters` the model receives via the system-prompt assembly. It complements the [subsystem pages](subsystems/core.md) (the types plus each page\'s generated Cordis API region) — this page is the *tools* the agent is offered.',
    '',
    'This file is GENERATED and verified fresh by `pnpm run verify-tool-catalog` (part of `doc-sync`) — do not edit it by hand. Unlike the cordis catalog (a pure source-AST pass), this generator BOOTS each tool plugin on a real context and reads `ctx.tools.schemas()`, because a tool schema is not statically knowable (runtime-spread enums, concatenated descriptions, config-driven names, raw-JSON-Schema MCP tools). A completeness guard globs `packages/*/tool-*` and fails if any package is missing from the generator\'s boot manifest, so a new tool cannot be silently undocumented.',
    '',
    'Scope: shipped product tools under `packages/*/tool-*`, each booted with its DEFAULT config, except where a Config field is REQUIRED with no default — there the generator must choose, and the per-package note records which branch this page shows. The registered tool NAME can be a load-time config (e.g. `tool-subagent`\'s `toolName`), so a deployment may expose a package under a different or additional name — a per-package note records those shipped aliases where they exist. The `examples/` demo tools (e.g. `echo`) are excluded, matching the cordis catalog\'s packages-only scope.',
    '',
    '## Tool Package Map',
    '',
    'This table connects model-visible tool names to the plugin package and service seams behind them. Exact JSON Schemas follow in the package sections below.',
    '',
    '| Tool package | Model-visible names | Requires | Writes / affects | Shipped aliases | Deployment note |',
    '| --- | --- | --- | --- | --- | --- |',
    ...catalog.map(entry => `| \`${entry.pkg}\` | ${codeList(entry.schemas.map(schema => schema.name))} | ${codeList(entry.requires)} | ${codeList(entry.writes)} | ${codeList(entry.shippedNames)} | ${tableCell(entry.note)} |`),
    '',
  ]
  for (const entry of catalog) {
    lines.push(`<a id="${githubSlug(entry.pkg)}"></a>`, '', `## \`${entry.pkg}\``, '')
    for (const schema of entry.schemas) {
      // Collection validated that every harvested schema has a source.
      const source = entry.sources[schema.name] as string
      lines.push(...renderTool(schema, source))
    }
    if (entry.note) lines.push(entry.note, '')
  }
  return lines.join('\n')
}

/** CLI entry: default writes the catalog, `--check` fails if the committed copy
 * is stale. Guarded behind an entry-point check so importing this module for
 * tests neither regenerates the committed file nor calls process.exit. */
async function main(): Promise<void> {
  const content = render(await collectToolCatalog())
  if (process.argv.includes('--check')) {
    let committed: string | null = null
    try {
      committed = readFileSync(resolve(root, OUT), 'utf8')
    } catch {
      // Only ENOENT (not yet generated) is expected; a present-but-unreadable
      // file is not a state this repo produces. Either way the remedy is the
      // same — regenerate — so treat a read failure as "stale".
      committed = null
    }
    if (committed === content) {
      console.log(`gen-tool-catalog: ${OUT} is up to date.`)
      process.exit(0)
    }
    console.error(`gen-tool-catalog: ${OUT} is stale. Run \`pnpm run gen-tool-catalog\` and commit ${OUT}.`)
    const committedLines = committed?.split('\n') ?? []
    const generatedLines = content.split('\n')
    const lineCount = Math.max(committedLines.length, generatedLines.length)
    for (let index = 0; index < lineCount; index += 1) {
      if (committedLines[index] === generatedLines[index]) continue
      console.error(`gen-tool-catalog: first difference at line ${index + 1}`)
      console.error(`  committed: ${JSON.stringify(committedLines[index])}`)
      console.error(`  generated: ${JSON.stringify(generatedLines[index])}`)
      break
    }
    process.exit(1)
  }

  writeFileSync(resolve(root, OUT), content)
  console.log(`gen-tool-catalog: wrote ${OUT}.`)
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  await main()
}
