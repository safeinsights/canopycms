import { useEffect, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { PathPermission } from '../../config'
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

export interface UsePermissionManagerOptions {
  /**
   * Whether the permission manager is currently open.
   * Permissions are loaded when this becomes true.
   */
  isOpen: boolean
}

export interface UsePermissionManagerReturn {
  permissionsData: PathPermission[]
  permissionsLoading: boolean
  handleSavePermissions: (permissions: PathPermission[]) => Promise<void>
  handleListGroups: () => Promise<any[]>
  loadPermissions: () => Promise<void>
}

/**
 * Custom hook for managing path permissions (CRUD operations).
 *
 * Handles:
 * - Loading permissions from API
 * - Saving permissions to API
 * - Listing groups for permission assignment
 *
 * @example
 * ```tsx
 * const { permissionsData, permissionsLoading, handleSavePermissions, handleListGroups } = usePermissionManager({
 *   isOpen: permissionManagerOpen
 * })
 *
 * // Permissions are automatically loaded when isOpen becomes true
 * // Save permissions
 * await handleSavePermissions(updatedPermissions)
 *
 * // List groups
 * const groups = await handleListGroups()
 * ```
 */
export function usePermissionManager(
  options: UsePermissionManagerOptions
): UsePermissionManagerReturn {
  const [permissionsData, setPermissionsData] = useState<PathPermission[]>([])
  const [permissionsLoading, setPermissionsLoading] = useState(false)

  const loadPermissions = async () => {
    setPermissionsLoading(true)
    try {
      const result = await getApiClient().permissions.get()
      if (!result.ok) throw new Error('Failed to load permissions')
      setPermissionsData(result.data?.permissions ?? [])
    } catch (err) {
      console.error('Failed to load permissions:', err)
      notifications.show({ message: 'Failed to load permissions', color: 'red' })
    } finally {
      setPermissionsLoading(false)
    }
  }

  const handleSavePermissions = async (permissions: PathPermission[]) => {
    try {
      const result = await getApiClient().permissions.update(permissions)
      if (!result.ok) {
        throw new Error(result.error || 'Failed to save permissions')
      }
      notifications.show({
        title: 'Permissions Saved',
        message: 'Permissions have been updated',
        color: 'green',
      })
      await loadPermissions()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save permissions'
      notifications.show({ message, color: 'red' })
      throw err
    }
  }

  const handleListGroups = async () => {
    try {
      const result = await getApiClient().permissions.listGroups()
      if (!result.ok) return []
      return result.data?.groups ?? []
    } catch (err) {
      console.error('Group list failed:', err)
      return []
    }
  }

  // Load permissions when permission manager opens
  useEffect(() => {
    if (options.isOpen) {
      loadPermissions()
    }
  }, [options.isOpen])

  return {
    permissionsData,
    permissionsLoading,
    handleSavePermissions,
    handleListGroups,
    loadPermissions,
  }
}
