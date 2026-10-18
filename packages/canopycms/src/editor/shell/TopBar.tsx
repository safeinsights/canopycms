'use client'

import React, { type ReactNode } from 'react'
import { Box, Group } from '@mantine/core'
import { SHELL_REGION_BORDER } from './EditorShell'

const TOP_BAR_HEIGHT = 48

export interface TopBarProps {
  /** Where you are; absent, `trailing` takes the whole row. */
  leading?: ReactNode
  /** What you can do: the branch and the actions on it. */
  trailing: ReactNode
}

/**
 * The shell's top bar: one 48px row from `md` up. Narrower, any `leading` takes a row of its own
 * above `trailing`, which wraps rather than clip a control. Layout only.
 */
export function TopBar({ leading, trailing }: TopBarProps) {
  return (
    <Group
      gap="xs"
      wrap="wrap"
      align="center"
      justify="flex-end"
      px="sm"
      py={6}
      mih={TOP_BAR_HEIGHT}
      style={{
        borderBottom: SHELL_REGION_BORDER,
        background: 'var(--mantine-color-body)',
      }}
    >
      {leading !== undefined && (
        <Box flex={{ base: '1 0 100%', md: '1 1 0%' }} miw={0}>
          {leading}
        </Box>
      )}
      <Group
        gap={6}
        wrap="wrap"
        align="center"
        justify="flex-end"
        flex={{ base: '1 0 100%', md: '0 1 auto' }}
        miw={0}
      >
        {trailing}
      </Group>
    </Group>
  )
}
