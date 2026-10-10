import { describe, it, expect, vi, afterEach } from 'vitest'
import { lookupUsersMetadata, USER_METADATA_TTL_MS } from './user-metadata-lookup'
import { CachingAuthPlugin } from './caching-auth-plugin'
import type { AuthPlugin } from './plugin'
import type { AuthCacheProvider } from './caching-auth-plugin'
import type { UserSearchResult } from './types'
import { MAX_USER_METADATA_BATCH } from '../api/users-constants'

const userFor = (id: string): UserSearchResult => ({ id, name: id, email: `${id}@x.test` })
const ids = (n: number, prefix = 'u') => Array.from({ length: n }, (_, i) => `${prefix}-${i}`)

/** Knows every id except those starting `ghost-`. */
function pluginWith(batch: boolean): AuthPlugin {
  return {
    authenticate: vi.fn(),
    searchUsers: vi.fn(),
    getUserMetadata: vi.fn(async (id: string) => (id.startsWith('ghost-') ? null : userFor(id))),
    getGroupMetadata: vi.fn(),
    listGroups: vi.fn(),
    ...(batch && {
      getUsersMetadata: vi.fn(async (wanted: string[]) =>
        wanted.filter((id) => !id.startsWith('ghost-')).map(userFor),
      ),
    }),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('lookupUsersMetadata', () => {
  it('maps every requested id, null for the unknown ones', async () => {
    const result = await lookupUsersMetadata(pluginWith(true), ['a', 'ghost-1'])
    expect(result).toEqual(
      new Map<string, UserSearchResult | null>([
        ['a', userFor('a')],
        ['ghost-1', null],
      ]),
    )
  })

  it('makes ceil(N / MAX_USER_METADATA_BATCH) plugin batch calls for N uncached ids', async () => {
    const plugin = pluginWith(true)
    await lookupUsersMetadata(plugin, ids(MAX_USER_METADATA_BATCH * 2 + 1))
    expect(vi.mocked(plugin.getUsersMetadata!).mock.calls.map(([chunk]) => chunk.length)).toEqual([
      MAX_USER_METADATA_BATCH,
      MAX_USER_METADATA_BATCH,
      1,
    ])
  })

  it('caches hits and misses, asking the plugin only for ids it has not answered', async () => {
    const plugin = pluginWith(true)
    await lookupUsersMetadata(plugin, ['a', 'ghost-1'])
    const second = await lookupUsersMetadata(plugin, ['a', 'ghost-1', 'b'])

    expect(second.get('ghost-1')).toBeNull()
    expect(vi.mocked(plugin.getUsersMetadata!).mock.calls).toEqual([[['a', 'ghost-1']], [['b']]])
  })

  it('asks again once the TTL has passed', async () => {
    // lru-cache holds the module-load `performance` object, so fake timers cannot reach its
    // clock, and it reuses a reading for a millisecond, so each advance waits that out.
    let now = 1_000_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const advance = async (ms: number) => {
      now += ms
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const plugin = pluginWith(true)
    await lookupUsersMetadata(plugin, ['a'])
    await advance(USER_METADATA_TTL_MS - 1000)
    await lookupUsersMetadata(plugin, ['a'])
    expect(plugin.getUsersMetadata).toHaveBeenCalledTimes(1)

    await advance(2000)
    await lookupUsersMetadata(plugin, ['a'])
    expect(plugin.getUsersMetadata).toHaveBeenCalledTimes(2)
  })

  it('bounds the cache, evicting the least recently used users', async () => {
    const plugin = pluginWith(true)
    await lookupUsersMetadata(plugin, ['first'])
    for (let i = 0; i < 50; i++) await lookupUsersMetadata(plugin, ids(100, `fill${i}`))
    await lookupUsersMetadata(plugin, ['first'])
    expect(vi.mocked(plugin.getUsersMetadata!).mock.calls.at(-1)).toEqual([['first']])
  })

  it('keeps separate caches per plugin', async () => {
    const one = pluginWith(true)
    const two = pluginWith(true)
    await lookupUsersMetadata(one, ['a'])
    await lookupUsersMetadata(two, ['a'])
    expect(two.getUsersMetadata).toHaveBeenCalledTimes(1)
  })

  it('caches nothing when the provider fails', async () => {
    const plugin = pluginWith(true)
    vi.mocked(plugin.getUsersMetadata!).mockRejectedValueOnce(new Error('rate limited'))
    await expect(lookupUsersMetadata(plugin, ['a'])).rejects.toThrow('rate limited')
    expect((await lookupUsersMetadata(plugin, ['a'])).get('a')).toEqual(userFor('a'))
  })

  it('ignores users the provider returns for ids nobody asked about', async () => {
    const plugin = pluginWith(true)
    vi.mocked(plugin.getUsersMetadata!).mockResolvedValueOnce([userFor('a'), userFor('intruder')])
    const result = await lookupUsersMetadata(plugin, ['a'])
    expect([...result.keys()]).toEqual(['a'])

    await lookupUsersMetadata(plugin, ['intruder'])
    expect(vi.mocked(plugin.getUsersMetadata!).mock.calls.at(-1)).toEqual([['intruder']])
  })

  it('falls back to single lookups, at most 8 at a time', async () => {
    const plugin = pluginWith(false)
    let inFlight = 0
    let peak = 0
    vi.mocked(plugin.getUserMetadata).mockImplementation(async (id) => {
      peak = Math.max(peak, ++inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      return userFor(id)
    })

    const result = await lookupUsersMetadata(plugin, ids(30))

    expect(result.size).toBe(30)
    expect(plugin.getUserMetadata).toHaveBeenCalledTimes(30)
    expect(peak).toBe(8)
  })

  it('reads a CachingAuthPlugin through on every call, so worker refreshes show at once', async () => {
    let users = [userFor('a')]
    const fileCache: AuthCacheProvider = {
      getUser: vi.fn(),
      getGroup: vi.fn(),
      getAllUsers: vi.fn(async () => users),
      getAllGroups: vi.fn(),
      getUserExternalGroups: vi.fn(),
    }
    const plugin = new CachingAuthPlugin(vi.fn(), fileCache)

    expect((await lookupUsersMetadata(plugin, ['a', 'b'])).get('b')).toBeNull()
    users = [userFor('a'), userFor('b')]
    expect((await lookupUsersMetadata(plugin, ['a', 'b'])).get('b')).toEqual(userFor('b'))
    expect(fileCache.getAllUsers).toHaveBeenCalledTimes(2)
    expect(fileCache.getUser).not.toHaveBeenCalled()
  })
})
