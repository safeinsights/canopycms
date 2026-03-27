'use client'

import { Modal, Stack, Paper, Group, Avatar, Text, Badge } from '@mantine/core'
import { MdCheck } from 'react-icons/md'
import { DEFAULT_USERS } from './dev-defaults'
import { setDevUserCookie } from './cookie-utils'

interface Props {
  opened: boolean
  onClose: () => void
  currentUserId: string
}

/**
 * User switcher modal component that displays all available dev users
 */
export function UserSwitcherModal({ opened, onClose, currentUserId }: Props) {
  const switchUser = (userId: string) => {
    // Set cookie for 7 days
    setDevUserCookie(userId)
    // Reload to apply new user
    window.location.reload()
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Switch Development User">
      <Stack gap="sm">
        {DEFAULT_USERS.map((user) => (
          <Paper
            key={user.userId}
            p="md"
            withBorder
            style={{ cursor: 'pointer' }}
            onClick={() => switchUser(user.userId)}
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
              {user.userId === currentUserId && <MdCheck size={20} />}
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
    </Modal>
  )
}
