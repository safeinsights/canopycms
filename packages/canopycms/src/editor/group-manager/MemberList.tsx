'use client'

import React, { useRef } from 'react'
import { Button, Group, Loader, Paper, Stack, Text, TextInput } from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import type { UserSearchResult, CanopyGroupId, CanopyUserId } from './types'
import { UserBadge } from '../components/UserBadge'
import { useFocusAfterRemove } from '../utils/focus-return'

export interface MemberListProps {
  groupId: CanopyGroupId
  members: CanopyUserId[]
  onRemoveMember: (groupId: CanopyGroupId, userId: CanopyUserId) => void
  onAddMember: (groupId: CanopyGroupId, userId: CanopyUserId) => void
  /** Names each member; an id never shows as the label, since an unresolved one reads "Name unavailable". */
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

export const MemberList: React.FC<MemberListProps> = ({
  groupId,
  members,
  onRemoveMember,
  onAddMember,
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
  const { listRef, focusAfterRemove } = useFocusAfterRemove()
  const addMemberRef = useRef<HTMLButtonElement>(null)

  const handleAddMember = (userId: CanopyUserId) => {
    onAddMember(groupId, userId)
    onHideSearch()
  }

  return (
    <div>
      <Text size="xs" fw={500} mb={4}>
        Members
      </Text>
      <Group gap="xs" mb="xs" ref={listRef}>
        {members.length > 0 ? (
          members.map((userId, index) => (
            <UserBadge
              key={userId}
              userId={userId}
              getUserMetadata={onGetUserMetadata}
              variant="avatar-name"
              size="xs"
              badgeVariant="light"
              color="blue"
              onRemove={() => {
                onRemoveMember(groupId, userId)
                focusAfterRemove(index, addMemberRef)
              }}
              showEmailTooltip={true}
              revealIdOnFallback
            />
          ))
        ) : (
          <Text size="xs" c="dimmed">
            No members
          </Text>
        )}
      </Group>

      {showUserSearch ? (
        <Paper withBorder p="sm" mt="xs">
          <Stack gap="xs">
            <TextInput
              placeholder="Search users by name or email..."
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              aria-label="Search users by name or email"
              size="xs"
            />
            {isSearching && <Loader size="xs" />}
            {searchError && (
              <Text size="xs" c="var(--canopy-danger-text)">
                {searchError}
              </Text>
            )}
            {searchResults.length > 0 && (
              <Stack gap={4}>
                {searchResults.map((user) => (
                  <Paper
                    key={user.id}
                    p="xs"
                    withBorder
                    style={{ cursor: 'pointer' }}
                    onClick={() => handleAddMember(user.id)}
                  >
                    <UserBadge
                      userId={user.id}
                      getUserMetadata={onGetUserMetadata}
                      variant="full"
                      size="sm"
                      cachedUser={user}
                      showEmailTooltip={false}
                    />
                  </Paper>
                ))}
              </Stack>
            )}
            {searchQuery.trim() && !isSearching && searchResults.length === 0 && (
              <Text size="xs" c="dimmed">
                No users found
              </Text>
            )}
            <Button variant="subtle" onClick={onHideSearch}>
              Cancel
            </Button>
          </Stack>
        </Paper>
      ) : (
        <Button
          ref={addMemberRef}
          variant="subtle"
          leftSection={<IconSearch size={14} />}
          onClick={onShowSearch}
          disabled={!canSearch}
        >
          Add member
        </Button>
      )}
    </div>
  )
}
