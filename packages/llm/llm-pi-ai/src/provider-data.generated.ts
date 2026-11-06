/** Generated from the installed pi-ai catalog. Run pnpm gen-provider-data; do not edit. */

import type { BuiltinProvider } from '@deepseek-ai/pi-ai/providers/all'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'

type ProviderData = Pick<LlmConfigurableProvider, 'defaultBaseURL' | 'baseURLEnv'> & { env: readonly string[] }

/** Catalog endpoints and environment names; no credentials are evaluated at runtime. */
export const PROVIDER_DATA: Record<BuiltinProvider, ProviderData> & Partial<Record<string, ProviderData>> = {
  'anthropic': { env: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_WORKSPACE_ID'], defaultBaseURL: 'https://api.anthropic.com' },
  'azure': { env: ['AZURE_OPENAI_API_KEY'], baseURLEnv: ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME'] },
  'deepseek': { env: ['DEEPSEEK_API_KEY'], defaultBaseURL: 'https://api.deepseek.com' },
  'openai': { env: ['OPENAI_API_KEY'], defaultBaseURL: 'https://api.openai.com/v1' },
  'openai-codex': { env: [], defaultBaseURL: 'https://chatgpt.com/backend-api' },
  'moonshotai': { env: ['MOONSHOT_API_KEY'], defaultBaseURL: 'https://api.moonshot.ai/v1' },
  'opencode-go': { env: ['OPENCODE_API_KEY'] },
}
