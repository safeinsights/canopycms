import { extractHeaders } from 'canopycms/auth'
import type { TokenVerifier } from 'canopycms/auth'
import { getDevUserCookieFromHeaders, DEFAULT_USER_ID } from './cookie-utils'
import { DEV_ADMIN_USER_ID } from './dev-defaults'

/**
 * Test user key → dev user ID mapping.
 * Matches the mapping in DevAuthPlugin.mapTestUserKey().
 */
const TEST_USER_MAP: Record<string, string> = {
  admin: DEV_ADMIN_USER_ID,
  editor: 'dev_user1_2nK8mP4xL9',
  viewer: 'dev_user2_7qR3tY6wN2',
  reviewer: 'dev_reviewer_9aB4cD2eF7',
}

/**
 * Creates a token verifier for dev auth.
 * Extracts userId from X-Test-User header, x-dev-user-id header,
 * or canopy-dev-user cookie — same logic as DevAuthPlugin.authenticate().
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

    // Same extraction logic as DevAuthPlugin.authenticate()
    let userId = headers.get('X-Test-User')
    if (!userId) {
      userId = headers.get('x-dev-user-id') ?? getDevUserCookieFromHeaders(headers)
    }
    if (!userId) {
      userId = defaultUserId
    }

    // Map test user keys to dev user IDs
    const mapped = TEST_USER_MAP[userId] ?? userId

    return { userId: mapped }
  }
}
