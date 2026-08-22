'use client'

import { useEffect, useState } from 'react'
import { createApiClient } from '../../api'
import { useOptionalApiClient } from '../context'
import type { UserContext } from '../BranchManager'

export interface UseUserContextReturn {
  userContext: UserContext | undefined
  loading: boolean
  error: string | undefined
}

/**
 * Hook to fetch current user context from the API.
 * This provides the userId and groups needed for permission checks.
 *
 * @example
 * ```tsx
 * const { userContext, loading, error } = useUserContext()
 *
 * if (loading) return <div>Loading...</div>
 * if (error) return <div>Error: {error}</div>
 *
 * return <BranchManager user={userContext} />
 * ```
 */
export function useUserContext(): UseUserContextReturn {
  const [userContext, setUserContext] = useState<UserContext | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  // Context-provided client (configured with the deployment's basePath) when rendered inside an
  // ApiClientProvider -- which it always is in the real Editor tree. `null` outside one (e.g.
  // Editor.stories.tsx renders <Editor> directly, without CanopyEditor's provider wrapper), in
  // which case we fall back to a default-configured client below.
  const contextApiClient = useOptionalApiClient()

  useEffect(() => {
    const fetchUserContext = async () => {
      setLoading(true)
      try {
        const apiClient = contextApiClient ?? createApiClient()
        const result = await apiClient.user.whoami()

        if (result.ok && result.data) {
          setUserContext({
            userId: result.data.userId,
            groups: result.data.groups,
          })
        } else {
          setError(result.error || 'Failed to load user context')
        }
      } catch (err) {
        console.error('Failed to fetch user context:', err)
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    fetchUserContext()
  }, [contextApiClient])

  return { userContext, loading, error }
}
