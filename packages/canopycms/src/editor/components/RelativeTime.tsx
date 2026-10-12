'use client'

import React from 'react'
import { Text, Tooltip, VisuallyHidden, type TextProps } from '@mantine/core'
import { formatRelativeTime } from '../relative-time'

export interface RelativeTimeProps extends Pick<TextProps, 'size' | 'c' | 'fs'> {
  /** An ISO timestamp. */
  iso: string
  /** Text before the label, such as "Updated ". */
  prefix?: string
}

/** A relative label; the absolute date is a tooltip, and visually hidden text for a screen reader. */
export const RelativeTime: React.FC<RelativeTimeProps> = ({ iso, prefix, size, c, fs }) => {
  const absolute = new Date(iso)
  const valid = !Number.isNaN(absolute.getTime())
  return (
    <Tooltip label={valid ? absolute.toLocaleString() : ''} disabled={!valid}>
      <Text component="time" dateTime={iso} size={size} c={c} fs={fs}>
        {prefix}
        {formatRelativeTime(iso)}
        {valid && (
          <VisuallyHidden component="span">{`, ${absolute.toLocaleString()}`}</VisuallyHidden>
        )}
      </Text>
    </Tooltip>
  )
}
