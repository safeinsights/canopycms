import { extractHeaders } from 'canopycms/auth'
import type { TokenVerifier } from 'canopycms/auth'
import { DEFAULT_USER_ID } from './cookie-utils'
import { resolveDevUserId } from './resolve-user'

/**
 * Creates a token verifier for dev auth, resolving users as `DevAuthPlugin` does.
 *
 * Used with CachingAuthPlugin in dev mode to simulate the prod
 * code path (token verification + cached metadata lookup) using dev users.
 *
 * @deprecated Use `DevAuthPlugin.verifyTokenOnly()` instead. The plugin's method is
 * automatically wired into CachingAuthPlugin by `createNextCanopyContext()` in prod/dev.
 */
export function createDevTokenVerifier(options?: { defaultUserId?: string }): TokenVerifier {
  const defaultUserId = options?.defaultUserId ?? DEFAULT_USER_ID

  return async (context: unknown) => {
    const headers = extractHeaders(context)
    if (!headers) return null

    const userId = resolveDevUserId(headers, defaultUserId)
    return userId ? { userId } : null
  }
}
