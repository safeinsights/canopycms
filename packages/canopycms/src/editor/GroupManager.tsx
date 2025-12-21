import React, { useState, useEffect } from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  Alert,
  Tabs,
  Tooltip,
} from '@mantine/core'
import {
  IconPlus,
  IconEdit,
  IconTrash,
  IconX,
  IconSearch,
  IconUsers,
  IconAlertCircle,
  IconBuilding,
} from '@tabler/icons-react'
import type { GroupMetadata, UserSearchResult } from '../auth/types'
import type { CanopyGroupId, CanopyUserId } from '../types'

export interface InternalGroup {
  id: CanopyGroupId
  name: string
  description?: string
  members: CanopyUserId[]
}

export interface ExternalGroup {
  id: CanopyGroupId
  name: string
}

export interface GroupManagerProps {
  internalGroups: InternalGroup[]
  loading?: boolean
  canEdit: boolean
  onSave?: (groups: InternalGroup[]) => Promise<void>
  onSearchUsers?: (query: string, limit?: number) => Promise<UserSearchResult[]>
  onSearchExternalGroups?: (query: string) => Promise<ExternalGroup[]>
  onClose?: () => void
}

export const GroupManager: React.FC<GroupManagerProps> = ({
  internalGroups: initialInternalGroups,
  loading = false,
  canEdit,
  onSave,
  onSearchUsers,
  onSearchExternalGroups,
  onClose,
}) => {
  const [groups, setGroups] = useState<InternalGroup[]>(initialInternalGroups)
  const [isDirty, setIsDirty] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Modal state for creating/editing groups
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<InternalGroup | null>(null)
  const [modalGroupId, setModalGroupId] = useState('')
  const [modalGroupName, setModalGroupName] = useState('')
  const [modalGroupDescription, setModalGroupDescription] = useState('')

  // User search state for adding members
  const [showUserSearch, setShowUserSearch] = useState<string | null>(null)
  const [userSearchQuery, setUserSearchQuery] = useState('')
  const [userSearchResults, setUserSearchResults] = useState<UserSearchResult[]>([])
  const [isSearchingUsers, setIsSearchingUsers] = useState(false)
  const [userSearchError, setUserSearchError] = useState<string | null>(null)

  // External groups search state
  const [externalGroupSearchQuery, setExternalGroupSearchQuery] = useState('')
  const [externalGroupResults, setExternalGroupResults] = useState<ExternalGroup[]>([])
  const [isSearchingExternal, setIsSearchingExternal] = useState(false)
  const [externalSearchError, setExternalSearchError] = useState<string | null>(null)

  // Sync groups when prop changes
  useEffect(() => {
    setGroups(initialInternalGroups)
  }, [initialInternalGroups])

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

  // Debounced external group search
  useEffect(() => {
    if (!externalGroupSearchQuery.trim()) {
      setExternalGroupResults([])
      return
    }

    const timer = setTimeout(() => {
      if (onSearchExternalGroups) {
        setIsSearchingExternal(true)
        setExternalSearchError(null)
        onSearchExternalGroups(externalGroupSearchQuery)
          .then((results) => {
            setExternalGroupResults(results)
            setExternalSearchError(null)
          })
          .catch((err) => {
            console.error('External group search failed:', err)
            setExternalSearchError('Failed to search external groups. Please try again.')
            setExternalGroupResults([])
          })
          .finally(() => setIsSearchingExternal(false))
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [externalGroupSearchQuery, onSearchExternalGroups])

  const handleCreateGroup = () => {
    setEditingGroup(null)
    setModalGroupId('')
    setModalGroupName('')
    setModalGroupDescription('')
    setIsModalOpen(true)
  }

  const handleEditGroup = (group: InternalGroup) => {
    setEditingGroup(group)
    setModalGroupId(group.id)
    setModalGroupName(group.name)
    setModalGroupDescription(group.description || '')
    setIsModalOpen(true)
  }

  const handleDeleteGroup = (groupId: CanopyGroupId) => {
    setGroups((prev) => prev.filter((g) => g.id !== groupId))
    setIsDirty(true)
  }

  const handleSaveModal = () => {
    if (!modalGroupId.trim() || !modalGroupName.trim()) {
      setError('Group ID and name are required')
      return
    }

    // Check for duplicate ID
    if (!editingGroup && groups.some((g) => g.id === modalGroupId)) {
      setError('Group ID already exists')
      return
    }

    if (editingGroup) {
      // Update existing group
      setGroups((prev) =>
        prev.map((g) =>
          g.id === editingGroup.id
            ? {
                ...g,
                name: modalGroupName,
                description: modalGroupDescription,
              }
            : g
        )
      )
    } else {
      // Create new group
      const newGroup: InternalGroup = {
        id: modalGroupId,
        name: modalGroupName,
        description: modalGroupDescription,
        members: [],
      }
      setGroups((prev) => [...prev, newGroup])
    }

    setIsDirty(true)
    setIsModalOpen(false)
    setError(null)
  }

  const handleAddMember = (groupId: CanopyGroupId, userId: CanopyUserId) => {
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id === groupId) {
          const members = g.members || []
          if (!members.includes(userId)) {
            return {
              ...g,
              members: [...members, userId],
            }
          }
        }
        return g
      })
    )
    setIsDirty(true)
    setUserSearchQuery('')
    setShowUserSearch(null)
    setUserSearchResults([])
    setUserSearchError(null)
  }

  const handleRemoveMember = (groupId: CanopyGroupId, userId: CanopyUserId) => {
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id === groupId) {
          const members = (g.members || []).filter((m) => m !== userId)
          return {
            ...g,
            members,
          }
        }
        return g
      })
    )
    setIsDirty(true)
  }

  const handleSave = async () => {
    if (!onSave) return

    setIsSaving(true)
    setError(null)
    try {
      await onSave(groups)
      setIsDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save groups')
    } finally {
      setIsSaving(false)
    }
  }

  const handleDiscard = () => {
    setGroups(initialInternalGroups)
    setIsDirty(false)
    setError(null)
  }

  if (!canEdit) {
    return (
      <Paper withBorder radius="md" shadow="sm" h="100%" style={{ display: 'flex', flexDirection: 'column' }}>
        <Group justify="space-between" px="md" py="sm">
          <div>
            <Title order={4}>Groups</Title>
            <Text size="xs" c="dimmed">
              View groups and organizations
            </Text>
          </div>
          {onClose && (
            <Button size="xs" variant="subtle" onClick={onClose}>
              Close
            </Button>
          )}
        </Group>

        <Alert icon={<IconAlertCircle size={16} />} color="yellow" mx="md" mb="sm" title="Read-only">
          You need admin access to manage groups.
        </Alert>

        <Tabs defaultValue="internal" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <Tabs.List px="md">
            <Tabs.Tab value="internal">Internal Groups</Tabs.Tab>
            <Tabs.Tab value="external">External Groups</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="internal" style={{ flex: 1, overflow: 'auto' }} px="md" pt="md">
            {groups.length === 0 ? (
              <Paper withBorder p="md" style={{ textAlign: 'center' }}>
                <IconUsers size={32} color="gray" style={{ margin: '0 auto', marginBottom: 8 }} />
                <Text size="sm" c="dimmed">
                  No internal groups
                </Text>
              </Paper>
            ) : (
              <Stack gap="xs" pb="md">
                {groups.map((group) => (
                  <Paper key={group.id} withBorder p="sm">
                    <Group justify="space-between">
                      <div>
                        <Text size="sm" fw={500}>
                          {group.name}
                        </Text>
                        {group.description && (
                          <Text size="xs" c="dimmed">
                            {group.description}
                          </Text>
                        )}
                      </div>
                      <Badge size="sm" variant="light">
                        {group.members?.length || 0} members
                      </Badge>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="external" style={{ flex: 1, overflow: 'auto' }} px="md" pt="md">
            <Text size="sm" c="dimmed" mb="md">
              External groups are read-only
            </Text>
          </Tabs.Panel>
        </Tabs>
      </Paper>
    )
  }

  return (
    <Paper withBorder radius="md" shadow="sm" h="100%" style={{ display: 'flex', flexDirection: 'column' }}>
      <Group justify="space-between" px="md" py="sm">
        <div>
          <Title order={4}>Groups</Title>
          <Text size="xs" c="dimmed">
            Manage groups and organizations
          </Text>
        </div>
        {onClose && (
          <Button size="xs" variant="subtle" onClick={onClose}>
            Close
          </Button>
        )}
      </Group>

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

      {loading ? (
        <Group justify="center" py="xl">
          <Loader size="md" />
          <Text size="sm" c="dimmed">
            Loading groups...
          </Text>
        </Group>
      ) : (
        <Tabs defaultValue="internal" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <Tabs.List px="md">
            <Tabs.Tab value="internal">Internal Groups</Tabs.Tab>
            <Tabs.Tab value="external">External Groups</Tabs.Tab>
          </Tabs.List>

          {/* Internal Groups Tab */}
          <Tabs.Panel value="internal" style={{ flex: 1, overflow: 'auto' }}>
            <ScrollArea style={{ height: '100%' }} px="md" pt="md">
              <Stack gap="sm" pb="md">
                <Group justify="space-between" mb="xs">
                  <Text size="sm" fw={500} c="dimmed">
                    Manage your internal groups
                  </Text>
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconPlus size={14} />}
                    onClick={handleCreateGroup}
                  >
                    Create Group
                  </Button>
                </Group>

                {groups.length === 0 ? (
                  <Paper withBorder p="md" style={{ textAlign: 'center' }}>
                    <IconUsers size={32} color="gray" style={{ margin: '0 auto', marginBottom: 8 }} />
                    <Text size="sm" c="dimmed">
                      No internal groups yet. Create one to get started.
                    </Text>
                  </Paper>
                ) : (
                  groups.map((group) => (
                    <Paper key={group.id} withBorder p="sm" mb="xs">
                      <Group justify="space-between" mb="sm">
                        <div style={{ flex: 1 }}>
                          <Group gap="xs">
                            <Text size="sm" fw={500}>
                              {group.name}
                            </Text>
                            <Badge size="sm" variant="light">
                              {group.members?.length || 0} members
                            </Badge>
                          </Group>
                          <Text size="xs" c="dimmed" mt={4}>
                            ID: {group.id}
                          </Text>
                          {group.description && (
                            <Text size="xs" c="dimmed" mt={4}>
                              {group.description}
                            </Text>
                          )}
                        </div>
                        <Group gap="xs">
                          <Tooltip label="Edit group">
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              onClick={() => handleEditGroup(group)}
                            >
                              <IconEdit size={16} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Delete group">
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              color="red"
                              onClick={() => handleDeleteGroup(group.id)}
                            >
                              <IconTrash size={16} />
                            </ActionIcon>
                          </Tooltip>
                        </Group>
                      </Group>

                      {/* Members */}
                      <div>
                        <Text size="xs" fw={500} mb={4}>
                          Members
                        </Text>
                        <Group gap="xs" mb="xs">
                          {group.members && group.members.length > 0 ? (
                            group.members.map((userId) => (
                              <Badge
                                key={userId}
                                variant="filled"
                                color="blue"
                                pr={3}
                                rightSection={
                                  <ActionIcon
                                    size="xs"
                                    color="blue"
                                    radius="xl"
                                    variant="transparent"
                                    onClick={() => handleRemoveMember(group.id, userId)}
                                  >
                                    <IconX size={10} style={{ color: 'white' }} />
                                  </ActionIcon>
                                }
                              >
                                {userId}
                              </Badge>
                            ))
                          ) : (
                            <Text size="xs" c="dimmed">
                              No members
                            </Text>
                          )}
                        </Group>

                        {/* Add member button */}
                        {showUserSearch === group.id ? (
                          <Paper withBorder p="sm" mt="xs">
                            <Stack gap="xs">
                              <TextInput
                                placeholder="Search users by name or email..."
                                value={userSearchQuery}
                                onChange={(e) => setUserSearchQuery(e.target.value)}
                                aria-label="Search users by name or email"
                                size="xs"
                              />
                              {isSearchingUsers && <Loader size="xs" />}
                              {userSearchError && <Text size="xs" c="red">{userSearchError}</Text>}
                              {userSearchResults.length > 0 && (
                                <Stack gap={4}>
                                  {userSearchResults.map((user) => (
                                    <Paper
                                      key={user.id}
                                      p="xs"
                                      withBorder
                                      style={{ cursor: 'pointer' }}
                                      onClick={() => handleAddMember(group.id, user.id)}
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
                              {userSearchQuery.trim() && !isSearchingUsers && userSearchResults.length === 0 && (
                                <Text size="xs" c="dimmed">
                                  No users found
                                </Text>
                              )}
                              <Button
                                size="xs"
                                variant="subtle"
                                onClick={() => {
                                  setShowUserSearch(null)
                                  setUserSearchQuery('')
                                  setUserSearchResults([])
                                  setUserSearchError(null)
                                }}
                              >
                                Cancel
                              </Button>
                            </Stack>
                          </Paper>
                        ) : (
                          <Button
                            size="xs"
                            variant="subtle"
                            leftSection={<IconSearch size={14} />}
                            onClick={() => setShowUserSearch(group.id)}
                            disabled={!onSearchUsers}
                          >
                            Add Member
                          </Button>
                        )}
                      </div>
                    </Paper>
                  ))
                )}
              </Stack>
            </ScrollArea>
          </Tabs.Panel>

          {/* External Groups Tab */}
          <Tabs.Panel value="external" style={{ flex: 1, overflow: 'auto' }}>
            <ScrollArea style={{ height: '100%' }} px="md" pt="md">
              <Stack gap="sm" pb="md">
                <Text size="sm" c="dimmed" mb="xs">
                  Search for external groups from your organization
                </Text>

                <TextInput
                  placeholder="Search external groups..."
                  value={externalGroupSearchQuery}
                  onChange={(e) => setExternalGroupSearchQuery(e.target.value)}
                  leftSection={<IconSearch size={16} />}
                  disabled={!onSearchExternalGroups}
                />

                {!onSearchExternalGroups && (
                  <Alert icon={<IconAlertCircle size={16} />} color="gray" title="Not Available">
                    External group search is not configured
                  </Alert>
                )}

                {isSearchingExternal && (
                  <Group justify="center" py="md">
                    <Loader size="sm" />
                    <Text size="sm" c="dimmed">
                      Searching...
                    </Text>
                  </Group>
                )}

                {externalSearchError && (
                  <Alert icon={<IconAlertCircle size={16} />} color="red" title="Error">
                    {externalSearchError}
                  </Alert>
                )}

                {externalGroupResults.length > 0 && (
                  <Stack gap="xs">
                    {externalGroupResults.map((group) => (
                      <Paper key={group.id} withBorder p="xs">
                        <Group justify="space-between" wrap="nowrap">
                          <Group gap="xs" style={{ flex: 1, minWidth: 0 }}>
                            <IconBuilding size={16} color="gray" style={{ flexShrink: 0 }} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <Text size="sm" fw={500} truncate>
                                {group.name}
                              </Text>
                              <Text size="xs" c="dimmed" truncate>
                                ID: {group.id}
                              </Text>
                            </div>
                          </Group>
                        </Group>
                      </Paper>
                    ))}
                  </Stack>
                )}

                {externalGroupSearchQuery.trim() &&
                  !isSearchingExternal &&
                  externalGroupResults.length === 0 &&
                  !externalSearchError && (
                    <Text size="sm" c="dimmed" ta="center" py="md">
                      No external groups found
                    </Text>
                  )}
              </Stack>
            </ScrollArea>
          </Tabs.Panel>
        </Tabs>
      )}

      {canEdit && isDirty && (
        <Group justify="flex-end" px="md" py="sm" gap="sm" style={{ borderTop: '1px solid var(--mantine-color-gray-3)' }}>
          <Button variant="subtle" color="neutral" onClick={handleDiscard} disabled={isSaving}>
            Discard Changes
          </Button>
          <Button onClick={handleSave} loading={isSaving} disabled={isSaving}>
            Save Groups
          </Button>
        </Group>
      )}

      {/* Create/Edit Modal */}
      <Modal
        opened={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingGroup ? 'Edit Group' : 'Create Group'}
      >
        <Stack gap="md">
          <TextInput
            label="Group ID"
            placeholder="e.g., content-editors"
            value={modalGroupId}
            onChange={(e) => setModalGroupId(e.target.value)}
            disabled={!!editingGroup}
            required
          />
          <TextInput
            label="Group Name"
            placeholder="e.g., Content Editors"
            value={modalGroupName}
            onChange={(e) => setModalGroupName(e.target.value)}
            required
          />
          <Textarea
            label="Description"
            placeholder="Optional description"
            value={modalGroupDescription}
            onChange={(e) => setModalGroupDescription(e.target.value)}
            rows={3}
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="subtle" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveModal}>{editingGroup ? 'Save' : 'Create'}</Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  )
}
