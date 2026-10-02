'use client'

import { Stack, Paper, Group, Avatar, Text, Badge } from '@mantine/core'
import { IconCheck } from '@tabler/icons-react'
import { DEFAULT_USERS } from './dev-defaults'

interface Props {
  onSelect: (userId: string) => void
  /** Marked with a check. */
  currentUserId?: string
}

/** The selectable dev users. Lists DEFAULT_USERS, not a plugin's custom `users`. */
export function DevUserList({ onSelect, currentUserId }: Props) {
  return (
    <Stack gap="sm">
      {DEFAULT_USERS.map((user) => (
        <Paper
          key={user.userId}
          p="md"
          withBorder
          style={{ cursor: 'pointer' }}
          onClick={() => onSelect(user.userId)}
          data-testid={`dev-user-${user.userId}`}
        >
          <Group justify="space-between" mb="xs">
            <Group>
              <Avatar color="blue">{user.name[0]}</Avatar>
              <div>
                <Text fw={500}>{user.name}</Text>
                <Text size="sm" c="dimmed">
                  {user.email}
                </Text>
              </div>
            </Group>
            {user.userId === currentUserId && <IconCheck size={20} />}
          </Group>

          {user.externalGroups.length > 0 && (
            <Group gap="xs">
              {user.externalGroups.map((g) => (
                <Badge key={g} variant="outline" size="sm">
                  {g}
                </Badge>
              ))}
            </Group>
          )}
        </Paper>
      ))}
    </Stack>
  )
}
