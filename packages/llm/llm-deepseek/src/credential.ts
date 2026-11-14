/** Credential values shared by DeepSeek model and web providers; callers own protocol headers and missing-key errors. */
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm'

/**
 * Read and validate one API key. An installed credentials service is authoritative, including absence;
 * only deployments without that service read the launch environment. Store and format failures propagate.
 * @param ctx - context providing the credential and launch-environment services.
 * @param ref - credential reference to resolve.
 * @returns the validated key, or undefined when no key is configured.
 */
export async function resolveDeepSeekApiKey(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    return hit === undefined ? undefined : assertUsableApiKey(hit.value, 'llm-deepseek', ref)
  }
  const ambient = launchEnvironmentOf(ctx).get(ref)
  return ambient === undefined || ambient.value.length === 0 ? undefined : assertUsableApiKey(ambient.value, 'llm-deepseek', ref)
}

/**
 * Check key presence without resolving a credential-store value or validating its format. Store failures propagate.
 * @param ctx - context providing the credential and launch-environment services.
 * @param ref - credential reference to inspect.
 * @returns whether the authoritative credential source reports a configured key.
 */
export async function deepSeekApiKeyConfigured(ctx: Context, ref: CredentialRef): Promise<boolean> {
  const credentials = ctx.get('credentials')
  return credentials === undefined
    ? (launchEnvironmentOf(ctx).get(ref)?.value.length ?? 0) > 0
    : (await credentials.describe(ref)).configured
}

