import { describe, it, expect } from 'vitest'
import { CachingAuthPlugin } from 'canopycms/auth/cache'
import type { AuthCacheProvider } from 'canopycms/auth'
import { DevAuthPlugin, DEV_ADMIN_USER_ID } from './dev-plugin'
import { createDevTokenVerifier } from './jwt-verifier'
import {
  DEFAULT_USER_ID,
  DEV_SIGNED_OUT,
  DEV_USER_COOKIE_NAME,
  getDevUserCookieFromHeaders,
} from './cookie-utils'
import { resolveDevUserId } from './resolve-user'

const withCookie = (value: string, extra: Record<string, string> = {}) =>
  new Headers({ Cookie: `${DEV_USER_COOKIE_NAME}=${value}`, ...extra })
const signedOut = (extra: Record<string, string> = {}) => withCookie(DEV_SIGNED_OUT, extra)

const emptyCache: AuthCacheProvider = {
  getUser: async () => null,
  getGroup: async () => null,
  getAllUsers: async () => [],
  getAllGroups: async () => [],
  getUserExternalGroups: async () => [],
}

describe('dev auth signed-out state', () => {
  it('authenticate rejects a signed-out request', async () => {
    const result = await new DevAuthPlugin({}).authenticate(signedOut())
    expect(result).toEqual({ success: false, error: 'Signed out' })
  })

  it('verifyTokenOnly and the deprecated token verifier both return null when signed out', async () => {
    expect(await new DevAuthPlugin({}).verifyTokenOnly(signedOut())).toBeNull()
    expect(await createDevTokenVerifier()(signedOut())).toBeNull()
  })

  it('does not sign in through CachingAuthPlugin, which accepts any id a verifier returns', async () => {
    // This is the wiring createNextCanopyContext uses in dev mode. CachingAuthPlugin falls back
    // to `name: userId` for unknown ids, so a sentinel passed through as an id would be accepted.
    const plugin = new DevAuthPlugin({})
    const caching = new CachingAuthPlugin((ctx) => plugin.verifyTokenOnly(ctx), emptyCache)

    expect((await caching.authenticate(signedOut())).success).toBe(false)
    // Control: the same wiring does accept a cookie-selected user.
    const accepted = await caching.authenticate(withCookie('dev_user2_7qR3tY6wN2'))
    expect(accepted.success && accepted.user?.userId).toBe('dev_user2_7qR3tY6wN2')
  })

  it('lets a test header win over a signed-out cookie', async () => {
    const result = await new DevAuthPlugin({}).authenticate(signedOut({ 'X-Test-User': 'admin' }))
    expect(result.success && result.user?.userId).toBe(DEV_ADMIN_USER_ID)
    expect(resolveDevUserId(signedOut({ 'x-dev-user-id': 'viewer' }), DEFAULT_USER_ID)).toBe(
      'dev_user2_7qR3tY6wN2',
    )
  })

  it('still signs a first visit in as the default user: no cookie is not signed out', async () => {
    const result = await new DevAuthPlugin({}).authenticate(new Headers())
    expect(result.success && result.user?.userId).toBe(DEFAULT_USER_ID)
    expect(await createDevTokenVerifier()(new Headers())).toEqual({ userId: DEFAULT_USER_ID })
  })

  it('resolves the same user on every entry point', async () => {
    const plugin = new DevAuthPlugin({})
    const verifier = createDevTokenVerifier()
    for (const headers of [
      new Headers({ 'X-Test-User': 'reviewer' }),
      new Headers({ 'x-dev-user-id': 'editor' }),
      withCookie('dev_user2_7qR3tY6wN2'),
    ]) {
      const expected = resolveDevUserId(headers, DEFAULT_USER_ID)
      const authenticated = await plugin.authenticate(headers)
      expect(authenticated.success && authenticated.user?.userId).toBe(expected)
      expect((await plugin.verifyTokenOnly(headers))?.userId).toBe(expected)
      expect((await verifier(headers))?.userId).toBe(expected)
    }
  })
})

describe('getDevUserCookieFromHeaders', () => {
  it('reads the cookie only at a cookie boundary', () => {
    const read = (cookie: string) => getDevUserCookieFromHeaders(new Headers({ Cookie: cookie }))
    expect(read(`other-${DEV_USER_COOKIE_NAME}=x; theme=dark`)).toBeNull()
    expect(read(`theme=dark; ${DEV_USER_COOKIE_NAME}=abc`)).toBe('abc')
    expect(read(`theme=dark;${DEV_USER_COOKIE_NAME}=abc`)).toBe('abc')
    expect(read(`${DEV_USER_COOKIE_NAME}=abc`)).toBe('abc')
  })
})
