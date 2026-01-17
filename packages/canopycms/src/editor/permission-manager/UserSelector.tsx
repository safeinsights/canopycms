'use client'

/**
 * User search and selection component
 */

import React from 'react'
import { Paper, Stack, Text, Loader } from '@mantine/core'
import type { UserSearchResult } from './types'
import { UserBadge } from '../components/UserBadge'

export interface UserSelectorProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  searchResults: UserSearchResult[]
  isSearching: boolean
  searchError: string | null
  onSelectUser: (userId: string) => void
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
}

export const UserSelector: React.FC<UserSelectorProps> = ({
  searchQuery,
  onSearchChange,
  searchResults,
  isSearching,
  searchError,
  onSelectUser,
  onGetUserMetadata,
}) => {
  return (
    <Paper withBorder p="sm" mt="xs">
      <Stack gap="xs">
        <input
          type="text"
          placeholder="Search users by name or email..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          aria-label="Search users by name or email"
          style={{
            width: '100%',
            padding: '6px 8px',
            border: '1px solid var(--mantine-color-gray-4)',
            borderRadius: 'var(--mantine-radius-sm)',
            fontSize: '14px',
          }}
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
                onClick={() => onSelectUser(user.id)}
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
      </Stack>
    </Paper>
  )
}
