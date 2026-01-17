'use client'

/**
 * External groups tab component
 */

import React from 'react'
import { Alert, Group, Loader, Paper, ScrollArea, Stack, Text, TextInput } from '@mantine/core'
import { IconAlertCircle, IconBuilding, IconSearch } from '@tabler/icons-react'
import type { ExternalGroup } from './types'

export interface ExternalGroupsTabProps {
  canEdit: boolean
  searchQuery: string
  searchResults: ExternalGroup[]
  isSearching: boolean
  searchError: string | null
  onSearchQueryChange: (query: string) => void
  canSearch: boolean
}

export const ExternalGroupsTab: React.FC<ExternalGroupsTabProps> = ({
  canEdit,
  searchQuery,
  searchResults,
  isSearching,
  searchError,
  onSearchQueryChange,
  canSearch,
}) => {
  // Read-only view (when !canEdit)
  if (!canEdit) {
    return (
      <div style={{ flex: 1, overflow: 'auto', paddingTop: 'var(--mantine-spacing-md)' }}>
        <Text size="sm" c="dimmed" mb="md">
          External groups are read-only
        </Text>
      </div>
    )
  }

  return (
    <ScrollArea style={{ height: '100%' }} pt="md">
      <Stack gap="sm" pb="md">
        <Text size="sm" c="dimmed" mb="xs">
          Search for external groups from your organization
        </Text>

        <TextInput
          placeholder="Search external groups..."
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          leftSection={<IconSearch size={16} />}
          disabled={!canSearch}
        />

        {!canSearch && (
          <Alert icon={<IconAlertCircle size={16} />} color="gray" title="Not Available">
            External group search is not configured
          </Alert>
        )}

        {isSearching && (
          <Group justify="center" py="md">
            <Loader size="sm" />
            <Text size="sm" c="dimmed">
              Searching...
            </Text>
          </Group>
        )}

        {searchError && (
          <Alert icon={<IconAlertCircle size={16} />} color="red" title="Error">
            {searchError}
          </Alert>
        )}

        {searchResults.length > 0 && (
          <Stack gap="xs">
            {searchResults.map((group) => (
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

        {searchQuery.trim() && !isSearching && searchResults.length === 0 && !searchError && (
          <Text size="sm" c="dimmed" ta="center" py="md">
            No external groups found
          </Text>
        )}
      </Stack>
    </ScrollArea>
  )
}
