'use client'

import { useId, type ReactNode } from 'react'
import { Box, Tooltip, VisuallyHidden } from '@mantine/core'

/**
 * A detail that only a Tooltip would show: hidden text for assistive tech, plus a Tooltip that
 * opens on hover, focus and touch. The trigger is a focusable span, not a button: it does nothing
 * when pressed, so it must not be announced as one. A trigger with no text of its own, such as an
 * icon, takes its name from `name`.
 */
export function TooltipDetail({
  detail,
  name,
  maw = 320,
  preLine = false,
  children,
}: {
  detail: string
  name?: string
  maw?: number
  preLine?: boolean
  children: ReactNode
}) {
  const detailId = useId()
  return (
    <>
      <Tooltip
        // A sighted user sees only the icon, so the tooltip names it too.
        label={name ? `${name}: ${detail}` : detail}
        multiline
        maw={maw}
        style={preLine ? { whiteSpace: 'pre-line' } : undefined}
        events={{ hover: true, focus: true, touch: true }}
      >
        <Box
          component="span"
          tabIndex={0}
          role={name ? 'img' : undefined}
          aria-label={name}
          aria-describedby={detailId}
          className="mantine-focus-auto"
          display="inline-flex"
        >
          {children}
        </Box>
      </Tooltip>
      <VisuallyHidden id={detailId}>{detail}</VisuallyHidden>
    </>
  )
}
