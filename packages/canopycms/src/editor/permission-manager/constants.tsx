/**
 * Constants for PermissionManager
 */

import React from 'react'
import { IconEye, IconPencil, IconCheckbox } from '@tabler/icons-react'
import type { PermissionLevel } from './types'

export const PERMISSION_LEVELS: PermissionLevel[] = ['read', 'edit', 'review']

export const LEVEL_CONFIG: Record<
  PermissionLevel,
  { label: string; icon: React.ReactNode; color: string }
> = {
  read: { label: 'Read', icon: <IconEye size={14} />, color: 'blue' },
  edit: { label: 'Edit', icon: <IconPencil size={14} />, color: 'green' },
  review: { label: 'Review', icon: <IconCheckbox size={14} />, color: 'grape' },
}
