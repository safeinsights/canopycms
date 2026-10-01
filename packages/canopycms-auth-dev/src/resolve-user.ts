import type { HeadersLike } from 'canopycms/auth'
import type { CanopyUserId } from 'canopycms'
import { DEV_SIGNED_OUT, getDevUserCookieFromHeaders } from './cookie-utils'
import { DEV_ADMIN_USER_ID } from './dev-defaults'

/** Test-app user keys (`X-Test-User: admin`, ...) mapped to dev user ids. */
const TEST_USER_KEYS: Record<string, CanopyUserId> = {
  admin: DEV_ADMIN_USER_ID, // admin1
  editor: 'dev_user1_2nK8mP4xL9', // user1
  viewer: 'dev_user2_7qR3tY6wN2', // user2
  reviewer: 'dev_reviewer_9aB4cD2eF7', // reviewer1
}

/**
 * Who a request is, for every dev auth entry point. Precedence: `X-Test-User`, `x-dev-user-id`,
 * the `canopy-dev-user` cookie, then `defaultUserId`.
 *
 * Null means signed out (the cookie holds `DEV_SIGNED_OUT`). Callers must not pass anything on in
 * its place: `CachingAuthPlugin` accepts whatever id a verifier returns, known user or not.
 */
export function resolveDevUserId(
  headers: HeadersLike,
  defaultUserId: CanopyUserId,
): CanopyUserId | null {
  let key = headers.get('X-Test-User') || headers.get('x-dev-user-id') || null
  if (!key) {
    const cookie = getDevUserCookieFromHeaders(headers)
    if (cookie === DEV_SIGNED_OUT) return null
    key = cookie
  }
  const id = key || defaultUserId
  return TEST_USER_KEYS[id] ?? id
}
