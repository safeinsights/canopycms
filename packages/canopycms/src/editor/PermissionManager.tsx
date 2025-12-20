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
  Title,
  Loader,
  Alert,
  Tooltip,
} from '@mantine/core'
import {
  IconChevronRight,
  IconChevronDown,
  IconFolder,
  IconFile,
  IconAlertCircle,
  IconSearch,
  IconX,
} from '@tabler/icons-react'
import type { PathPermission } from '../config'
import type { UserSearchResult, GroupMetadata } from '../auth/types'
import type { CanopyConfig } from '../config'

export interface PermissionManagerProps {
  /** Content schema to build tree from */
  schema: CanopyConfig['schema']
  /** Current permissions */
  permissions: PathPermission[]
  /** Whether user can edit permissions (admin only) */
  canEdit: boolean
  /** Handler to save updated permissions */
  onSave?: (permissions: PathPermission[]) => Promise<void>
  /** Handler to search users */
  onSearchUsers?: (query: string, limit?: number) => Promise<UserSearchResult[]>
  /** Handler to list groups */
  onListGroups?: () => Promise<GroupMetadata[]>
  /** Close handler */
  onClose?: () => void
  /** Loading state */
  loading?: boolean
  /** Optional: actual filesystem content tree (for singletons not in schema) */
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
  permissions,
  canEdit,
  onSave,
  onSearchUsers,
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
    () =>
      groups.map((g) => ({
        value: g.id,
        label: g.name,
      })),
    [groups],
  )

  // Filter groups based on search query
  const filteredGroups = useMemo(() => {
    const query = groupSearchQuery.toLowerCase().trim()
    if (!query) return groupSelectData

    return groupSelectData.filter(
      (g) => g.label.toLowerCase().includes(query) || g.value.toLowerCase().includes(query),
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

  // Build tree from schema + contentTree
  const tree = useMemo(() => buildTree(schema, contentTree), [schema, contentTree])

  // Annotate tree with permissions
  const annotatedTree = useMemo(
    () => annotateTreeWithPermissions(tree, localPermissions),
    [tree, localPermissions],
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

  const updateNodePermission = (nodePath: string, updates: Partial<PathPermission>) => {
    const newPermissions = [...localPermissions]

    // Find the tree node to determine correct path pattern
    const treeNode = findTreeNode(annotatedTree, nodePath)
    const permissionPath = treeNode?.type === 'folder' ? `${nodePath}/**` : nodePath

    const existingIndex = newPermissions.findIndex((p) => p.path === permissionPath)

    if (existingIndex >= 0) {
      // Update existing
      newPermissions[existingIndex] = { ...newPermissions[existingIndex], ...updates }

      // If all fields are empty/undefined, remove the permission
      const perm = newPermissions[existingIndex]
      if (
        (!perm.allowedUsers || perm.allowedUsers.length === 0) &&
        (!perm.allowedGroups || perm.allowedGroups.length === 0)
      ) {
        newPermissions.splice(existingIndex, 1)
      }
    } else {
      // Add new
      if (updates.allowedUsers?.length || updates.allowedGroups?.length) {
        newPermissions.push({ path: permissionPath, ...updates })
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

  const handleAddUser = (nodePath: string, userId: string) => {
    // Find the tree node to get the correct permission path
    const treeNode = findTreeNode(annotatedTree, nodePath)
    const permissionPath = treeNode?.type === 'folder' ? `${nodePath}/**` : nodePath
    const existingPerm = localPermissions.find((p) => p.path === permissionPath)
    const currentUsers = existingPerm?.allowedUsers ?? []

    if (!currentUsers.includes(userId)) {
      updateNodePermission(nodePath, {
        allowedUsers: [...currentUsers, userId],
        allowedGroups: existingPerm?.allowedGroups,
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
      // Closing - clear search results and errors
      setUserSearchQuery('')
      setUserSearchResults([])
      setUserSearchError(null)
    }
  }

  const handleRemoveUser = (nodePath: string, userId: string) => {
    // Find the tree node to get the correct permission path
    const treeNode = findTreeNode(annotatedTree, nodePath)
    const permissionPath = treeNode?.type === 'folder' ? `${nodePath}/**` : nodePath
    const existingPerm = localPermissions.find((p) => p.path === permissionPath)
    if (!existingPerm) return

    updateNodePermission(nodePath, {
      allowedUsers: (existingPerm.allowedUsers ?? []).filter((u) => u !== userId),
      allowedGroups: existingPerm.allowedGroups,
    })
  }

  const handleAddGroup = (nodePath: string, groupId: string) => {
    // Find the tree node to get the correct permission path
    const treeNode = findTreeNode(annotatedTree, nodePath)
    const permissionPath = treeNode?.type === 'folder' ? `${nodePath}/**` : nodePath
    const existingPerm = localPermissions.find((p) => p.path === permissionPath)
    const currentGroups = existingPerm?.allowedGroups ?? []

    if (!currentGroups.includes(groupId)) {
      updateNodePermission(nodePath, {
        allowedGroups: [...currentGroups, groupId],
        allowedUsers: existingPerm?.allowedUsers,
      })
    }

    setGroupSearchQuery('')
    setShowGroupSearch(false)
  }

  return (
    <Paper
      withBorder
      radius="md"
      shadow="sm"
      h="100%"
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      <Group justify="space-between" px="md" py="sm">
        <div>
          <Title order={4}>Permissions</Title>
          <Text size="xs" c="dimmed">
            Manage content access by path
          </Text>
        </div>
        <Button variant="subtle" color="neutral" size="xs" onClick={onClose}>
          Close
        </Button>
      </Group>

      {!canEdit && (
        <Alert
          icon={<IconAlertCircle size={16} />}
          color="yellow"
          mx="md"
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
          mx="md"
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
          mx="md"
          mb="sm"
          title="Warning"
          withCloseButton
          onClose={() => setGroupLoadError(null)}
        >
          {groupLoadError}
        </Alert>
      )}

      <Group gap="xs" px="md" pb="sm">
        <Button size="xs" variant="subtle" onClick={expandAll}>
          Expand All
        </Button>
        <Button size="xs" variant="subtle" onClick={collapseAll}>
          Collapse All
        </Button>
      </Group>

      <ScrollArea style={{ flex: 1 }} px="md" pb="md">
        {loading ? (
          <Group justify="center" py="xl">
            <Loader size="md" />
            <Text size="sm" c="dimmed">
              Loading permissions...
            </Text>
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
            onToggle={toggleNode}
            onSelect={setSelectedNode}
            onUpdatePermission={updateNodePermission}
            onSearchUsers={setUserSearchQuery}
            onToggleUserSearch={handleToggleUserSearch}
            onAddUser={handleAddUser}
            onRemoveUser={handleRemoveUser}
            onSearchGroups={setGroupSearchQuery}
            onToggleGroupSearch={setShowGroupSearch}
            onAddGroup={handleAddGroup}
          />
        )}
      </ScrollArea>

      {canEdit && isDirty && (
        <Group
          justify="flex-end"
          px="md"
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
    </Paper>
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
  onToggle: (path: string) => void
  onSelect: (path: string | null) => void
  onUpdatePermission: (path: string, updates: Partial<PathPermission>) => void
  onSearchUsers: (query: string) => void
  onToggleUserSearch: (show: boolean) => void
  onAddUser: (path: string, userId: string) => void
  onRemoveUser: (path: string, userId: string) => void
  onSearchGroups: (query: string) => void
  onToggleGroupSearch: (show: boolean) => void
  onAddGroup: (path: string, groupId: string) => void
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
  onToggle,
  onSelect,
  onUpdatePermission,
  onSearchUsers,
  onToggleUserSearch,
  onAddUser,
  onRemoveUser,
  onSearchGroups,
  onToggleGroupSearch,
  onAddGroup,
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
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--mantine-spacing-xs)',
            flexShrink: 0,
          }}
        >
          {node.type === 'folder' && hasChildren && (
            <ActionIcon size="xs" variant="transparent" color="gray">
              {isExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            </ActionIcon>
          )}
          {(node.type === 'file' || (node.type === 'folder' && !hasChildren)) && (
            <div style={{ width: 18 }} />
          )}
          {node.type === 'folder' ? <IconFolder size={16} /> : <IconFile size={16} />}
          <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
            {node.name}
          </Text>
        </div>

        {/* Show permission badges - wrapping container */}
        {directPerm && (
          <div
            style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center', minWidth: 0 }}
          >
            {directPerm.allowedUsers?.map((u) => (
              <Badge key={u} size="xs" variant="filled" color="blue">
                {u}
              </Badge>
            ))}
            {directPerm.allowedGroups?.map((g) => {
              const groupInfo = groups.find((gr) => gr.value === g)
              return (
                <Badge key={g} size="xs" variant="filled" color="grape">
                  {groupInfo?.label ?? g}
                </Badge>
              )
            })}
          </div>
        )}

        {/* Show inherited permissions with tooltip */}
        {!directPerm && inheritedPerm && (
          <Tooltip label="Inherited from parent folder" position="right">
            <div
              style={{
                display: 'flex',
                gap: 4,
                flexWrap: 'wrap',
                alignItems: 'center',
                minWidth: 0,
              }}
            >
              {inheritedPerm.allowedUsers?.map((u) => (
                <Badge key={u} size="xs" variant="outline" color="gray">
                  {u}
                </Badge>
              ))}
              {inheritedPerm.allowedGroups?.map((g) => {
                const groupInfo = groups.find((gr) => gr.value === g)
                return (
                  <Badge key={g} size="xs" variant="outline" color="gray">
                    {groupInfo?.label ?? g}
                  </Badge>
                )
              })}
            </div>
          </Tooltip>
        )}
      </div>

      {/* Expanded permission editor */}
      <Collapse in={isSelected}>
        <Paper withBorder p="sm" ml={32} mt="xs" mb="xs">
          <Stack gap="sm">
            <Text size="xs" fw={500} c="dimmed">
              Path: {node.path}
              {node.type === 'folder' ? '/**' : ''}
            </Text>

            {inheritedPerm && (
              <div>
                <Text size="xs" fw={500} mb={4} c="dimmed">
                  Inherited from parent
                </Text>
                <Group gap="xs" mb="xs">
                  {/* Inherited group badges - no X button */}
                  {inheritedPerm.allowedGroups?.map((groupId) => {
                    const groupInfo = groups.find((g) => g.value === groupId)
                    return (
                      <Badge
                        key={`inherited-group-${groupId}`}
                        variant="outline"
                        color="gray"
                        size="xs"
                      >
                        {groupInfo?.label ?? groupId}
                      </Badge>
                    )
                  })}

                  {/* Inherited user badges - no X button */}
                  {inheritedPerm.allowedUsers?.map((userId) => (
                    <Badge
                      key={`inherited-user-${userId}`}
                      variant="outline"
                      color="gray"
                      size="xs"
                    >
                      {userId}
                    </Badge>
                  ))}
                </Group>
              </div>
            )}

            {canEdit && (
              <div>
                <Text size="xs" fw={500} mb={4}>
                  Allowed Groups and Users
                </Text>

                {/* Badges for groups and users */}
                <Group gap="xs" mb="xs">
                  {/* Group badges */}
                  {(directPerm?.allowedGroups ?? []).map((groupId) => {
                    const groupInfo = groups.find((g) => g.value === groupId)
                    return (
                      <Badge
                        key={`group-${groupId}`}
                        variant="filled"
                        color="grape"
                        pr={3}
                        rightSection={
                          <ActionIcon
                            size="xs"
                            color="grape"
                            radius="xl"
                            variant="transparent"
                            onClick={() => {
                              const current = directPerm?.allowedGroups ?? []
                              onUpdatePermission(node.path, {
                                allowedGroups:
                                  current.filter((g) => g !== groupId).length > 0
                                    ? current.filter((g) => g !== groupId)
                                    : undefined,
                                allowedUsers: directPerm?.allowedUsers,
                              })
                            }}
                          >
                            <IconX size={10} style={{ color: 'white' }} />
                          </ActionIcon>
                        }
                      >
                        {groupInfo?.label ?? groupId}
                      </Badge>
                    )
                  })}

                  {/* User badges */}
                  {(directPerm?.allowedUsers ?? []).map((userId) => (
                    <Badge
                      key={`user-${userId}`}
                      variant="filled"
                      color="blue"
                      pr={3}
                      rightSection={
                        <ActionIcon
                          size="xs"
                          color="blue"
                          radius="xl"
                          variant="transparent"
                          onClick={() => onRemoveUser(node.path, userId)}
                        >
                          <IconX size={10} style={{ color: 'white' }} />
                        </ActionIcon>
                      }
                    >
                      {userId}
                    </Badge>
                  ))}

                  {/* Empty state */}
                  {(!directPerm?.allowedGroups || directPerm.allowedGroups.length === 0) &&
                    (!directPerm?.allowedUsers || directPerm.allowedUsers.length === 0) && (
                      <Text size="xs" c="dimmed">
                        No groups or users assigned
                      </Text>
                    )}
                </Group>

                {/* Action buttons */}
                <Group gap="xs">
                  <Button
                    size="xs"
                    variant="subtle"
                    leftSection={<IconSearch size={14} />}
                    onClick={() => {
                      onToggleGroupSearch(!showGroupSearch)
                    }}
                  >
                    {showGroupSearch ? 'Cancel' : 'Add Groups'}
                  </Button>

                  <Button
                    size="xs"
                    variant="subtle"
                    leftSection={<IconSearch size={14} />}
                    onClick={() => {
                      onToggleUserSearch(!showUserSearch)
                    }}
                  >
                    {showUserSearch ? 'Cancel' : 'Add User'}
                  </Button>
                </Group>

                {/* Group search panel */}
                {showGroupSearch && selectedNode === node.path && (
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
                                e.currentTarget.style.backgroundColor =
                                  'var(--mantine-color-gray-1)'
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = 'transparent'
                              }}
                              onClick={() => onAddGroup(node.path, group.value)}
                            >
                              {group.label}
                            </div>
                          ))}
                        </div>
                      )}
                      {groupSearchQuery.trim() && filteredGroups.length === 0 && (
                        <Text size="xs" c="dimmed">
                          No groups found
                        </Text>
                      )}
                    </Stack>
                  </Paper>
                )}

                {/* User search panel */}
                {showUserSearch && selectedNode === node.path && (
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
                        <Text size="xs" c="red">
                          {userSearchError}
                        </Text>
                      )}
                      {userSearchResults.length > 0 && (
                        <Stack gap={4}>
                          {userSearchResults.map((user) => (
                            <Paper
                              key={user.id}
                              p="xs"
                              withBorder
                              style={{ cursor: 'pointer' }}
                              onClick={() => onAddUser(node.path, user.id)}
                            >
                              <Text size="sm" fw={500}>
                                {user.name}
                              </Text>
                              <Text size="xs" c="dimmed">
                                {user.email}
                              </Text>
                            </Paper>
                          ))}
                        </Stack>
                      )}
                      {userSearchQuery.trim() &&
                        !isSearchingUsers &&
                        userSearchResults.length === 0 && (
                          <Text size="xs" c="dimmed">
                            No users found
                          </Text>
                        )}
                    </Stack>
                  </Paper>
                )}
              </div>
            )}

            {!canEdit && (
              <Text size="xs" c="dimmed">
                {directPerm ? 'Read-only view' : 'No direct permissions set'}
              </Text>
            )}
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
                onToggle={onToggle}
                onSelect={onSelect}
                onUpdatePermission={onUpdatePermission}
                onSearchUsers={onSearchUsers}
                onToggleUserSearch={onToggleUserSearch}
                onAddUser={onAddUser}
                onRemoveUser={onRemoveUser}
                onSearchGroups={onSearchGroups}
                onToggleGroupSearch={onToggleGroupSearch}
                onAddGroup={onAddGroup}
              />
            ))}
          </div>
        </Collapse>
      )}
    </div>
  )
}

// Helper: Build tree from schema and optional contentTree
function buildTree(schema: CanopyConfig['schema'], contentTree?: ContentNode): TreeNode {
  const root: TreeNode = {
    path: 'content',
    name: 'content',
    type: 'folder',
    children: [],
  }

  // Add schema items
  schema.forEach((item) => {
    if (item.type === 'collection') {
      const collectionNode: TreeNode = {
        path: `content/${item.path}`,
        name: item.path,
        type: 'folder',
        children: [],
      }
      root.children.push(collectionNode)
    } else if (item.type === 'singleton') {
      const singletonNode: TreeNode = {
        path: `content/${item.path}`,
        name: item.path,
        type: 'file',
        children: [],
      }
      root.children.push(singletonNode)
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
      // Add file not in schema (e.g., singleton created via filesystem)
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
