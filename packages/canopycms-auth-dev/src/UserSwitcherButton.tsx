'use client'

import { useState, useSyncExternalStore } from 'react'
import { ActionIcon, Avatar } from '@mantine/core'
import { UserSwitcherModal } from './UserSwitcherModal'
import { DEFAULT_USERS } from './dev-defaults'
import { getDevUserCookie, DEFAULT_USER_ID } from './cookie-utils'

const noop = () => () => {}
const getSnapshot = () => getDevUserCookie() ?? DEFAULT_USER_ID
const getServerSnapshot = () => DEFAULT_USER_ID

/**
 * User switcher button component that shows current user avatar and opens modal
 */
export function UserSwitcherButton() {
  const [opened, setOpened] = useState(false)
  const currentUserId = useSyncExternalStore(noop, getSnapshot, getServerSnapshot)

  const currentUser = DEFAULT_USERS.find((u) => u.userId === currentUserId)

  return (
    <>
      <ActionIcon
        variant="subtle"
        size="lg"
        radius="md"
        onClick={() => setOpened(true)}
        aria-label="Switch user"
      >
        <Avatar size="sm" color="blue">
          {currentUser?.name[0] ?? 'U'}
        </Avatar>
      </ActionIcon>

      <UserSwitcherModal
        opened={opened}
        onClose={() => setOpened(false)}
        currentUserId={currentUserId}
      />
    </>
  )
}
