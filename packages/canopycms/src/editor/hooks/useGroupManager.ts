import { useCallback, useEffect, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { InternalGroup } from '../../groups-file'
import type { UserSearchResult, GroupMetadata } from '../../auth/types'
import { createApiClient } from '../../api'

// Lazy singleton - created on first access to pick up any fetch mocks in tests
let apiClient: ReturnType<typeof createApiClient> | null = null
function getApiClient() {
  if (!apiClient) {
    apiClient = createApiClient()
  }
  return apiClient
}

// For testing: reset the singleton to pick up new fetch mocks
export function resetApiClient() {
  apiClient = null
}

export interface UseGroupManagerOptions {
  /**
   * Whether the group manager is currently open.
   * Groups are loaded when this becomes true.
   */
  isOpen: boolean
}

export interface UseGroupManagerReturn {
  groupsData: InternalGroup[]
  groupsLoading: boolean
  handleSaveGroups: (groups: InternalGroup[]) => Promise<void>
  handleSearchUsers: (query: string, limit?: number) => Promise<UserSearchResult[]>
  handleGetUserMetadata: (userId: string) => Promise<UserSearchResult | null>
  handleSearchExternalGroups: (query: string) => Promise<GroupMetadata[]>
  loadGroups: () => Promise<void>
}

/**
 * Custom hook for managing internal groups (CRUD operations).
 *
 * Handles:
 * - Loading groups from API
 * - Saving groups to API
 * - Searching for users to add to groups
 * - Searching for external groups
 *
 * @example
 * ```tsx
 * const { groupsData, groupsLoading, handleSaveGroups, handleSearchUsers } = useGroupManager({
 *   isOpen: groupManagerOpen
 * })
 *
 * // Groups are automatically loaded when isOpen becomes true
 * // Save groups
 * await handleSaveGroups(updatedGroups)
 *
 * // Search users
 * const users = await handleSearchUsers('john', 10)
 * ```
 */
export function useGroupManager(options: UseGroupManagerOptions): UseGroupManagerReturn {
  const [groupsData, setGroupsData] = useState<InternalGroup[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)

  const loadGroups = async () => {
    setGroupsLoading(true)
    try {
      const result = await getApiClient().groups.getInternal()
      if (!result.ok) throw new Error('Failed to load groups')
      setGroupsData(result.data?.groups ?? [])
    } catch (err) {
      console.error('Failed to load groups:', err)
      notifications.show({ message: 'Failed to load groups', color: 'red' })
    } finally {
      setGroupsLoading(false)
    }
  }

  const handleSaveGroups = useCallback(async (groups: InternalGroup[]) => {
    try {
      const result = await getApiClient().groups.updateInternal({ groups })
      if (!result.ok) {
        throw new Error(result.error || 'Failed to save groups')
      }
      notifications.show({
        title: 'Groups Saved',
        message: 'Internal groups have been updated',
        color: 'green',
      })
      await loadGroups()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save groups'
      notifications.show({ message, color: 'red' })
      throw err
    }
  }, [])

  const handleSearchUsers = useCallback(async (query: string, limit?: number) => {
    try {
      const params: Record<string, string> = { q: query }
      if (limit) {
        params.limit = String(limit)
      }
      const result = await getApiClient().permissions.searchUsers(params)
      if (!result.ok) return []
      return result.data?.users ?? []
    } catch (err) {
      console.error('User search failed:', err)
      return []
    }
  }, [])

  const handleGetUserMetadata = useCallback(async (userId: string) => {
    try {
      const result = await getApiClient().permissions.getUserMetadata({ userId })
      if (!result.ok) return null
      return result.data?.user ?? null
    } catch (err) {
      console.error('Get user metadata failed:', err)
      return null
    }
  }, [])

  const handleSearchExternalGroups = useCallback(async (query: string) => {
    try {
      const result = await getApiClient().groups.searchExternal({ q: query })
      if (!result.ok) return []
      return result.data?.groups ?? []
    } catch (err) {
      console.error('External group search failed:', err)
      return []
    }
  }, [])

  // Load groups when group manager opens
  useEffect(() => {
    if (options.isOpen) {
      loadGroups()
    }
  }, [options.isOpen])

  return {
    groupsData,
    groupsLoading,
    handleSaveGroups,
    handleSearchUsers,
    handleGetUserMetadata,
    handleSearchExternalGroups,
    loadGroups,
  }
}
