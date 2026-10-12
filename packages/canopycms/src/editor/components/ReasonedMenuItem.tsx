'use client'

import React from 'react'
import { Menu, Text, type MenuItemProps } from '@mantine/core'

export interface ReasonedMenuItemProps extends MenuItemProps {
  /** Why the item can't act now. Set, the item is blocked and shows this beneath its label. */
  blockedReason?: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
  'data-testid'?: string
  children: React.ReactNode
}

/**
 * A menu item that stays visible when it cannot act, with its reason beneath the label. Mantine's
 * Menu drops a `disabled` or `data-disabled` item from its arrow-key order, hiding the reason from
 * a keyboard user; a blocked item is `aria-disabled` instead and ignores its click.
 */
export const ReasonedMenuItem: React.FC<ReasonedMenuItemProps> = ({
  blockedReason,
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
    {blockedReason && (
      <Text size="xs" c="dimmed" component="span" display="block" style={{ whiteSpace: 'normal' }}>
        {blockedReason}
      </Text>
    )}
  </Menu.Item>
)
