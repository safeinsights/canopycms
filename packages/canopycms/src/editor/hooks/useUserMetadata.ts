import useSWR, { type ScopedMutator } from 'swr'
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

/**
 * Writes profiles a response already carried into each user's cache entry, so a badge shows the
 * name before, or without, a lookup. A cached record keeps its email, which a profile never has.
 */
export async function seedUserProfiles(
  mutate: ScopedMutator,
  users: readonly UserProfile[],
): Promise<void> {
  await Promise.all(
    users.map((user) =>
      mutate<UserSearchResult | null>(
        userMetadataKey(user.id),
        (current) => ({ email: '', ...current, ...user }),
        { revalidate: false },
      ),
    ),
  )
}

/** One user's metadata under a per-user SWR key, so every badge for that user shares a fetch. */
export function useUserMetadata(
  userId: CanopyUserId,
  getUserMetadata: (userId: string) => Promise<UserSearchResult | null>,
  cachedUser?: UserSearchResult,
): UseUserMetadataResult {
  const skip = cachedUser !== undefined || userId === 'anonymous' || isSystemUserId(userId)
  const { data, error, isLoading } = useSWR<UserSearchResult | null, unknown>(
    skip ? null : userMetadataKey(userId),
    () => getUserMetadata(userId),
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
    error:
      error === undefined
        ? null
        : error instanceof Error
          ? error
          : new Error('Failed to fetch user'),
  }
}
