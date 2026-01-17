'use client'

/**
 * Badge component for displaying permission levels
 */

import React from 'react'
import { Badge, Tooltip } from '@mantine/core'
import type { PermissionLevel, PermissionTarget } from './types'
import { LEVEL_CONFIG } from './constants'

export interface PermissionLevelBadgeProps {
  level: PermissionLevel
  target?: PermissionTarget
  inherited?: PermissionTarget
}

/**
 * Displays a badge for a permission level.
 * Shows filled badge for direct permissions, outlined for inherited.
 */
export const PermissionLevelBadge: React.FC<PermissionLevelBadgeProps> = ({
  level,
  target,
  inherited,
}) => {
  const hasPerms =
    target && ((target.allowedUsers?.length ?? 0) > 0 || (target.allowedGroups?.length ?? 0) > 0)
  const hasInherited =
    !hasPerms &&
    inherited &&
    ((inherited.allowedUsers?.length ?? 0) > 0 || (inherited.allowedGroups?.length ?? 0) > 0)

  if (hasPerms) {
    return (
      <Badge size="xs" variant="filled" color={LEVEL_CONFIG[level].color}>
        {LEVEL_CONFIG[level].label}
      </Badge>
    )
  }

  if (hasInherited) {
    return (
      <Tooltip label={`${LEVEL_CONFIG[level].label} inherited from parent`}>
        <Badge size="xs" variant="outline" color="gray">
          {LEVEL_CONFIG[level].label}
        </Badge>
      </Tooltip>
    )
  }

  return null
}
