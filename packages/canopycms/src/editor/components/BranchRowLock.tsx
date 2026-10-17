'use client'

import React from 'react'
import { ActionIcon, Tooltip } from '@mantine/core'
import { IconLock } from '@tabler/icons-react'

/**
 * The lock a navigator row shows in the slot its "…" menu would fill, on a branch that takes no
 * writes. It matches the menu button's footprint so rows do not shift between branches. It stays
 * `aria-disabled` rather than `disabled`, so its reason opens on keyboard focus and touch too.
 */
export const BranchRowLock: React.FC<{ reason: string }> = ({ reason }) => (
  <Tooltip
    label={reason}
    withinPortal
    position="bottom-end"
    multiline
    w={240}
    events={{ hover: true, focus: true, touch: true }}
  >
    <ActionIcon
      size="xs"
      variant="subtle"
      color="gray"
      data-disabled
      aria-disabled
      aria-label={reason}
      data-testid="branch-lock"
      onClick={(event) => event.stopPropagation()}
    >
      <IconLock size={14} aria-hidden />
    </ActionIcon>
  </Tooltip>
)
