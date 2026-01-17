'use client'

/**
 * Member list component with user search for adding members
 */

import React from 'react'
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core'
import { IconSearch, IconX } from '@tabler/icons-react'
import type { UserSearchResult, CanopyGroupId, CanopyUserId } from './types'
import { UserBadge } from '../components/UserBadge'

export interface MemberListProps {
  groupId: CanopyGroupId
  members: CanopyUserId[]
  onRemoveMember: (groupId: CanopyGroupId, userId: CanopyUserId) => void
  onAddMember: (groupId: CanopyGroupId, userId: CanopyUserId) => void
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
  const handleAddMember = (userId: CanopyUserId) => {
    onAddMember(groupId, userId)
    onHideSearch()
  }

  return (
    <div>
      <Text size="xs" fw={500} mb={4}>
        Members
      </Text>
      <Group gap="xs" mb="xs">
        {members.length > 0 ? (
          members.map((userId) =>
            onGetUserMetadata ? (
              <UserBadge
                key={userId}
                userId={userId}
                getUserMetadata={onGetUserMetadata}
                variant="avatar-name"
                size="xs"
                badgeVariant="filled"
                color="blue"
                onRemove={() => onRemoveMember(groupId, userId)}
                showEmailTooltip={true}
              />
            ) : (
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
                    onClick={() => onRemoveMember(groupId, userId)}
                  >
                    <IconX size={10} style={{ color: 'white' }} />
                  </ActionIcon>
                }
              >
                {userId}
              </Badge>
            ),
          )
        ) : (
          <Text size="xs" c="dimmed">
            No members
          </Text>
        )}
      </Group>

      {/* Add member search panel */}
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
              <Text size="xs" c="red">
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
                        <Text size="sm" fw={500}>
                          {user.name}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {user.email}
                        </Text>
                      </>
                    )}
                  </Paper>
                ))}
              </Stack>
            )}
            {searchQuery.trim() && !isSearching && searchResults.length === 0 && (
              <Text size="xs" c="dimmed">
                No users found
              </Text>
            )}
            <Button size="xs" variant="subtle" onClick={onHideSearch}>
              Cancel
            </Button>
          </Stack>
        </Paper>
      ) : (
        <Button
          size="xs"
          variant="subtle"
          leftSection={<IconSearch size={14} />}
          onClick={onShowSearch}
          disabled={!canSearch}
        >
          Add Member
        </Button>
      )}
    </div>
  )
}
