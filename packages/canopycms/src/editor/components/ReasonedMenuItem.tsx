'use client'

import React from 'react'
import { Menu, Text, type MenuItemProps } from '@mantine/core'

export interface ReasonedMenuItemProps extends MenuItemProps {
  /** Why the item can't act now. Set, the item is blocked and shows this beneath its label. */
  blockedReason?: string
  /** False when a neighbouring item already says why, so the reason is not printed twice. */
  showReason?: boolean
  /** The reason's element id, which another blocked item that shows no reason can point to. */
  reasonId?: string
  /** The id of the element that gives this item's reason, when it is not printed beneath it. */
  reasonDescribedBy?: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  'data-testid'?: string
  /** The caller's own description, kept unless a shared reason points elsewhere. */
  'aria-describedby'?: string
  children: React.ReactNode
}

/**
 * A menu item that stays visible when it cannot act, with its reason beneath the label. Mantine's
 * Menu drops a `disabled` or `data-disabled` item from its arrow-key order, hiding the reason from
 * a keyboard user; a blocked item is `aria-disabled` instead and ignores its click.
 */
export const ReasonedMenuItem: React.FC<ReasonedMenuItemProps> = ({
  blockedReason,
  showReason = true,
  reasonId,
  reasonDescribedBy,
  onClick,
  children,
  color,
  style,
  ...rest
}) => (
  <Menu.Item
    {...rest}
    color={blockedReason ? undefined : color}
    c={blockedReason ? 'dimmed' : rest.c}
    aria-disabled={blockedReason ? true : undefined}
    aria-describedby={(blockedReason && reasonDescribedBy) || rest['aria-describedby']}
    closeMenuOnClick={blockedReason ? false : undefined}
    style={blockedReason ? { ...style, cursor: 'not-allowed' } : style}
    onClick={(event) => {
      if (blockedReason) {
        event.stopPropagation()
        return
      }
      onClick?.(event)
    }}
  >
    {children}
    {blockedReason && showReason && (
      <Text
        id={reasonId}
        size="xs"
        c="dimmed"
        component="span"
        display="block"
        style={{ whiteSpace: 'normal' }}
      >
        {blockedReason}
      </Text>
    )}
  </Menu.Item>
)
