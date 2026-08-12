import { useEffect, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import type { PathPermission } from '../../config'
import type { PermissionGroupOption } from '../../auth/types'
import { useApiClient } from '../context'

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
  handleListGroups: () => Promise<PermissionGroupOption[]>
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
  options: UsePermissionManagerOptions,
): UsePermissionManagerReturn {
  const apiClient = useApiClient()
  const [permissionsData, setPermissionsData] = useState<PathPermission[]>([])
  const [permissionsLoading, setPermissionsLoading] = useState(false)
  // Last-loaded version, sent back as expectedContentVersion on save so the
  // server can detect a conflicting edit from another user (see
  // api/permissions.ts's updatePermissionsHandler). Deliberately NOT
  // auto-updated on a 409 — the user must reopen the manager (which reloads)
  // to pick up the latest version, rather than silently retrying and risking
  // an overwrite.
  const versionRef = useRef(0)

  const loadPermissions = async () => {
    setPermissionsLoading(true)
    try {
      const result = await apiClient.permissions.get()
      if (!result.ok) throw new Error('Failed to load permissions')
      setPermissionsData(result.data?.permissions ?? [])
      versionRef.current = result.data?.version ?? 0
    } catch (err) {
      console.error('Failed to load permissions:', err)
      notifications.show({
        message: 'Failed to load permissions',
        color: 'red',
      })
    } finally {
      setPermissionsLoading(false)
    }
  }

  const handleSavePermissions = async (permissions: PathPermission[]) => {
    try {
      const result = await apiClient.permissions.update({
        permissions,
        expectedContentVersion: versionRef.current,
      })
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

  // Propagates failures instead of returning [] (matching loadPermissions and
  // handleSavePermissions above). The generated client RESOLVES with the error
  // envelope rather than throwing, so swallowing `!result.ok` into an empty
  // array left useGroupsAndUsers' .catch unfired and groupLoadError null --
  // an unreadable groups.json rendered as a silently empty picker with no
  // warning, which is the same failure class listGroupsHandler's deliberate
  // 500 exists to prevent.
  const handleListGroups = async () => {
    const result = await apiClient.permissions.listGroups()
    if (!result.ok) {
      throw new Error(result.error || 'Failed to load groups')
    }
    return result.data?.groups ?? []
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
