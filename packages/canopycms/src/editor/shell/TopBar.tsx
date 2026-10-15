'use client'

import React, { type ReactNode } from 'react'
import { Box, Group } from '@mantine/core'

const TOP_BAR_HEIGHT = 48

export interface TopBarProps {
  /** Where you are: the breadcrumb and anything that describes the open entry. */
  leading: ReactNode
  /** What you can do: the branch and the actions on it. */
  trailing: ReactNode
}

/**
 * The shell's top bar: one 48px row from `md` up. Narrower, `leading` takes a row of its own
 * above `trailing`, so no control is ever clipped. Layout only.
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
        borderBottom: '1px solid var(--canopy-input-border)',
        background: 'var(--mantine-color-body)',
      }}
    >
      <Box flex={{ base: '1 0 100%', md: '1 1 0%' }} miw={0}>
        {leading}
      </Box>
      <Group
        gap="xs"
        wrap="nowrap"
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
