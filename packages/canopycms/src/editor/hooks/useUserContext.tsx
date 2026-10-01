'use client'

import { useEffect, useState } from 'react'
import { createApiClient } from '../../api'
import { useOptionalApiClient } from '../context'
import { useEditorIdentity } from '../context/EditorIdentityContext'
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
 * Inside an `EditorAuthGate` (always, under `CanopyEditor`) it returns the identity the gate
 * already resolved and issues no request of its own. Outside one it fetches `whoami` itself.
 */
export function useUserContext(): UseUserContextReturn {
  const gateIdentity = useEditorIdentity()
  const [userContext, setUserContext] = useState<UserContext | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>()
  // Context-provided client (configured with the deployment's basePath) when rendered inside an
  // ApiClientProvider -- which it always is in the real Editor tree. `null` outside one (e.g.
  // Editor.stories.tsx renders <Editor> directly, without CanopyEditor's provider wrapper), in
  // which case we fall back to a default-configured client below.
  const contextApiClient = useOptionalApiClient()

  useEffect(() => {
    if (gateIdentity) return
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
  }, [contextApiClient, gateIdentity])

  if (gateIdentity) {
    return { userContext: gateIdentity.user, loading: false, error: undefined }
  }
  return { userContext, loading, error }
}
