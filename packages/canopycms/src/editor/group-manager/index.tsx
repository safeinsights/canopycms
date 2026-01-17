'use client'

/**
 * GroupManager - Main component for managing internal and external groups.
 *
 * This component provides a tabbed UI for managing internal groups with
 * member assignment, and browsing external groups from the organization.
 */

import React, { useState, useCallback } from 'react'
import { Alert, Button, Group, Loader, Stack, Tabs, Text } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'
import type { GroupManagerProps, InternalGroup, GroupFormData } from './types'
import { useGroupState } from './hooks/useGroupState'
import { useUserSearch } from './hooks/useUserSearch'
import { useExternalGroupSearch } from './hooks/useExternalGroupSearch'
import { InternalGroupsTab } from './InternalGroupsTab'
import { ExternalGroupsTab } from './ExternalGroupsTab'
import { GroupForm } from './GroupForm'

export const GroupManager: React.FC<GroupManagerProps> = ({
  internalGroups: initialInternalGroups,
  loading = false,
  canEdit,
  onSave,
  onSearchUsers,
  onGetUserMetadata,
  onSearchExternalGroups,
  onClose,
}) => {
  // Group state management
  const {
    groups,
    isDirty,
    isSaving,
    error,
    setError,
    createGroup,
    updateGroup,
    deleteGroup,
    addMember,
    removeMember,
    save,
    discard,
  } = useGroupState({
    initialGroups: initialInternalGroups,
    onSave,
  })

  // User search for adding members
  const userSearch = useUserSearch({ onSearchUsers })

  // External group search
  const externalGroupSearch = useExternalGroupSearch({ onSearchExternalGroups })

  // Modal state for creating/editing groups
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingGroup, setEditingGroup] = useState<InternalGroup | null>(null)
  const [formData, setFormData] = useState<GroupFormData>({ name: '', description: '' })

  const handleCreateGroup = useCallback(() => {
    setEditingGroup(null)
    setFormData({ name: '', description: '' })
    setIsModalOpen(true)
  }, [])

  const handleEditGroup = useCallback((group: InternalGroup) => {
    setEditingGroup(group)
    setFormData({ name: group.name, description: group.description || '' })
    setIsModalOpen(true)
  }, [])

  const handleSaveModal = useCallback(() => {
    if (!formData.name.trim()) {
      setError('Group name is required')
      return
    }

    if (editingGroup) {
      updateGroup(editingGroup.id, formData.name, formData.description)
    } else {
      createGroup(formData.name, formData.description)
    }

    setIsModalOpen(false)
    setError(null)
  }, [formData, editingGroup, updateGroup, createGroup, setError])

  const handleFormChange = useCallback((data: Partial<GroupFormData>) => {
    setFormData((prev) => ({ ...prev, ...data }))
  }, [])

  const handleAddMember = useCallback(
    (groupId: string, userId: string) => {
      addMember(
        groupId as Parameters<typeof addMember>[0],
        userId as Parameters<typeof addMember>[1],
      )
      userSearch.hideSearch()
    },
    [addMember, userSearch],
  )

  return (
    <Stack h="100%" style={{ display: 'flex', flexDirection: 'column' }} gap={0}>
      {!canEdit && (
        <Alert icon={<IconAlertCircle size={16} />} color="yellow" mb="sm" title="Read-only">
          You need admin access to manage groups.
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

      {loading ? (
        <Group justify="center" py="xl">
          <Loader size="md" />
          <Text size="sm" c="dimmed">
            Loading groups...
          </Text>
        </Group>
      ) : (
        <Tabs defaultValue="internal" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <Tabs.List>
            <Tabs.Tab value="internal">Internal Groups</Tabs.Tab>
            <Tabs.Tab value="external">External Groups</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="internal" style={{ flex: 1, overflow: 'auto' }}>
            <InternalGroupsTab
              groups={groups}
              canEdit={canEdit}
              onCreateGroup={handleCreateGroup}
              onEditGroup={handleEditGroup}
              onDeleteGroup={deleteGroup}
              onAddMember={handleAddMember}
              onRemoveMember={removeMember}
              onGetUserMetadata={onGetUserMetadata}
              activeSearchGroupId={userSearch.activeGroupId}
              searchQuery={userSearch.searchQuery}
              searchResults={userSearch.searchResults}
              isSearching={userSearch.isSearching}
              searchError={userSearch.searchError}
              onSearchQueryChange={userSearch.setSearchQuery}
              onShowSearch={userSearch.showSearch}
              onHideSearch={userSearch.hideSearch}
              canSearch={!!onSearchUsers}
            />
          </Tabs.Panel>

          <Tabs.Panel value="external" style={{ flex: 1, overflow: 'auto' }}>
            <ExternalGroupsTab
              canEdit={canEdit}
              searchQuery={externalGroupSearch.searchQuery}
              searchResults={externalGroupSearch.searchResults}
              isSearching={externalGroupSearch.isSearching}
              searchError={externalGroupSearch.searchError}
              onSearchQueryChange={externalGroupSearch.setSearchQuery}
              canSearch={!!onSearchExternalGroups}
            />
          </Tabs.Panel>
        </Tabs>
      )}

      {canEdit && isDirty && (
        <Group
          justify="flex-end"
          py="sm"
          gap="sm"
          style={{ borderTop: '1px solid var(--mantine-color-gray-3)' }}
        >
          <Button variant="subtle" color="neutral" onClick={discard} disabled={isSaving}>
            Discard Changes
          </Button>
          <Button onClick={save} loading={isSaving} disabled={isSaving}>
            Save Groups
          </Button>
        </Group>
      )}

      <GroupForm
        isOpen={isModalOpen}
        editingGroup={editingGroup}
        formData={formData}
        onFormChange={handleFormChange}
        onSave={handleSaveModal}
        onClose={() => setIsModalOpen(false)}
      />
    </Stack>
  )
}

// Re-export types and hooks for external use
export type { GroupManagerProps, InternalGroup } from './types'
export { useGroupState } from './hooks/useGroupState'
export { useUserSearch } from './hooks/useUserSearch'
export { useExternalGroupSearch } from './hooks/useExternalGroupSearch'
