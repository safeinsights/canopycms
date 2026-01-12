import { useEffect, useState } from 'react'
import type { UserSearchResult } from '../../auth/types'
import type { CanopyUserId } from '../../types'

export interface UseUserMetadataResult {
  userMetadata: UserSearchResult | null
  isLoading: boolean
  error: Error | null
}

/**
 * Fetches user metadata using the provided getter function.
 *
 * @param userId - User ID to fetch metadata for
 * @param getUserMetadata - Function to fetch user metadata
 * @param cachedUser - Optional: if provided, returns immediately without fetching
 */
export function useUserMetadata(
  userId: CanopyUserId,
  getUserMetadata: (userId: string) => Promise<UserSearchResult | null>,
  cachedUser?: UserSearchResult
): UseUserMetadataResult {
  const [userMetadata, setUserMetadata] = useState<UserSearchResult | null>(cachedUser || null)
  const [isLoading, setIsLoading] = useState(!cachedUser)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    // Skip fetch if cachedUser provided
    if (cachedUser) return

    // Special case: anonymous user
    if (userId === 'anonymous') {
      setUserMetadata({
        id: 'anonymous',
        name: 'Anonymous',
        email: 'public',
      })
      setIsLoading(false)
      return
    }

    let cancelled = false

    const fetchUser = async () => {
      setIsLoading(true)
      try {
        const result = await getUserMetadata(userId)
        if (!cancelled) {
          setUserMetadata(result)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error('Failed to fetch user'))
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false)
        }
      }
    }

    fetchUser()

    return () => {
      cancelled = true
    }
  }, [userId, getUserMetadata, cachedUser])

  return { userMetadata, isLoading, error }
}
