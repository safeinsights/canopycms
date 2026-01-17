'use client'

/**
 * Card component for displaying a single group with its members
 */

import React from 'react'
import { ActionIcon, Badge, Group, Paper, Text, Tooltip } from '@mantine/core'
import { IconEdit, IconTrash } from '@tabler/icons-react'
import type { InternalGroup, UserSearchResult, CanopyGroupId, CanopyUserId } from './types'
import { MemberList } from './MemberList'

export interface GroupCardProps {
  group: InternalGroup
  onEdit: (group: InternalGroup) => void
  onDelete: (groupId: CanopyGroupId) => void
  onAddMember: (groupId: CanopyGroupId, userId: CanopyUserId) => void
  onRemoveMember: (groupId: CanopyGroupId, userId: CanopyUserId) => void
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  // User search state
  showUserSearch: boolean
  searchQuery: string
  searchResults: UserSearchResult[]
  isSearching: boolean
  searchError: string | null
  onSearchQueryChange: (query: string) => void
  onShowSearch: () => void
  onHideSearch: () => void
  canSearch: boolean
}

export const GroupCard: React.FC<GroupCardProps> = ({
  group,
  onEdit,
  onDelete,
  onAddMember,
  onRemoveMember,
  onGetUserMetadata,
  showUserSearch,
  searchQuery,
  searchResults,
  isSearching,
  searchError,
  onSearchQueryChange,
  onShowSearch,
  onHideSearch,
  canSearch,
}) => {
  return (
    <Paper withBorder p="sm" mb="xs">
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
            <ActionIcon size="sm" variant="subtle" onClick={() => onEdit(group)}>
              <IconEdit size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Delete group">
            <ActionIcon size="sm" variant="subtle" color="red" onClick={() => onDelete(group.id)}>
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      <MemberList
        groupId={group.id}
        members={group.members || []}
        onRemoveMember={onRemoveMember}
        onAddMember={onAddMember}
        onGetUserMetadata={onGetUserMetadata}
        showUserSearch={showUserSearch}
        searchQuery={searchQuery}
        searchResults={searchResults}
        isSearching={isSearching}
        searchError={searchError}
        onSearchQueryChange={onSearchQueryChange}
        onShowSearch={onShowSearch}
        onHideSearch={onHideSearch}
        canSearch={canSearch}
      />
    </Paper>
  )
}
