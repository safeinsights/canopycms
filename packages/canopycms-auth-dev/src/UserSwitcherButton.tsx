'use client'

import { useState, useEffect } from 'react'
import { ActionIcon, Avatar } from '@mantine/core'
import { UserSwitcherModal } from './UserSwitcherModal'
import { DEFAULT_USERS } from './dev-plugin'
import { getDevUserCookie, DEFAULT_USER_ID } from './cookie-utils'

/**
 * User switcher button component that shows current user avatar and opens modal
 */
export function UserSwitcherButton() {
  const [opened, setOpened] = useState(false)
  const [mounted, setMounted] = useState(false)

  // Only read cookie after mount to avoid hydration mismatch
  useEffect(() => {
    setMounted(true)
  }, [])

  // Read current user from cookie (only on client)
  const currentUserId = mounted ? (getDevUserCookie() ?? DEFAULT_USER_ID) : DEFAULT_USER_ID
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
