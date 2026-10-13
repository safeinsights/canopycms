'use client'

import React from 'react'

import { ReasonedMenuItem, type ReasonedMenuItemProps } from './ReasonedMenuItem'

/**
 * A menu item that deletes or removes. Mantine inlines a red item's text at red.6 (3.3:1 on
 * white), out of the theme's reach, so it takes `--canopy-danger-text`.
 */
export const DestructiveMenuItem: React.FC<Omit<ReasonedMenuItemProps, 'color'>> = (props) => (
  <ReasonedMenuItem color="red" c="var(--canopy-danger-text)" {...props} />
)
