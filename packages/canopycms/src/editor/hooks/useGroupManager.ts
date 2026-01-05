import { useEffect, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { InternalGroup } from '../../groups-file'
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
  handleSearchUsers: (query: string, limit?: number) => Promise<any[]>
  handleSearchExternalGroups: (query: string) => Promise<any[]>
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

  const handleSaveGroups = async (groups: InternalGroup[]) => {
    try {
      const result = await getApiClient().groups.updateInternal(groups)
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
  }

  const handleSearchUsers = async (query: string, limit?: number) => {
    try {
      const result = await getApiClient().permissions.searchUsers()
      if (!result.ok) return []
      return result.data?.users ?? []
    } catch (err) {
      console.error('User search failed:', err)
      return []
    }
  }

  const handleSearchExternalGroups = async (query: string) => {
    try {
      const result = await getApiClient().groups.searchExternal({ q: query })
      if (!result.ok) return []
      return result.data?.groups ?? []
    } catch (err) {
      console.error('External group search failed:', err)
      return []
    }
  }

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
    handleSearchExternalGroups,
    loadGroups,
  }
}
