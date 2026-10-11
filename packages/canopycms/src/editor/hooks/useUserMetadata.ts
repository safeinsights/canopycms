import useSWR from 'swr'
import type { UserSearchResult } from '../../auth/types'
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

/** One user's metadata under a per-user SWR key, so every badge for that user shares a fetch. */
export function useUserMetadata(
  userId: CanopyUserId,
  getUserMetadata: (userId: string) => Promise<UserSearchResult | null>,
  cachedUser?: UserSearchResult,
): UseUserMetadataResult {
  const skip = cachedUser !== undefined || userId === 'anonymous' || isSystemUserId(userId)
  const { data, error, isLoading } = useSWR<UserSearchResult | null, unknown>(
    skip ? null : `canopy:user:${userId}`,
    () => getUserMetadata(userId),
  )

  if (cachedUser) return { userMetadata: cachedUser, isLoading: false, error: null }
  if (userId === 'anonymous') return { userMetadata: ANONYMOUS_USER, isLoading: false, error: null }
  if (isSystemUserId(userId)) {
    return { userMetadata: systemUser(userId), isLoading: false, error: null }
  }
  return {
    userMetadata: data ?? null,
    isLoading,
    error:
      error === undefined
        ? null
        : error instanceof Error
          ? error
          : new Error('Failed to fetch user'),
  }
}
