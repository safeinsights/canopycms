'use client'

/**
 * Internal groups tab component
 */

import React from 'react'
import { Button, Group, Paper, ScrollArea, Stack, Text } from '@mantine/core'
import { IconPlus, IconUsers } from '@tabler/icons-react'
import type { InternalGroup, UserSearchResult, CanopyGroupId, CanopyUserId } from './types'
import { GroupCard } from './GroupCard'

export interface InternalGroupsTabProps {
  groups: InternalGroup[]
  canEdit: boolean
  onCreateGroup: () => void
  onEditGroup: (group: InternalGroup) => void
  onDeleteGroup: (groupId: CanopyGroupId) => void
  onAddMember: (groupId: CanopyGroupId, userId: CanopyUserId) => void
  onRemoveMember: (groupId: CanopyGroupId, userId: CanopyUserId) => void
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  // User search state (shared across all groups)
  activeSearchGroupId: string | null
  searchQuery: string
  searchResults: UserSearchResult[]
  isSearching: boolean
  searchError: string | null
  onSearchQueryChange: (query: string) => void
  onShowSearch: (groupId: string) => void
  onHideSearch: () => void
  canSearch: boolean
}

export const InternalGroupsTab: React.FC<InternalGroupsTabProps> = ({
  groups,
  canEdit,
  onCreateGroup,
  onEditGroup,
  onDeleteGroup,
  onAddMember,
  onRemoveMember,
  onGetUserMetadata,
  activeSearchGroupId,
  searchQuery,
  searchResults,
  isSearching,
  searchError,
  onSearchQueryChange,
  onShowSearch,
  onHideSearch,
  canSearch,
}) => {
  // Read-only view
  if (!canEdit) {
    return (
      <div style={{ flex: 1, overflow: 'auto', paddingTop: 'var(--mantine-spacing-md)' }}>
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
                  <Text size="sm" variant="light">
                    {group.members?.length || 0} members
                  </Text>
                </Group>
              </Paper>
            ))}
          </Stack>
        )}
      </div>
    )
  }

  // Editable view
  return (
    <ScrollArea style={{ height: '100%' }} pt="md">
      <Stack gap="sm" pb="md">
        <Group justify="space-between" mb="xs">
          <Text size="sm" fw={500} c="dimmed">
            Manage your internal groups
          </Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={onCreateGroup}
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
            <GroupCard
              key={group.id}
              group={group}
              onEdit={onEditGroup}
              onDelete={onDeleteGroup}
              onAddMember={onAddMember}
              onRemoveMember={onRemoveMember}
              onGetUserMetadata={onGetUserMetadata}
              showUserSearch={activeSearchGroupId === group.id}
              searchQuery={searchQuery}
              searchResults={searchResults}
              isSearching={isSearching}
              searchError={searchError}
              onSearchQueryChange={onSearchQueryChange}
              onShowSearch={() => onShowSearch(group.id)}
              onHideSearch={onHideSearch}
              canSearch={canSearch}
            />
          ))
        )}
      </Stack>
    </ScrollArea>
  )
}
