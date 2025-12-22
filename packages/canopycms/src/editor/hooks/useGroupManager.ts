import { useEffect, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { InternalGroup } from '../../groups-file'

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
      const res = await fetch('/api/canopycms/groups/internal')
      if (!res.ok) throw new Error('Failed to load groups')
      const data = await res.json()
      setGroupsData(data.data?.groups ?? [])
    } catch (err) {
      console.error('Failed to load groups:', err)
      notifications.show({ message: 'Failed to load groups', color: 'red' })
    } finally {
      setGroupsLoading(false)
    }
  }

  const handleSaveGroups = async (groups: InternalGroup[]) => {
    try {
      const res = await fetch('/api/canopycms/groups/internal', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups }),
      })
      if (!res.ok) {
        const payload = await res.json()
        throw new Error(payload.error || 'Failed to save groups')
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
      const params = new URLSearchParams({ query, limit: String(limit ?? 10) })
      const res = await fetch(`/api/canopycms/users/search?${params}`)
      if (!res.ok) return []
      const data = await res.json()
      return data.data?.users ?? []
    } catch (err) {
      console.error('User search failed:', err)
      return []
    }
  }

  const handleSearchExternalGroups = async (query: string) => {
    try {
      const params = new URLSearchParams({ query })
      const res = await fetch(`/api/canopycms/groups/search?${params}`)
      if (!res.ok) return []
      const data = await res.json()
      return data.data?.groups ?? []
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
