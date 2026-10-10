import { LRUCache } from 'lru-cache'
import type { AuthPlugin } from './plugin'
import type { UserSearchResult } from './types'
import type { CanopyUserId } from '../types'
import { CachingAuthPlugin } from './caching-auth-plugin'
import { MAX_USER_METADATA_BATCH } from '../api/users-constants'

/**
 * How long a looked-up user, or the fact that an id is unknown, is served without asking again.
 * @internal Exported for tests.
 */
export const USER_METADATA_TTL_MS = 5 * 60 * 1000
const MAX_CACHED_USERS = 5000
/** Concurrent `getUserMetadata` calls for a plugin without `getUsersMetadata`. */
const SINGLE_LOOKUP_CONCURRENCY = 8

/** Boxed so an unknown id (`null`) can be cached; LRUCache values must be non-nullish. */
interface CachedUser {
  user: UserSearchResult | null
}

/**
 * Per-process, in-memory, never persisted: each warm Lambda instance keeps its own copy, so a
 * changed name or avatar shows everywhere within one TTL. Keyed by plugin so two plugins never
 * share answers.
 */
const caches = new WeakMap<AuthPlugin, LRUCache<CanopyUserId, CachedUser>>()

function cacheFor(plugin: AuthPlugin): LRUCache<CanopyUserId, CachedUser> {
  let cache = caches.get(plugin)
  if (!cache) {
    cache = new LRUCache({ max: MAX_CACHED_USERS, ttl: USER_METADATA_TTL_MS })
    caches.set(plugin, cache)
  }
  return cache
}

/**
 * Resolves each id to its user, or `null` when the provider does not know it. Unknown ids are
 * cached like found ones, so a stale id in permissions.json costs one provider call per TTL.
 * A provider failure rejects and caches nothing.
 */
export async function lookupUsersMetadata(
  plugin: AuthPlugin,
  userIds: readonly CanopyUserId[],
): Promise<Map<CanopyUserId, UserSearchResult | null>> {
  const unique = [...new Set(userIds)]
  // Already answered from an in-memory copy of the worker-written file cache; a TTL on top
  // would only delay the worker's refreshes.
  if (plugin instanceof CachingAuthPlugin) return fetchFromPlugin(plugin, unique)

  const cache = cacheFor(plugin)
  const result = new Map<CanopyUserId, UserSearchResult | null>()
  const missing: CanopyUserId[] = []
  for (const id of unique) {
    const hit = cache.get(id)
    if (hit) result.set(id, hit.user)
    else missing.push(id)
  }
  if (missing.length === 0) return result

  const fetched = await fetchFromPlugin(plugin, missing)
  for (const [id, user] of fetched) {
    cache.set(id, { user })
    result.set(id, user)
  }
  return result
}

async function fetchFromPlugin(
  plugin: AuthPlugin,
  ids: CanopyUserId[],
): Promise<Map<CanopyUserId, UserSearchResult | null>> {
  const result = new Map<CanopyUserId, UserSearchResult | null>(ids.map((id) => [id, null]))
  const getUsersMetadata = plugin.getUsersMetadata?.bind(plugin)
  if (getUsersMetadata) {
    for (let i = 0; i < ids.length; i += MAX_USER_METADATA_BATCH) {
      const users = await getUsersMetadata(ids.slice(i, i + MAX_USER_METADATA_BATCH))
      // A provider answering for an id nobody asked about must not plant it in the cache.
      for (const user of users) if (result.has(user.id)) result.set(user.id, user)
    }
    return result
  }

  let next = 0
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]
      result.set(id, await plugin.getUserMetadata(id))
    }
  }
  await Promise.all(Array.from({ length: Math.min(SINGLE_LOOKUP_CONCURRENCY, ids.length) }, worker))
  return result
}
