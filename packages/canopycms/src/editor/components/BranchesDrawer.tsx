'use client'

import React from 'react'
import { Drawer, Text, Title } from '@mantine/core'

export interface BranchesDrawerProps {
  opened: boolean
  onClose: () => void
  /** A confirm opened from inside is on screen: the drawer yields Escape to it (Mantine listens for Escape on window, capture phase). */
  confirmOpen: boolean
  children: React.ReactNode
}

export const BranchesDrawer: React.FC<BranchesDrawerProps> = ({
  opened,
  onClose,
  confirmOpen,
  children,
}) => (
  <Drawer
    opened={opened}
    onClose={onClose}
    closeOnEscape={!confirmOpen}
    position="right"
    title={
      <div>
        <Title order={4}>Branches</Title>
        <Text size="xs" c="dimmed">
          Manage access, status, and lifecycle
        </Text>
      </div>
    }
    padding="md"
    size={420}
    overlayProps={{ blur: 2 }}
  >
    {children}
  </Drawer>
)
