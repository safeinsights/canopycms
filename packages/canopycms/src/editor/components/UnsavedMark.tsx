'use client'

import React, { forwardRef } from 'react'
import { Box, type ElementProps } from '@mantine/core'

/**
 * The editor's one "unsaved" mark, a dot.
 * `--canopy-unsaved-mark` is the brand colour at 3:1 on the shell's surfaces in either scheme.
 * The caller says whether it is named (`role="img"` and a label) or decoration (`aria-hidden`).
 * It forwards its ref, so a Tooltip can wrap it.
 */
export const UnsavedMark = forwardRef<
  HTMLSpanElement,
  Omit<ElementProps<'span'>, 'style' | 'color'>
>(function UnsavedMark(props, ref) {
  return (
    <Box
      ref={ref}
      component="span"
      {...props}
      style={{
        display: 'inline-block',
        flexShrink: 0,
        width: 8,
        height: 8,
        borderRadius: '50%',
        backgroundColor: 'var(--canopy-unsaved-mark, var(--mantine-color-brand-6))',
      }}
    />
  )
})
