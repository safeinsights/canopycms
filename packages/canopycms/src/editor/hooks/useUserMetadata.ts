import { useCallback } from 'react'
import useSWR, { useSWRConfig, type Cache, type ScopedMutator } from 'swr'
import type { UserProfile, UserSearchResult } from '../../auth/types'
import type { CanopyUserId } from '../../types'
import { isSystemUserId } from '../../system-users'
import { SYSTEM_USER_LABEL } from '../user-display'

export interface UseUserMetadataResult {
  userMetadata: UserSearchResult | null
  isLoading: boolean
  error: Error | null
}

const ANONYMOUS_USER: UserSearchResult = { id: 'anonymous', name: 'Anonymous', email: 'public' }

/** A bot has no directory entry to look up; it is answered here, by name. */
const systemUser = (userId: string): UserSearchResult => ({
  id: userId,
  name: SYSTEM_USER_LABEL,
  email: '',
})

const userMetadataKey = (userId: string): string => `canopy:user:${userId}`

const isUserRecord = (value: unknown): value is UserSearchResult =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  typeof value.id === 'string' &&
  'name' in value &&
  typeof value.name === 'string'

const cachedRecord = (cache: Cache, key: string): UserSearchResult | null => {
  const data: unknown = cache.get(key)?.data
  return isUserRecord(data) ? data : null
}

/**
 * Caches profiles a response carried, keeping a cached record's email. A profile matching the
 * cached record is not written: any write makes SWR discard a lookup in flight, email included. A
 * user with no record, or whose written record still has no email, is refetched once the writes
 * settle, since the seed may have discarded a lookup; that refetch is detached, so the caller
 * never waits on the directory.
 */
export async function seedUserProfiles(
  swr: { cache: Cache; mutate: ScopedMutator },
  users: readonly UserProfile[],
): Promise<void> {
  const { cache, mutate } = swr
  const emailless = new Set<string>()
  await Promise.all(
    users.map(async (user) => {
      const key = userMetadataKey(user.id)
      const record = cachedRecord(cache, key)
      if (record && record.name === user.name && record.avatarUrl === user.avatarUrl) return
      const merged = { email: '', ...record, ...user }
      if (!record || !merged.email) emailless.add(key)
      await mutate<UserSearchResult>(key, merged, { revalidate: false })
    }),
  )
  for (const key of emailless) void mutate(key)
}

/** Answers from the cache with no request and no email, for a reader who may not look users up. */
export function useSeededUserResolver(): (userId: string) => Promise<UserSearchResult | null> {
  const { cache } = useSWRConfig()
  return useCallback(
    (userId: string) => {
      const record = cachedRecord(cache, userMetadataKey(userId))
      return Promise.resolve(record ? { ...record, email: '' } : null)
    },
    [cache],
  )
}

/** One user's metadata under a per-user SWR key, so every badge for that user shares a fetch. */
export function useUserMetadata(
  userId: CanopyUserId,
  getUserMetadata: (userId: string) => Promise<UserSearchResult | null>,
  cachedUser?: UserSearchResult,
): UseUserMetadataResult {
  const skip = cachedUser !== undefined || userId === 'anonymous' || isSystemUserId(userId)
  const { cache } = useSWRConfig()
  const key = userMetadataKey(userId)
  const { data, error, isLoading } = useSWR<UserSearchResult | null, unknown>(
    skip ? null : key,
    // An answer of null never replaces a record a seed wrote while the lookup was in flight.
    async () => (await getUserMetadata(userId)) ?? cachedRecord(cache, key),
  )

  if (cachedUser) return { userMetadata: cachedUser, isLoading: false, error: null }
  if (userId === 'anonymous') return { userMetadata: ANONYMOUS_USER, isLoading: false, error: null }
  if (isSystemUserId(userId)) {
    return { userMetadata: systemUser(userId), isLoading: false, error: null }
  }
  return {
    userMetadata: data ?? null,
    // A seed can land while the lookup is in flight; SWR still reports that lookup as loading.
    isLoading: isLoading && data === undefined,
    // A record to show outranks a failed lookup, so a seeded name survives it.
    error:
      error === undefined || data
        ? null
        : error instanceof Error
          ? error
          : new Error('Failed to fetch user'),
  }
}
