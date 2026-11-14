/**
 * Register the DeepSeek Search and Fetch APIs in `ctx.web` as `deepseek-search-api`
 * and `deepseek-fetch-api`. Each operation is one direct API request without an
 * auxiliary model request. `web.searchProvider` and `web.fetchProvider` select them. The API key is that of the
 * DeepSeek API-key route, sent to its origin, or `DEEPSEEK_API_KEY` sent to the official base without that route. An
 * operation that needs a mounted route whose settings do not resolve fails instead of changing its endpoint or
 * credential. A capability with its own `*BaseURL` or `*ApiKeyEnv` uses only that endpoint and
 * key instead
 * ([rationale](../../../../.agents/notes/implemented/architecture/2026-10-29-web-provider-selection.md#credential-resolution)).
 * Both providers report themselves not ready when their next operation would have no credential.
 * @module @deepseek-ai/dsh-web-deepseek-api
 */
import { FiberState, type Context, type Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-llm'
import {
  deepSeekApiKeyConfigured, resolveDeepSeekApiKey,
} from '@deepseek-ai/dsh-llm-deepseek'
import {
  plainOptions as plainOfficialOptions, resolveAdapterOptions as resolveOfficialOptions, type Config as OfficialRouteConfig,
} from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-web'
import { DeepSeekFetchApiProvider } from './fetch.ts'
import {
  DEEPSEEK_DEFAULT_COUNT, DEEPSEEK_SEARCH_REQUESTS_PER_SECOND, DEEPSEEK_WEB_API_BASE_URL, DeepSeekSearchApiProvider,
} from './search.ts'
import {
  isDeepSeekWebAuthReady, type DeepSeekWebAuth, type DeepSeekWebAuthSource, type DeepSeekWebGuidance,
} from './transport.ts'

export { DEEPSEEK_FETCH_API_PROVIDER_ID, DeepSeekFetchApiProvider } from './fetch.ts'
export type { DeepSeekFetchApiOptions } from './fetch.ts'
export {
  DEEPSEEK_DEFAULT_COUNT, DEEPSEEK_SEARCH_API_PROVIDER_ID, DEEPSEEK_SEARCH_REQUESTS_PER_SECOND, DEEPSEEK_WEB_API_BASE_URL,
  DeepSeekSearchApiProvider, mapSearchResponse,
} from './search.ts'
export type { DeepSeekSearchApiOptions } from './search.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-deepseek-api'

/** The web seam both providers register into. */
export const inject = ['web']

/**
 * Settings read by the next search or fetch without re-registering either provider. A non-empty `*BaseURL` or
 * `*ApiKeyEnv` gives that capability its own endpoint and key; with neither, the DeepSeek API-key route's key applies.
 * Stored fields of earlier settings (`baseURL`, `apiKeyEnv`, `apiKey`) are not schema fields: they load
 * without error and have no effect.
 */
export interface Config {
  /** Search API results per search, from 1 through 50; a smaller request bound wins. Defaults to 10. */
  count: Volatile<number>
  /**
   * Most Search requests this plugin instance sends in any one-second window; later searches wait,
   * and the wait counts against the caller's timeout. Defaults to 5.
   */
  searchRequestsPerSecond: Volatile<number>
  /** Send the triggering user question, bounded to 128 characters, as `ori_question`. Defaults to true. */
  sendOriginalQuestion: Volatile<boolean>
  /**
   * Own Search API base including its path prefix; `/search` is appended. With only {@link searchApiKeyEnv} set, the
   * official base applies.
   */
  searchBaseURL: Volatile<string | undefined>
  /** Own Search API credential reference. With only {@link searchBaseURL} set, `DEEPSEEK_API_KEY` applies. */
  searchApiKeyEnv: Volatile<string | undefined>
  /**
   * Own Fetch API base including its path prefix; `/fetch` is appended. With only {@link fetchApiKeyEnv} set, the
   * official base applies.
   */
  fetchBaseURL: Volatile<string | undefined>
  /** Own Fetch API credential reference. With only {@link fetchBaseURL} set, `DEEPSEEK_API_KEY` applies. */
  fetchApiKeyEnv: Volatile<string | undefined>
}

export const Config = z.object({
  count: z.number().step(1).min(1).max(50).default(DEEPSEEK_DEFAULT_COUNT).volatile(),
  searchRequestsPerSecond: z.number().step(1).min(1).default(DEEPSEEK_SEARCH_REQUESTS_PER_SECOND).volatile(),
  sendOriginalQuestion: z.boolean().default(true).volatile(),
  searchBaseURL: z.string().volatile(),
  searchApiKeyEnv: z.string().role('credential-ref').volatile(),
  fetchBaseURL: z.string().volatile(),
  fetchApiKeyEnv: z.string().role('credential-ref').volatile(),
})

/** A capability that resolves its endpoint and credential independently of the other. */
type Capability = 'search' | 'fetch'

/** Model route whose settings an operation can depend on. */
type RouteName = keyof typeof ROUTE_PACKAGES

/** Path prefix of the Search and Fetch APIs under a DeepSeek origin. */
const TOOLS_PATH = '/v1/tools'

/** Credential reference of the official DeepSeek API key. */
const DEEPSEEK_API_KEY = credentialRef('DEEPSEEK_API_KEY')

/** Provider id of the DeepSeek API-key route. */
const OFFICIAL_PROVIDER = 'deepseek-official'

/** Loader package that registers each model route. */
const ROUTE_PACKAGES = {
  [OFFICIAL_PROVIDER]: '@deepseek-ai/dsh-llm-deepseek-api-key',
} as const

/** Display names, configuration prefix, and operation path of each capability. */
const CAPABILITY = {
  search: { subject: 'Search', prefix: 'search', path: '/search' },
  fetch: { subject: 'Fetch', prefix: 'fetch', path: '/fetch' },
} as const satisfies Record<Capability, { subject: DeepSeekWebGuidance['subject']; prefix: string; path: '/search' | '/fetch' }>

/**
 * Read the text of the latest human prompt, the question that triggered the
 * current turn. Injected user-role context carries another source kind.
 * @param session - the initiating Session, when the search runs inside one.
 * @returns the prompt's joined text blocks, or undefined without a prompt.
 */
function latestUserQuestion(session: Session | undefined): string | undefined {
  const prompt = session?.deriveMessages().findLast(message => message.role === 'user' && message.source.kind === 'user')
  if (prompt === undefined) return undefined
  return prompt.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * Register the Search API and Fetch API providers over one live settings section. Each operation reads one settings
 * snapshot; each `ready()` call reads one settings snapshot. Both resolve the same ordered credentials.
 * @param ctx - plugin context owning both registrations.
 * @param config - live settings, read once per operation.
 */
export function apply(ctx: Context, config: Config): void {
  const own = (capability: Capability) => capability === 'search'
    ? { baseURL: config.searchBaseURL.get(), ref: config.searchApiKeyEnv.get() }
    : { baseURL: config.fetchBaseURL.get(), ref: config.fetchApiKeyEnv.get() }
  const target = (capability: Capability) => resolveTarget(ctx, capability, own(capability))
  const ready = (capability: Capability) => async (): Promise<boolean> =>
    isDeepSeekWebAuthReady(target(capability).auth)
  const searchApi = new DeepSeekSearchApiProvider(() => ({
    ...target('search'),
    count: config.count.get(),
    requestsPerSecond: config.searchRequestsPerSecond.get(),
    ...config.sendOriginalQuestion.get() ? {
      originalQuestion: () => latestUserQuestion(ctx.get('agents')?.currentInitiator()?.session),
    } : {},
  }))
  const fetchApi = new DeepSeekFetchApiProvider(() => target('fetch'))
  ctx.web.registerSearchProvider({
    id: searchApi.id,
    description: searchApi.description,
    available: () => searchApi.available(),
    ready: ready('search'),
    search: (request, signal) => searchApi.search(request, signal),
  })
  ctx.web.registerFetchProvider({
    id: fetchApi.id,
    description: fetchApi.description,
    available: () => fetchApi.available(),
    ready: ready('fetch'),
    fetch: (request, signal) => fetchApi.fetch(request, signal),
  })
}

/**
 * Resolve the ordered credentials and endpoint guidance of one capability without reading credential values. Route
 * endpoints use the origin of the route's resolved Messages base URL with `/v1/tools`.
 * @param ctx - context with the model, loader, and credential services.
 * @param capability - the capability being resolved.
 * @param own - the capability's own base URL and credential reference, where empty values count as unset.
 * @returns the authentication sources and the settings endpoint failures name.
 */
function resolveTarget(
  ctx: Context, capability: Capability,
  own: { baseURL: string | undefined; ref: string | undefined },
): { auth: DeepSeekWebAuth; guidance: DeepSeekWebGuidance } {
  const { subject, prefix } = CAPABILITY[capability]
  const guidance = (custom: boolean): DeepSeekWebGuidance =>
    ({ subject, plugin: name, custom, baseURLField: `${prefix}BaseURL`, apiKeyEnvField: `${prefix}ApiKeyEnv` })
  const ownBaseURL = nonEmpty(own.baseURL), ownRef = nonEmpty(own.ref)
  if (ownBaseURL !== undefined || ownRef !== undefined) {
    const ref = ownRef === undefined ? DEEPSEEK_API_KEY : credentialRef(ownRef)
    const json = JSON.stringify(ref)
    return { guidance: guidance(true), auth: {
      sources: [apiKeySource(ctx, ownBaseURL ?? DEEPSEEK_WEB_API_BASE_URL, ref)],
      missingCredentialMessage: `DeepSeek ${subject} API sends the API key under ${json} to its own endpoint, and no key is`
        + ` configured for ${json}. Guide the user to export ${json} in the launching environment, or to correct`
        + ` ${name}.${prefix}ApiKeyEnv.`,
    } }
  }
  const sources = [officialSource(ctx, capability)]
  const [ref = DEEPSEEK_API_KEY] = sources.flatMap(row => row.kind === 'api-key' && typeof row.key !== 'string' ? [row.key.ref] : [])
  return { guidance: guidance(false), auth: { sources, missingCredentialMessage: missingMessage(capability, ref) } }
}

/**
 * The API key of the active DeepSeek API-key route, sent to its origin, or `DEEPSEEK_API_KEY` sent to the official base
 * without that route.
 * @returns the source, or a misconfigured source when the route's resolver rejects its settings.
 */
function officialSource(ctx: Context, capability: Capability): DeepSeekWebAuthSource {
  const config = routeConfig(ctx, OFFICIAL_PROVIDER) as OfficialRouteConfig | undefined
  if (config === undefined) return apiKeySource(ctx, DEEPSEEK_WEB_API_BASE_URL, DEEPSEEK_API_KEY)
  let resolved: { baseURL: string; apiKeyEnv: CredentialRef }
  try { resolved = resolveOfficialOptions(plainOfficialOptions(config), launchEnvironmentOf(ctx)) }
  catch (error: unknown) { return misconfigured(capability, error) }
  return apiKeySource(ctx, toolsBase(resolved.baseURL), resolved.apiKeyEnv)
}

/** The key under `ref`, read through the shared DeepSeek credential helpers, sent to `baseURL`. */
function apiKeySource(ctx: Context, baseURL: string, ref: CredentialRef): DeepSeekWebAuthSource {
  return { kind: 'api-key', baseURL, key: {
    ref, configured: () => deepSeekApiKeyConfigured(ctx, ref), resolve: () => resolveDeepSeekApiKey(ctx, ref),
  } }
}

/**
 * The source of a credential whose model route settings do not resolve.
 * @param capability - the capability that stops.
 * @param error - the route resolver's failure.
 * @returns the source whose diagnostic names the provider and both recoveries.
 */
function misconfigured(capability: Capability, error: unknown): DeepSeekWebAuthSource {
  const { subject, prefix } = CAPABILITY[capability]
  const provider = 'DeepSeek API-key model provider'
  const credential = 'that provider\'s API key'
  return { kind: 'misconfigured', message: `DeepSeek ${subject} API sends ${credential} to the origin of the ${provider}, and`
    + ` that provider's settings do not resolve: ${errorMessage(error)}. ${subject} did not send the request. Guide the user`
    + ' to correct that provider\'s settings on the Models page or in the deployment configuration, or to set'
    + ` ${name}.${prefix}BaseURL and ${name}.${prefix}ApiKeyEnv so ${subject} uses its own endpoint.` }
}

/**
 * Model-facing diagnostic for an operation that has no credential to send.
 * @param capability - the capability that stops.
 * @param keyRef - the reference of the API key the operation tries, or `DEEPSEEK_API_KEY` when it tries none.
 * @returns the diagnostic naming the missing credential and its recoveries.
 */
function missingMessage(capability: Capability, keyRef: CredentialRef): string {
  const { subject } = CAPABILITY[capability]
  const ref = JSON.stringify(keyRef)
  const addKey = `add the DeepSeek API key on the Models page or export ${ref} in the launching environment`
  return `DeepSeek ${subject} API bills only the DeepSeek API key, and no key is configured for ${ref}. Guide the user to`
    + ` ${addKey}.`
}

/** The message of a thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Find the effective config of the active loader entry that registers `provider`, as the model provider directory
 * names it. A route registered by another package, nested settings, or an inactive entry counts as absent.
 */
function routeConfig(ctx: Context, provider: RouteName): unknown {
  const llm = ctx.get('llm'), loader = ctx.get('loader')
  if (llm === undefined || loader === undefined || !llm.listProviders().some(row => row.id === provider)) return undefined
  const directory = llm.listConfigurableProviders().find(row => row.provider === provider)
  if (directory === undefined || directory.settingsPath.length !== 0) return undefined
  const entry = [...loader.entries()].find(row => row.options.id === directory.settingsNs && row.options.name === ROUTE_PACKAGES[provider])
  if (entry?.fiber?.state !== FiberState.ACTIVE) return undefined
  return entry.fiber.effectiveConfig
}

/** The Search and Fetch API base under the origin of a Messages base URL. */
function toolsBase(messagesBaseURL: string): string {
  return `${new URL(messagesBaseURL).origin}${TOOLS_PATH}`
}

/** A string with content, or undefined for an absent or empty value. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

