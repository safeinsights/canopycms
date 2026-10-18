'use client'

import React, { type ReactNode } from 'react'
import { Box, Group } from '@mantine/core'
import { SHELL_REGION_BORDER } from './EditorShell'

const TOP_BAR_HEIGHT = 48

export interface TopBarProps {
  /** The branch, at the bar's inline start. */
  leading: ReactNode
  /** The actions on the branch, at its inline end. */
  trailing: ReactNode
}

/**
 * The shell's top bar, the branch bar: one 48px row while both sides fit. Narrower, `trailing`
 * controls that don't fit beside the branch wrap to a second row at the inline end. Layout only.
 */
export function TopBar({ leading, trailing }: TopBarProps) {
  return (
    <Group
      gap="xs"
      wrap="wrap"
      align="center"
      px="sm"
      py={6}
      mih={TOP_BAR_HEIGHT}
      style={{
        borderBottom: SHELL_REGION_BORDER,
        background: 'var(--mantine-color-body)',
      }}
    >
      <Box flex="0 1 auto" miw={0}>
        {leading}
      </Box>
      <Group
        gap={6}
        wrap="wrap"
        align="center"
        justify="flex-end"
        // It takes the row's rest beside the pill, so only the controls that don't fit there wrap,
        // still at the end.
        flex="1 1 0%"
        miw={0}
      >
        {trailing}
      </Group>
    </Group>
  )
}
