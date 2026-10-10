'use client'

import { Modal, Stack, Button } from '@mantine/core'
import { IconLogout } from '@tabler/icons-react'
import { setDevUserCookie, setDevSignedOutCookie } from './cookie-utils'
import { DevUserList } from './DevUserList'

interface Props {
  opened: boolean
  onClose: () => void
  currentUserId: string
}

export function UserSwitcherModal({ opened, onClose, currentUserId }: Props) {
  const switchUser = (userId: string) => {
    setDevUserCookie(userId)
    window.location.reload()
  }

  const signOut = () => {
    setDevSignedOutCookie()
    window.location.reload()
  }

  return (
    <Modal opened={opened} onClose={onClose} title="Switch Development User">
      <Stack gap="md">
        <DevUserList onSelect={switchUser} currentUserId={currentUserId} />
        <Button variant="subtle" size="sm" leftSection={<IconLogout size={16} />} onClick={signOut}>
          Sign out
        </Button>
      </Stack>
    </Modal>
  )
}
