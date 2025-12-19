'use client'

import React from 'react'
import { Badge } from '@mantine/core'

export interface FieldCommentBadgeProps {
  /** Total number of comments in all threads for this field */
  count: number
  /** Number of unresolved comments */
  unresolvedCount: number
  /** Click handler to open comment thread panel */
  onClick: () => void
  /** Whether all threads are resolved */
  resolved: boolean
  /** Custom color for unresolved badge (from CanopyCMS config) */
  unresolvedColor?: string
  /** Custom color for resolved badge (from CanopyCMS config) */
  resolvedColor?: string
}

/**
 * Small badge showing comment count on form fields.
 * Always visible when there are comments on the field.
 * Color indicates resolved/unresolved status.
 */
export const FieldCommentBadge: React.FC<FieldCommentBadgeProps> = ({
  count,
  unresolvedCount,
  onClick,
  resolved,
  unresolvedColor = 'grape',
  resolvedColor = 'gray',
}) => {
  if (count === 0) {
    return null
  }

  const color = resolved ? resolvedColor : unresolvedColor

  return (
    <Badge
      size="sm"
      variant={resolved ? 'light' : 'filled'}
      color={color}
      onClick={onClick}
      style={{
        cursor: 'pointer',
        position: 'absolute',
        top: 4,
        right: 4,
        zIndex: 10,
      }}
      title={
        resolved
          ? `${count} resolved ${count === 1 ? 'comment' : 'comments'}`
          : `${unresolvedCount} unresolved ${unresolvedCount === 1 ? 'comment' : 'comments'}`
      }
    >
      {unresolvedCount > 0 ? unresolvedCount : count}
    </Badge>
  )
}
