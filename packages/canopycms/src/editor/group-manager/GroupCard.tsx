'use client'

import React from 'react'
import { ActionIcon, Badge, Group, Paper, Text, Tooltip } from '@mantine/core'
import { IconEdit, IconTrash } from '@tabler/icons-react'
import type { InternalGroup, UserSearchResult, CanopyGroupId, CanopyUserId } from './types'
import { MemberList } from './MemberList'
import { isReservedGroup } from '../../authorization/helpers'

export const memberCountLabel = (count: number): string =>
  `${count} ${count === 1 ? 'member' : 'members'}`

const reservedDeleteReason = (name: string): string =>
  `"${name}" is a built-in group, so it can't be deleted.`

export interface GroupCardProps {
  group: InternalGroup
  /** The group is new or edited and its change is staged, not saved. */
  isUnsaved: boolean
  onEdit: (group: InternalGroup) => void
  onDelete: (groupId: CanopyGroupId) => void
  onAddMember: (groupId: CanopyGroupId, userId: CanopyUserId) => void
  onRemoveMember: (groupId: CanopyGroupId, userId: CanopyUserId) => void
  onGetUserMetadata: (userId: string) => Promise<UserSearchResult | null>
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
  isUnsaved,
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
  const reserved = isReservedGroup(group.id)
  return (
    <Paper withBorder p="sm" mb="xs">
      <Group justify="space-between" mb="sm">
        <div style={{ flex: 1 }}>
          <Group gap="xs">
            <Text size="sm" fw={500}>
              {group.name}
            </Text>
            <Badge size="sm" variant="light">
              {memberCountLabel(group.members?.length ?? 0)}
            </Badge>
            {isUnsaved && (
              <Badge size="sm" variant="light" color="orange">
                Unsaved
              </Badge>
            )}
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
          <Tooltip label={`Edit group "${group.name}"`}>
            <ActionIcon
              variant="subtle"
              aria-label={`Edit group "${group.name}"`}
              onClick={() => onEdit(group)}
            >
              <IconEdit size={16} />
            </ActionIcon>
          </Tooltip>
          <Tooltip
            label={reserved ? reservedDeleteReason(group.name) : `Delete group "${group.name}"`}
            events={{ hover: true, focus: true, touch: true }}
          >
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label={`Delete group "${group.name}"`}
              data-disabled={reserved ? true : undefined}
              aria-disabled={reserved ? true : undefined}
              onClick={() => {
                if (!reserved) onDelete(group.id)
              }}
            >
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
