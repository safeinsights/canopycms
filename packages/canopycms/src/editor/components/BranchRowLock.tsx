'use client'

import React, { useId } from 'react'
import { ActionIcon, Tooltip, VisuallyHidden } from '@mantine/core'
import { IconLock } from '@tabler/icons-react'

/**
 * The lock a navigator row shows in the slot its "…" menu would fill, on a branch that takes no
 * writes. It matches the menu button's footprint so rows do not shift between branches, and takes
 * the menu's name; the reason is its Tooltip and its description. It stays `aria-disabled` rather
 * than `disabled`, so the reason opens on keyboard focus and touch too. Space is stopped here: the
 * tree would read it as expand/collapse.
 */
export const BranchRowLock: React.FC<{ label: string; reason: string }> = ({ label, reason }) => {
  const reasonId = useId()
  return (
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
        variant="transparent"
        c="dimmed"
        aria-disabled
        aria-label={label}
        aria-describedby={reasonId}
        data-testid="branch-lock"
        style={{ cursor: 'default' }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.nativeEvent.code === 'Space') event.stopPropagation()
        }}
      >
        <IconLock size={14} aria-hidden />
        <VisuallyHidden component="span" id={reasonId}>
          {reason}
        </VisuallyHidden>
      </ActionIcon>
    </Tooltip>
  )
}
