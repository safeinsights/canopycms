'use client'

import React from 'react'
import { Text, Tooltip, type TextProps } from '@mantine/core'
import { formatRelativeTime } from '../relative-time'

export interface RelativeTimeProps extends Pick<TextProps, 'size' | 'c' | 'fs'> {
  /** An ISO timestamp. */
  iso: string
  /** Text before the label, such as "Updated ". */
  prefix?: string
}

/** A timestamp as a relative label, with the absolute date and time in a tooltip. */
export const RelativeTime: React.FC<RelativeTimeProps> = ({ iso, prefix, size, c, fs }) => {
  const absolute = new Date(iso)
  const valid = !Number.isNaN(absolute.getTime())
  return (
    <Tooltip label={valid ? absolute.toLocaleString() : ''} disabled={!valid}>
      <Text component="time" dateTime={iso} size={size} c={c} fs={fs}>
        {prefix}
        {formatRelativeTime(iso)}
      </Text>
    </Tooltip>
  )
}
