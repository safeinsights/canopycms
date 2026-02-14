'use client'

/**
 * PermissionManager - Main component for managing path-based permissions.
 *
 * This component provides a tree-based UI for configuring read/edit/review
 * permissions on content paths. Supports both schema-based and collection-based
 * tree building.
 */

import React, { useState, useCallback } from 'react'
import { Alert, Button, Group, Loader, ScrollArea, Stack, Text } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'
import type { PermissionManagerProps, PermissionLevel, PermissionTarget } from './types'
import { usePermissionTree } from './hooks/usePermissionTree'
import { useGroupsAndUsers } from './hooks/useGroupsAndUsers'
import { PermissionTree } from './PermissionTree'
import { findTreeNode } from './utils'

export const PermissionManager: React.FC<PermissionManagerProps> = ({
  collections,
  contentRoot = 'content',
  permissions,
  canEdit,
  onSave,
  onSearchUsers,
  onGetUserMetadata,
  onListGroups,
  onClose,
  loading = false,
  contentTree,
}) => {
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeLevel, setActiveLevel] = useState<PermissionLevel>('read')

  // Tree state management
  const {
    annotatedTree,
    expandedNodes,
    selectedNode,
    localPermissions,
    isDirty,
    toggleNode,
    expandAll,
    collapseAll,
    selectNode,
    updateNodePermission,
    resetPermissions,
    setIsDirty,
  } = usePermissionTree({
    collections,
    contentRoot,
    permissions,
    contentTree,
  })

  // Groups and user search
  const {
    groupSelectData,
    filteredGroups,
    groupLoadError,
    groupSearchQuery,
    showGroupSearch,
    setGroupSearchQuery,
    setShowGroupSearch,
    clearGroupLoadError,
    userSearchResults,
    isSearchingUsers,
    userSearchQuery,
    showUserSearch,
    userSearchError,
    setUserSearchQuery,
    toggleUserSearch,
  } = useGroupsAndUsers({
    onListGroups,
    onSearchUsers,
    canEdit,
  })

  // Save handler
  const handleSave = useCallback(async () => {
    if (!onSave) return

    setIsSaving(true)
    setError(null)
    try {
      await onSave(localPermissions)
      setIsDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save permissions')
    } finally {
      setIsSaving(false)
    }
  }, [onSave, localPermissions, setIsDirty])

  // Discard handler
  const handleDiscard = useCallback(() => {
    resetPermissions()
    setError(null)
  }, [resetPermissions])

  // User add handler with search state cleanup
  const handleAddUser = useCallback(
    (nodePath: string, level: PermissionLevel, userId: string) => {
      const treeNode = findTreeNode(annotatedTree, nodePath)
      const permissionPath = treeNode?.type === 'folder' ? `${nodePath}/**` : nodePath
      const existingPerm = localPermissions.find((p) => p.path === permissionPath)
      const currentTarget = existingPerm?.[level]
      const currentUsers = currentTarget?.allowedUsers ?? []

      if (!currentUsers.includes(userId)) {
        updateNodePermission(nodePath, level, {
          allowedUsers: [...currentUsers, userId],
          allowedGroups: currentTarget?.allowedGroups,
        })
      }

      // Clear search state
      setUserSearchQuery('')
      toggleUserSearch(false)
    },
    [annotatedTree, localPermissions, updateNodePermission, setUserSearchQuery, toggleUserSearch]
  )

  // User remove handler
  const handleRemoveUser = useCallback(
    (nodePath: string, level: PermissionLevel, userId: string) => {
      const treeNode = findTreeNode(annotatedTree, nodePath)
      const permissionPath = treeNode?.type === 'folder' ? `${nodePath}/**` : nodePath
      const existingPerm = localPermissions.find((p) => p.path === permissionPath)
      const currentTarget = existingPerm?.[level]
      if (!currentTarget) return

      updateNodePermission(nodePath, level, {
        allowedUsers: (currentTarget.allowedUsers ?? []).filter((u) => u !== userId),
        allowedGroups: currentTarget.allowedGroups,
      })
    },
    [annotatedTree, localPermissions, updateNodePermission]
  )

  // Group add handler
  const handleAddGroup = useCallback(
    (nodePath: string, level: PermissionLevel, groupId: string) => {
      const treeNode = findTreeNode(annotatedTree, nodePath)
      const permissionPath = treeNode?.type === 'folder' ? `${nodePath}/**` : nodePath
      const existingPerm = localPermissions.find((p) => p.path === permissionPath)
      const currentTarget = existingPerm?.[level]
      const currentGroups = currentTarget?.allowedGroups ?? []

      if (!currentGroups.includes(groupId)) {
        updateNodePermission(nodePath, level, {
          allowedGroups: [...currentGroups, groupId],
          allowedUsers: currentTarget?.allowedUsers,
        })
      }

      setGroupSearchQuery('')
      setShowGroupSearch(false)
    },
    [annotatedTree, localPermissions, updateNodePermission, setGroupSearchQuery, setShowGroupSearch]
  )

  // Group remove handler
  const handleRemoveGroup = useCallback(
    (nodePath: string, level: PermissionLevel, groupId: string) => {
      const treeNode = findTreeNode(annotatedTree, nodePath)
      const permissionPath = treeNode?.type === 'folder' ? `${nodePath}/**` : nodePath
      const existingPerm = localPermissions.find((p) => p.path === permissionPath)
      const currentTarget = existingPerm?.[level]
      if (!currentTarget) return

      updateNodePermission(nodePath, level, {
        allowedGroups: (currentTarget.allowedGroups ?? []).filter((g) => g !== groupId),
        allowedUsers: currentTarget.allowedUsers,
      })
    },
    [annotatedTree, localPermissions, updateNodePermission]
  )

  return (
    <Stack h="100%" style={{ display: 'flex', flexDirection: 'column' }} gap={0}>
      {!canEdit && (
        <Alert icon={<IconAlertCircle size={16} />} color="yellow" mb="sm" title="Read-only">
          You need admin access to edit permissions
        </Alert>
      )}

      {error && (
        <Alert
          icon={<IconAlertCircle size={16} />}
          color="red"
          mb="sm"
          title="Error"
          withCloseButton
          onClose={() => setError(null)}
        >
          {error}
        </Alert>
      )}

      {groupLoadError && (
        <Alert
          icon={<IconAlertCircle size={16} />}
          color="orange"
          mb="sm"
          title="Warning"
          withCloseButton
          onClose={clearGroupLoadError}
        >
          {groupLoadError}
        </Alert>
      )}

      <Group gap="xs" pb="sm">
        <Button size="xs" variant="subtle" onClick={expandAll}>
          Expand All
        </Button>
        <Button size="xs" variant="subtle" onClick={collapseAll}>
          Collapse All
        </Button>
      </Group>

      <ScrollArea style={{ flex: 1 }} pb="md">
        {loading ? (
          <Group justify="center" py="xl">
            <Loader size="md" />
            <Text size="sm" c="dimmed">
              Loading permissions...
            </Text>
          </Group>
        ) : (
          <PermissionTree
            node={annotatedTree}
            expandedNodes={expandedNodes}
            selectedNode={selectedNode}
            canEdit={canEdit}
            groups={groupSelectData}
            activeLevel={activeLevel}
            userSearchResults={userSearchResults}
            isSearchingUsers={isSearchingUsers}
            showUserSearch={showUserSearch}
            userSearchQuery={userSearchQuery}
            userSearchError={userSearchError}
            showGroupSearch={showGroupSearch}
            groupSearchQuery={groupSearchQuery}
            filteredGroups={filteredGroups}
            onToggle={toggleNode}
            onSelect={selectNode}
            onSetActiveLevel={setActiveLevel}
            onUpdatePermission={updateNodePermission}
            onSearchUsers={setUserSearchQuery}
            onGetUserMetadata={onGetUserMetadata}
            onToggleUserSearch={toggleUserSearch}
            onAddUser={handleAddUser}
            onRemoveUser={handleRemoveUser}
            onSearchGroups={setGroupSearchQuery}
            onToggleGroupSearch={setShowGroupSearch}
            onAddGroup={handleAddGroup}
            onRemoveGroup={handleRemoveGroup}
          />
        )}
      </ScrollArea>

      {canEdit && isDirty && (
        <Group
          justify="flex-end"
          py="sm"
          gap="sm"
          style={{ borderTop: '1px solid var(--mantine-color-gray-3)' }}
        >
          <Button variant="subtle" color="neutral" onClick={handleDiscard} disabled={isSaving}>
            Discard Changes
          </Button>
          <Button onClick={handleSave} loading={isSaving} disabled={isSaving}>
            Save Permissions
          </Button>
        </Group>
      )}
    </Stack>
  )
}

// Re-export types and components for external use
export type { PermissionManagerProps, ContentNode, TreeNode } from './types'
export { usePermissionTree } from './hooks/usePermissionTree'
export { useGroupsAndUsers } from './hooks/useGroupsAndUsers'
