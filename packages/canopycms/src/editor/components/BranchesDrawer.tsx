'use client'

import React from 'react'
import { OverlayDrawer } from '../shell/OverlayHeader'
import { focusReturnProps } from '../utils/focus-return'

export interface BranchesDrawerProps {
  opened: boolean
  onClose: () => void
  /** A confirm opened from inside is on screen: the drawer yields Escape to it (Mantine listens for Escape on window, capture phase). */
  confirmOpen: boolean
  /** Names the element that takes focus after the drawer closes, for an opener that unmounted (a menu item). */
  returnFocusTo?: () => HTMLElement | null
  children: React.ReactNode
}

export const BranchesDrawer: React.FC<BranchesDrawerProps> = ({
  opened,
  onClose,
  confirmOpen,
  returnFocusTo,
  children,
}) => (
  <OverlayDrawer
    opened={opened}
    onClose={onClose}
    closeOnEscape={!confirmOpen}
    position="right"
    title="Branches"
    size={420}
    {...focusReturnProps(returnFocusTo)}
  >
    {children}
  </OverlayDrawer>
)
