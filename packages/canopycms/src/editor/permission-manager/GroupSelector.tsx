'use client'

/**
 * Group search and selection component
 */

import React from 'react'
import { Paper, Stack, Text } from '@mantine/core'
import type { GroupSelectItem } from './types'

export interface GroupSelectorProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  filteredGroups: GroupSelectItem[]
  onSelectGroup: (groupId: string) => void
}

export const GroupSelector: React.FC<GroupSelectorProps> = ({
  searchQuery,
  onSearchChange,
  filteredGroups,
  onSelectGroup,
}) => {
  return (
    <Paper withBorder p="xs" mt="xs" style={{ maxWidth: 300 }}>
      <Stack gap="xs">
        <input
          type="text"
          placeholder="Search groups..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
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
                onClick={() => onSelectGroup(group.value)}
              >
                {group.label}
              </div>
            ))}
          </div>
        )}
        {searchQuery.trim() && filteredGroups.length === 0 && (
          <Text size="xs" c="dimmed">
            No groups found
          </Text>
        )}
      </Stack>
    </Paper>
  )
}
