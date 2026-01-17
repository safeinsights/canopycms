'use client'

import React, { useState, useEffect, useMemo } from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Collapse,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Loader,
  Alert,
  Tooltip,
  Tabs,
} from '@mantine/core'
import {
  IconChevronRight,
  IconChevronDown,
  IconFolder,
  IconFile,
  IconAlertCircle,
  IconSearch,
  IconX,
  IconEye,
  IconPencil,
  IconCheckbox,
  IconUserOff,
} from '@tabler/icons-react'
import type { PathPermission, PermissionLevel, PermissionTarget } from '../config'
import type { UserSearchResult, GroupMetadata } from '../auth/types'
import type { CanopyConfig } from '../config'
import { flattenSchema } from '../config'
import { UserBadge } from './components/UserBadge'
import type { EditorCollection } from './Editor'

export interface PermissionManagerProps {
  /** Content schema to build tree from (optional - can use collections instead) */
  schema?: CanopyConfig['schema']
  /** Collections from API (alternative to schema for file-based configs) */
  collections?: EditorCollection[]
  /** Content root path (default: 'content') */
  contentRoot?: string
  /** Current permissions */
  permissions: PathPermission[]
  /** Whether user can edit permissions (admin only) */
  canEdit: boolean
  /** Handler to save updated permissions */
  onSave?: (permissions: PathPermission[]) => Promise<void>
  /** Handler to search users */
  onSearchUsers?: (query: string, limit?: number) => Promise<UserSearchResult[]>
  /** Handler to get user metadata by ID */
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  /** Handler to list groups */
  onListGroups?: () => Promise<GroupMetadata[]>
  /** Close handler */
  onClose?: () => void
  /** Loading state */
  loading?: boolean
  /** Optional: actual filesystem content tree (for entries not in schema) */
  contentTree?: ContentNode
}

export interface ContentNode {
  path: string
  name: string
  type: 'folder' | 'file'
  children?: ContentNode[]
}

interface TreeNode {
  path: string
  name: string
  type: 'folder' | 'file'
  children: TreeNode[]
  // Permissions directly assigned to this node
  directPermission?: PathPermission
  // Permissions inherited from parent
  inheritedPermission?: PathPermission
}

const PERMISSION_LEVELS: PermissionLevel[] = ['read', 'edit', 'review']

const LEVEL_CONFIG: Record<PermissionLevel, { label: string; icon: React.ReactNode; color: string }> = {
  read: { label: 'Read', icon: <IconEye size={14} />, color: 'blue' },
  edit: { label: 'Edit', icon: <IconPencil size={14} />, color: 'green' },
  review: { label: 'Review', icon: <IconCheckbox size={14} />, color: 'grape' },
}

// Helper: Find a tree node by path
function findTreeNode(node: TreeNode, path: string): TreeNode | null {
  if (node.path === path) return node
  for (const child of node.children) {
    const found = findTreeNode(child, path)
    if (found) return found
  }
  return null
}

export const PermissionManager: React.FC<PermissionManagerProps> = ({
  schema,
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
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set(['content']))
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [localPermissions, setLocalPermissions] = useState<PathPermission[]>(permissions)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeLevel, setActiveLevel] = useState<PermissionLevel>('read')

  // Groups state
  const [groups, setGroups] = useState<GroupMetadata[]>([])
  const [isLoadingGroups, setIsLoadingGroups] = useState(false)
  const [groupLoadError, setGroupLoadError] = useState<string | null>(null)

  // User search state
  const [userSearchResults, setUserSearchResults] = useState<UserSearchResult[]>([])
  const [isSearchingUsers, setIsSearchingUsers] = useState(false)
  const [userSearchQuery, setUserSearchQuery] = useState('')
  const [showUserSearch, setShowUserSearch] = useState(false)
  const [userSearchError, setUserSearchError] = useState<string | null>(null)

  // Group search state
  const [groupSearchQuery, setGroupSearchQuery] = useState('')
  const [showGroupSearch, setShowGroupSearch] = useState(false)

  // Load groups on mount
  useEffect(() => {
    if (onListGroups && canEdit) {
      setIsLoadingGroups(true)
      onListGroups()
        .then((loadedGroups) => {
          setGroups(loadedGroups)
          setGroupLoadError(null)
        })
        .catch((err) => {
          console.error('Failed to load groups:', err)
          setGroupLoadError('Failed to load groups. Group selection may be unavailable.')
        })
        .finally(() => setIsLoadingGroups(false))
    }
  }, [onListGroups, canEdit])

  // Transform groups to select data format
  const groupSelectData = useMemo(
    () => groups.map((g) => ({
      value: g.id,
      label: g.name,
    })),
    [groups]
  )

  // Filter groups based on search query
  const filteredGroups = useMemo(() => {
    const query = groupSearchQuery.toLowerCase().trim()
    if (!query) return groupSelectData

    return groupSelectData.filter(
      (g) =>
        g.label.toLowerCase().includes(query) ||
        g.value.toLowerCase().includes(query)
    )
  }, [groupSearchQuery, groupSelectData])

  // Debounced user search
  useEffect(() => {
    if (!showUserSearch || !userSearchQuery.trim()) return

    const timer = setTimeout(() => {
      if (onSearchUsers) {
        setIsSearchingUsers(true)
        setUserSearchError(null)
        onSearchUsers(userSearchQuery, 10)
          .then((results) => {
            setUserSearchResults(results)
            setUserSearchError(null)
          })
          .catch((err) => {
            console.error('User search failed:', err)
            setUserSearchError('Failed to search users. Please try again.')
            setUserSearchResults([])
          })
          .finally(() => setIsSearchingUsers(false))
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [userSearchQuery, onSearchUsers, showUserSearch])

  // Build tree from schema (or collections) + contentTree
  const tree = useMemo(() => buildTree(schema, contentTree, contentRoot, collections), [schema, collections, contentTree, contentRoot])

  // Annotate tree with permissions
  const annotatedTree = useMemo(
    () => annotateTreeWithPermissions(tree, localPermissions),
    [tree, localPermissions]
  )

  // Reset local state when permissions change
  useEffect(() => {
    setLocalPermissions(permissions)
    setIsDirty(false)
  }, [permissions])

  const toggleNode = (path: string) => {
    const newExpanded = new Set(expandedNodes)
    if (newExpanded.has(path)) {
      newExpanded.delete(path)
    } else {
      newExpanded.add(path)
    }
    setExpandedNodes(newExpanded)
  }

  const expandAll = () => {
    const allPaths = new Set<string>()
    const collectPaths = (node: TreeNode) => {
      if (node.type === 'folder') {
        allPaths.add(node.path)
      }
      node.children.forEach(collectPaths)
    }
    collectPaths(annotatedTree)
    setExpandedNodes(allPaths)
  }

  const collapseAll = () => {
    setExpandedNodes(new Set())
  }

  const updateNodePermission = (nodePath: string, level: PermissionLevel, updates: Partial<PermissionTarget>) => {
    const newPermissions = [...localPermissions]

    // Find the tree node to determine correct path pattern
    const treeNode = findTreeNode(annotatedTree, nodePath)
    const permissionPath = treeNode?.type === 'folder' ? `${nodePath}/**` : nodePath

    const existingIndex = newPermissions.findIndex((p) => p.path === permissionPath)

    if (existingIndex >= 0) {
      // Update existing permission for this level
      const existing = newPermissions[existingIndex]
      const updatedLevel: PermissionTarget = {
        ...existing[level],
        ...updates,
      }

      // Clean up empty arrays
      if (updatedLevel.allowedUsers?.length === 0) delete updatedLevel.allowedUsers
      if (updatedLevel.allowedGroups?.length === 0) delete updatedLevel.allowedGroups

      // If level target is empty, remove it
      if (!updatedLevel.allowedUsers && !updatedLevel.allowedGroups) {
        newPermissions[existingIndex] = { ...existing, [level]: undefined }
      } else {
        newPermissions[existingIndex] = { ...existing, [level]: updatedLevel }
      }

      // If all levels are empty, remove the permission entirely
      const perm = newPermissions[existingIndex]
      if (!perm.read && !perm.edit && !perm.review) {
        newPermissions.splice(existingIndex, 1)
      }
    } else {
      // Add new permission
      if (updates.allowedUsers?.length || updates.allowedGroups?.length) {
        newPermissions.push({
          path: permissionPath,
          [level]: updates,
        })
      }
    }

    setLocalPermissions(newPermissions)
    setIsDirty(true)
  }

  const handleSave = async () => {
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
  }

  const handleDiscard = () => {
    setLocalPermissions(permissions)
    setIsDirty(false)
    setError(null)
    setSelectedNode(null)
  }

  const handleAddUser = (nodePath: string, level: PermissionLevel, userId: string) => {
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
    setShowUserSearch(false)
    setUserSearchResults([])
    setUserSearchError(null)
  }

  const handleToggleUserSearch = (show: boolean) => {
    setShowUserSearch(show)
    if (!show) {
      setUserSearchQuery('')
      setUserSearchResults([])
      setUserSearchError(null)
    }
  }

  const handleRemoveUser = (nodePath: string, level: PermissionLevel, userId: string) => {
    const treeNode = findTreeNode(annotatedTree, nodePath)
    const permissionPath = treeNode?.type === 'folder' ? `${nodePath}/**` : nodePath
    const existingPerm = localPermissions.find((p) => p.path === permissionPath)
    const currentTarget = existingPerm?.[level]
    if (!currentTarget) return

    updateNodePermission(nodePath, level, {
      allowedUsers: (currentTarget.allowedUsers ?? []).filter((u) => u !== userId),
      allowedGroups: currentTarget.allowedGroups,
    })
  }

  const handleAddGroup = (nodePath: string, level: PermissionLevel, groupId: string) => {
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
  }

  const handleRemoveGroup = (nodePath: string, level: PermissionLevel, groupId: string) => {
    const treeNode = findTreeNode(annotatedTree, nodePath)
    const permissionPath = treeNode?.type === 'folder' ? `${nodePath}/**` : nodePath
    const existingPerm = localPermissions.find((p) => p.path === permissionPath)
    const currentTarget = existingPerm?.[level]
    if (!currentTarget) return

    updateNodePermission(nodePath, level, {
      allowedGroups: (currentTarget.allowedGroups ?? []).filter((g) => g !== groupId),
      allowedUsers: currentTarget.allowedUsers,
    })
  }

  return (
    <Stack h="100%" style={{ display: 'flex', flexDirection: 'column' }} gap={0}>
      {!canEdit && (
        <Alert
          icon={<IconAlertCircle size={16} />}
          color="yellow"
          mb="sm"
          title="Read-only"
        >
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
          onClose={() => setGroupLoadError(null)}
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
            <Text size="sm" c="dimmed">Loading permissions...</Text>
          </Group>
        ) : (
          <TreeNodeComponent
            node={annotatedTree}
            expandedNodes={expandedNodes}
            selectedNode={selectedNode}
            canEdit={canEdit}
            groups={groupSelectData}
            userSearchResults={userSearchResults}
            isSearchingUsers={isSearchingUsers}
            showUserSearch={showUserSearch}
            userSearchQuery={userSearchQuery}
            showGroupSearch={showGroupSearch}
            groupSearchQuery={groupSearchQuery}
            filteredGroups={filteredGroups}
            userSearchError={userSearchError}
            activeLevel={activeLevel}
            onToggle={toggleNode}
            onSelect={setSelectedNode}
            onSetActiveLevel={setActiveLevel}
            onUpdatePermission={updateNodePermission}
            onSearchUsers={setUserSearchQuery}
            onGetUserMetadata={onGetUserMetadata}
            onToggleUserSearch={handleToggleUserSearch}
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
        <Group justify="flex-end" py="sm" gap="sm" style={{ borderTop: '1px solid var(--mantine-color-gray-3)' }}>
          <Button
            variant="subtle"
            color="neutral"
            onClick={handleDiscard}
            disabled={isSaving}
          >
            Discard Changes
          </Button>
          <Button
            onClick={handleSave}
            loading={isSaving}
            disabled={isSaving}
          >
            Save Permissions
          </Button>
        </Group>
      )}
    </Stack>
  )
}

interface TreeNodeComponentProps {
  node: TreeNode
  expandedNodes: Set<string>
  selectedNode: string | null
  canEdit: boolean
  groups: Array<{ value: string; label: string }>
  userSearchResults: UserSearchResult[]
  isSearchingUsers: boolean
  showUserSearch: boolean
  userSearchQuery: string
  userSearchError: string | null
  showGroupSearch: boolean
  groupSearchQuery: string
  filteredGroups: Array<{ value: string; label: string }>
  activeLevel: PermissionLevel
  onToggle: (path: string) => void
  onSelect: (path: string | null) => void
  onSetActiveLevel: (level: PermissionLevel) => void
  onUpdatePermission: (path: string, level: PermissionLevel, updates: Partial<PermissionTarget>) => void
  onSearchUsers: (query: string) => void
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  onToggleUserSearch: (show: boolean) => void
  onAddUser: (path: string, level: PermissionLevel, userId: string) => void
  onRemoveUser: (path: string, level: PermissionLevel, userId: string) => void
  onSearchGroups: (query: string) => void
  onToggleGroupSearch: (show: boolean) => void
  onAddGroup: (path: string, level: PermissionLevel, groupId: string) => void
  onRemoveGroup: (path: string, level: PermissionLevel, groupId: string) => void
}

const TreeNodeComponent: React.FC<TreeNodeComponentProps> = ({
  node,
  expandedNodes,
  selectedNode,
  canEdit,
  groups,
  userSearchResults,
  isSearchingUsers,
  showUserSearch,
  userSearchQuery,
  userSearchError,
  showGroupSearch,
  groupSearchQuery,
  filteredGroups,
  activeLevel,
  onToggle,
  onSelect,
  onSetActiveLevel,
  onUpdatePermission,
  onSearchUsers,
  onGetUserMetadata,
  onToggleUserSearch,
  onAddUser,
  onRemoveUser,
  onSearchGroups,
  onToggleGroupSearch,
  onAddGroup,
  onRemoveGroup,
}) => {
  const isExpanded = expandedNodes.has(node.path)
  const isSelected = selectedNode === node.path
  const hasChildren = node.children.length > 0

  const handleClick = () => {
    if (node.type === 'folder') {
      onToggle(node.path)
    }
    onSelect(node.path === selectedNode ? null : node.path)
  }

  const directPerm = node.directPermission
  const inheritedPerm = node.inheritedPermission

  // Get permission target for a level (from direct or inherited)
  const getTargetForLevel = (level: PermissionLevel, source: 'direct' | 'inherited'): PermissionTarget | undefined => {
    const perm = source === 'direct' ? directPerm : inheritedPerm
    return perm?.[level]
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: 'var(--mantine-spacing-xs)',
          padding: '4px var(--mantine-spacing-xs)',
          cursor: 'pointer',
          backgroundColor: isSelected ? 'var(--mantine-color-blue-light)' : 'transparent',
          borderRadius: 'var(--mantine-radius-sm)',
        }}
        onClick={handleClick}
      >
        {/* Tree controls and icon - fixed width container */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--mantine-spacing-xs)', flexShrink: 0 }}>
          {node.type === 'folder' && hasChildren && (
            <ActionIcon size="xs" variant="transparent" color="gray">
              {isExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            </ActionIcon>
          )}
          {(node.type === 'file' || (node.type === 'folder' && !hasChildren)) && <div style={{ width: 18 }} />}
          {node.type === 'folder' ? <IconFolder size={16} /> : <IconFile size={16} />}
          <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
            {node.name}
          </Text>
        </div>

        {/* Show permission level badges */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 }}>
          {PERMISSION_LEVELS.map((level) => {
            const target = getTargetForLevel(level, 'direct')
            const inherited = getTargetForLevel(level, 'inherited')
            const hasPerms = target && ((target.allowedUsers?.length ?? 0) > 0 || (target.allowedGroups?.length ?? 0) > 0)
            const hasInherited = !hasPerms && inherited && ((inherited.allowedUsers?.length ?? 0) > 0 || (inherited.allowedGroups?.length ?? 0) > 0)

            if (hasPerms) {
              return (
                <Badge key={level} size="xs" variant="filled" color={LEVEL_CONFIG[level].color}>
                  {LEVEL_CONFIG[level].label}
                </Badge>
              )
            }
            if (hasInherited) {
              return (
                <Tooltip key={level} label={`${LEVEL_CONFIG[level].label} inherited from parent`}>
                  <Badge size="xs" variant="outline" color="gray">
                    {LEVEL_CONFIG[level].label}
                  </Badge>
                </Tooltip>
              )
            }
            return null
          })}
        </div>
      </div>

      {/* Expanded permission editor */}
      <Collapse in={isSelected}>
        <Paper withBorder p="sm" ml={32} mt="xs" mb="xs">
          <Stack gap="sm">
            <Text size="xs" fw={500} c="dimmed">
              Path: {node.path}{node.type === 'folder' ? '/**' : ''}
            </Text>

            {/* Level tabs */}
            <Tabs value={activeLevel} onChange={(v) => onSetActiveLevel(v as PermissionLevel)}>
              <Tabs.List>
                {PERMISSION_LEVELS.map((level) => (
                  <Tabs.Tab
                    key={level}
                    value={level}
                    leftSection={LEVEL_CONFIG[level].icon}
                  >
                    {LEVEL_CONFIG[level].label}
                  </Tabs.Tab>
                ))}
              </Tabs.List>

              {PERMISSION_LEVELS.map((level) => {
                const directTarget = getTargetForLevel(level, 'direct')
                const inheritedTarget = getTargetForLevel(level, 'inherited')

                return (
                  <Tabs.Panel key={level} value={level} pt="sm">
                    {inheritedTarget && (
                      <div style={{ marginBottom: 'var(--mantine-spacing-sm)' }}>
                        <Text size="xs" fw={500} mb={4} c="dimmed">
                          Inherited from parent
                        </Text>
                        <Group gap="xs">
                          {inheritedTarget.allowedGroups?.map((groupId) => {
                            const groupInfo = groups.find((g) => g.value === groupId)
                            return (
                              <Badge key={`inherited-group-${groupId}`} variant="outline" color="gray" size="xs">
                                {groupInfo?.label ?? groupId}
                              </Badge>
                            )
                          })}
                          {inheritedTarget.allowedUsers?.map((userId) =>
                            onGetUserMetadata ? (
                              <UserBadge
                                key={`inherited-user-${userId}`}
                                userId={userId}
                                getUserMetadata={onGetUserMetadata}
                                variant="avatar-name"
                                size="xs"
                                badgeVariant="outline"
                                color="gray"
                                showEmailTooltip={true}
                                showBadge={true}
                              />
                            ) : (
                              <Badge
                                key={`inherited-user-${userId}`}
                                variant="outline"
                                color={userId === 'anonymous' ? 'orange' : 'gray'}
                                size="xs"
                                leftSection={userId === 'anonymous' ? <IconUserOff size={10} /> : undefined}
                              >
                                {userId === 'anonymous' ? 'Anonymous (Public)' : userId}
                              </Badge>
                            )
                          )}
                        </Group>
                      </div>
                    )}

                    {canEdit ? (
                      <div>
                        <Text size="xs" fw={500} mb={4}>
                          {LEVEL_CONFIG[level].label} Access
                        </Text>

                        {/* Badges for groups and users */}
                        <Group gap="xs" mb="xs">
                          {(directTarget?.allowedGroups ?? []).map((groupId) => {
                            const groupInfo = groups.find((g) => g.value === groupId)
                            return (
                              <Badge
                                key={`group-${groupId}`}
                                variant="filled"
                                color={LEVEL_CONFIG[level].color}
                                pr={3}
                                rightSection={
                                  <ActionIcon
                                    size="xs"
                                    color={LEVEL_CONFIG[level].color}
                                    radius="xl"
                                    variant="transparent"
                                    onClick={() => onRemoveGroup(node.path, level, groupId)}
                                  >
                                    <IconX size={12} stroke={2.5} style={{ color: 'white' }} />
                                  </ActionIcon>
                                }
                              >
                                {groupInfo?.label ?? groupId}
                              </Badge>
                            )
                          })}

                          {(directTarget?.allowedUsers ?? []).map((userId) =>
                            onGetUserMetadata ? (
                              <UserBadge
                                key={`user-${userId}`}
                                userId={userId}
                                getUserMetadata={onGetUserMetadata}
                                variant="avatar-name"
                                size="xs"
                                badgeVariant="filled"
                                color={userId === 'anonymous' ? 'orange' : LEVEL_CONFIG[level].color}
                                onRemove={() => onRemoveUser(node.path, level, userId)}
                                showEmailTooltip={true}
                              />
                            ) : (
                              <Badge
                                key={`user-${userId}`}
                                variant="filled"
                                color={userId === 'anonymous' ? 'orange' : LEVEL_CONFIG[level].color}
                                pr={3}
                                leftSection={userId === 'anonymous' ? <IconUserOff size={12} /> : undefined}
                                rightSection={
                                  <ActionIcon
                                    size="xs"
                                    color={userId === 'anonymous' ? 'orange' : LEVEL_CONFIG[level].color}
                                    radius="xl"
                                    variant="transparent"
                                    onClick={() => onRemoveUser(node.path, level, userId)}
                                  >
                                    <IconX size={12} stroke={2.5} style={{ color: 'white' }} />
                                  </ActionIcon>
                                }
                              >
                                {userId === 'anonymous' ? 'Anonymous (Public)' : userId}
                              </Badge>
                            )
                          )}

                          {(!directTarget?.allowedGroups || directTarget.allowedGroups.length === 0) &&
                            (!directTarget?.allowedUsers || directTarget.allowedUsers.length === 0) && (
                              <Text size="xs" c="dimmed">No groups or users assigned for {level}</Text>
                            )}
                        </Group>

                        {/* Action buttons */}
                        <Group gap="xs">
                          <Button
                            size="xs"
                            variant="subtle"
                            leftSection={<IconSearch size={14} />}
                            onClick={() => onToggleGroupSearch(!showGroupSearch)}
                          >
                            {showGroupSearch ? 'Cancel' : 'Add Groups'}
                          </Button>

                          <Button
                            size="xs"
                            variant="subtle"
                            leftSection={<IconSearch size={14} />}
                            onClick={() => onToggleUserSearch(!showUserSearch)}
                          >
                            {showUserSearch ? 'Cancel' : 'Add User'}
                          </Button>

                          {/* Anonymous user button - only show if not already added */}
                          {!(directTarget?.allowedUsers ?? []).includes('anonymous') && (
                            <Tooltip label="Allow unauthenticated/public access">
                              <Button
                                size="xs"
                                variant="subtle"
                                color="orange"
                                leftSection={<IconUserOff size={14} />}
                                onClick={() => onAddUser(node.path, level, 'anonymous')}
                              >
                                Add Anonymous
                              </Button>
                            </Tooltip>
                          )}
                        </Group>

                        {/* Group search panel */}
                        {showGroupSearch && selectedNode === node.path && activeLevel === level && (
                          <Paper withBorder p="xs" mt="xs" style={{ maxWidth: 300 }}>
                            <Stack gap="xs">
                              <input
                                type="text"
                                placeholder="Search groups..."
                                value={groupSearchQuery}
                                onChange={(e) => onSearchGroups(e.target.value)}
                                aria-label="Search groups"
                                style={{
                                  width: '100%',
                                  padding: '4px 6px',
                                  border: '1px solid var(--mantine-color-gray-4)',
                                  borderRadius: 'var(--mantine-radius-sm)',
                                  fontSize: '12px',
                                }}
                              />
                              {filteredGroups.length > 0 && (
                                <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                                  {filteredGroups.map((group) => (
                                    <div
                                      key={group.value}
                                      style={{
                                        padding: '4px 6px',
                                        cursor: 'pointer',
                                        borderRadius: 'var(--mantine-radius-sm)',
                                        fontSize: '12px',
                                      }}
                                      onMouseEnter={(e) => {
                                        e.currentTarget.style.backgroundColor = 'var(--mantine-color-gray-1)'
                                      }}
                                      onMouseLeave={(e) => {
                                        e.currentTarget.style.backgroundColor = 'transparent'
                                      }}
                                      onClick={() => onAddGroup(node.path, level, group.value)}
                                    >
                                      {group.label}
                                    </div>
                                  ))}
                                </div>
                              )}
                              {groupSearchQuery.trim() && filteredGroups.length === 0 && (
                                <Text size="xs" c="dimmed">No groups found</Text>
                              )}
                            </Stack>
                          </Paper>
                        )}

                        {/* User search panel */}
                        {showUserSearch && selectedNode === node.path && activeLevel === level && (
                          <Paper withBorder p="sm" mt="xs">
                            <Stack gap="xs">
                              <input
                                type="text"
                                placeholder="Search users by name or email..."
                                value={userSearchQuery}
                                onChange={(e) => onSearchUsers(e.target.value)}
                                aria-label="Search users by name or email"
                                style={{
                                  width: '100%',
                                  padding: '6px 8px',
                                  border: '1px solid var(--mantine-color-gray-4)',
                                  borderRadius: 'var(--mantine-radius-sm)',
                                  fontSize: '14px',
                                }}
                              />
                              {isSearchingUsers && <Loader size="xs" />}
                              {userSearchError && (
                                <Text size="xs" c="red">{userSearchError}</Text>
                              )}
                              {userSearchResults.length > 0 && (
                                <Stack gap={4}>
                                  {userSearchResults.map((user) => (
                                    <Paper
                                      key={user.id}
                                      p="xs"
                                      withBorder
                                      style={{ cursor: 'pointer' }}
                                      onClick={() => onAddUser(node.path, level, user.id)}
                                    >
                                      {onGetUserMetadata ? (
                                        <UserBadge
                                          userId={user.id}
                                          getUserMetadata={onGetUserMetadata}
                                          variant="full"
                                          size="sm"
                                          cachedUser={user}
                                          showEmailTooltip={false}
                                        />
                                      ) : (
                                        <>
                                          <Text size="sm" fw={500}>{user.name}</Text>
                                          <Text size="xs" c="dimmed">{user.email}</Text>
                                        </>
                                      )}
                                    </Paper>
                                  ))}
                                </Stack>
                              )}
                              {userSearchQuery.trim() && !isSearchingUsers && userSearchResults.length === 0 && (
                                <Text size="xs" c="dimmed">No users found</Text>
                              )}
                            </Stack>
                          </Paper>
                        )}
                      </div>
                    ) : (
                      <Text size="xs" c="dimmed">
                        {directTarget ? 'Read-only view' : 'No direct permissions set'}
                      </Text>
                    )}
                  </Tabs.Panel>
                )
              })}
            </Tabs>
          </Stack>
        </Paper>
      </Collapse>

      {/* Children */}
      {node.type === 'folder' && hasChildren && (
        <Collapse in={isExpanded}>
          <div style={{ paddingLeft: 16 }}>
            {node.children.map((child) => (
              <TreeNodeComponent
                key={child.path}
                node={child}
                expandedNodes={expandedNodes}
                selectedNode={selectedNode}
                canEdit={canEdit}
                groups={groups}
                userSearchResults={userSearchResults}
                isSearchingUsers={isSearchingUsers}
                showUserSearch={showUserSearch}
                userSearchQuery={userSearchQuery}
                userSearchError={userSearchError}
                showGroupSearch={showGroupSearch}
                groupSearchQuery={groupSearchQuery}
                filteredGroups={filteredGroups}
                activeLevel={activeLevel}
                onToggle={onToggle}
                onSelect={onSelect}
                onSetActiveLevel={onSetActiveLevel}
                onUpdatePermission={onUpdatePermission}
                onSearchUsers={onSearchUsers}
                onGetUserMetadata={onGetUserMetadata}
                onToggleUserSearch={onToggleUserSearch}
                onAddUser={onAddUser}
                onRemoveUser={onRemoveUser}
                onSearchGroups={onSearchGroups}
                onToggleGroupSearch={onToggleGroupSearch}
                onAddGroup={onAddGroup}
                onRemoveGroup={onRemoveGroup}
              />
            ))}
          </div>
        </Collapse>
      )}
    </div>
  )
}

// Helper: Convert EditorCollection[] to TreeNode structure
function convertCollectionsToTreeNodes(collections: EditorCollection[], contentRoot: string, parentPath?: string): TreeNode[] {
  const nodes: TreeNode[] = []

  for (const collection of collections) {
    const fullPath = parentPath ? `${parentPath}/${collection.name}` : `${contentRoot}/${collection.name}`

    const node: TreeNode = {
      path: fullPath,
      name: collection.label || collection.name,
      type: collection.type === 'collection' ? 'folder' : 'file',
      children: [],
    }

    // Recursively convert children
    if (collection.children) {
      node.children = convertCollectionsToTreeNodes(collection.children, contentRoot, fullPath)
    }

    nodes.push(node)
  }

  return nodes
}

// Helper: Build tree from schema and optional contentTree
function buildTree(
  schema: CanopyConfig['schema'] | undefined,
  contentTree: ContentNode | undefined,
  contentRoot = 'content',
  collections?: EditorCollection[]
): TreeNode {
  const root: TreeNode = {
    path: contentRoot,
    name: contentRoot,
    type: 'folder',
    children: [],
  }

  // If collections are provided (from API), use them instead of schema
  if (collections && collections.length > 0) {
    root.children = convertCollectionsToTreeNodes(collections, contentRoot)

    // Merge contentTree if provided
    if (contentTree) {
      mergeContentTree(root, contentTree)
    }

    return root
  }

  // Handle undefined schema gracefully
  if (!schema) {
    return root
  }

  // Flatten schema to get all collections and singletons
  const flatSchema = flattenSchema(schema, contentRoot)

  // Create a map of path -> TreeNode for fast lookup
  const nodeMap = new Map<string, TreeNode>()
  nodeMap.set(contentRoot, root)

  // First pass: Create all nodes
  flatSchema.forEach((item) => {
    const pathSegments = item.fullPath.split('/').filter(Boolean)
    const displayName = pathSegments[pathSegments.length - 1] || item.name

    const node: TreeNode = {
      path: item.fullPath,
      name: displayName,
      type: item.type === 'collection' ? 'folder' : 'file',
      children: [],
    }

    nodeMap.set(item.fullPath, node)
  })

  // Second pass: Build hierarchy using parentPath
  flatSchema.forEach((item) => {
    const node = nodeMap.get(item.fullPath)
    if (!node) return

    // Determine parent path (or use root if no parent)
    const parentPath = item.parentPath || contentRoot
    const parentNode = nodeMap.get(parentPath)

    if (parentNode) {
      parentNode.children.push(node)
    } else {
      // Fallback: add to root if parent not found
      root.children.push(node)
    }
  })

  // Merge contentTree if provided (for actual files not in schema)
  if (contentTree) {
    mergeContentTree(root, contentTree)
  }

  return root
}

// Helper: Merge actual content tree into schema tree
function mergeContentTree(schemaNode: TreeNode, contentNode: ContentNode) {
  contentNode.children?.forEach((child) => {
    const existing = schemaNode.children.find((n) => n.name === child.name)
    if (existing) {
      // If this is a folder/collection that exists in schema, recursively merge its children
      if (child.type === 'folder' && child.children) {
        mergeContentTree(existing, child)
      }
    } else if (child.type === 'file') {
      // Add file not in schema (e.g., entry created via filesystem)
      schemaNode.children.push({
        path: child.path,
        name: child.name,
        type: child.type,
        children: [],
      })
    }
  })
}

// Helper: Annotate tree with permissions
function annotateTreeWithPermissions(node: TreeNode, permissions: PathPermission[]): TreeNode {
  const folderPath = node.type === 'folder' ? `${node.path}/**` : node.path

  // Find direct permission
  const directPerm = permissions.find((p) => p.path === folderPath || p.path === node.path)

  // Find inherited permission from parent
  let inheritedPerm: PathPermission | undefined
  const pathParts = node.path.split('/')
  for (let i = pathParts.length - 1; i >= 0; i--) {
    const parentPath = pathParts.slice(0, i + 1).join('/')
    const parentFolderPath = `${parentPath}/**`
    const parentPerm = permissions.find((p) => p.path === parentFolderPath)
    if (parentPerm) {
      inheritedPerm = parentPerm
      break
    }
  }

  return {
    ...node,
    directPermission: directPerm,
    inheritedPermission: !directPerm ? inheritedPerm : undefined,
    children: node.children.map((child) => annotateTreeWithPermissions(child, permissions)),
  }
}
