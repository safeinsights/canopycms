import React, { useEffect, useRef } from 'react'
import { Button, Group, Text } from '@mantine/core'

import { EDITOR_ACTIONS } from '../copy'

export interface BranchCreatedToastProps {
  label: string
  /** Opens the Share dialog for the new branch; without it the toast offers nothing. */
  onShare?: () => void
  /** Focus reached the toast, so its timer should stop (Mantine pauses it on hover only). */
  onHold?: () => void
  onRelease?: () => void
}

/**
 * The toast a create raises once the Branches drawer it started in has closed. Focus anywhere in
 * the notification, its ✕ included, holds the timer, so it is watched on the notification itself.
 */
export function BranchCreatedToast({ label, onShare, onHold, onRelease }: BranchCreatedToastProps) {
  const body = useRef<HTMLDivElement>(null)
  const hold = useRef(onHold)
  const release = useRef(onRelease)
  useEffect(() => {
    hold.current = onHold
    release.current = onRelease
  })
  useEffect(() => {
    const root = body.current?.closest<HTMLElement>('.mantine-Notification-root') ?? body.current
    if (!root) return
    const focusIn = () => hold.current?.()
    const focusOut = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node && root.contains(event.relatedTarget))) {
        release.current?.()
      }
    }
    root.addEventListener('focusin', focusIn)
    root.addEventListener('focusout', focusOut)
    return () => {
      root.removeEventListener('focusin', focusIn)
      root.removeEventListener('focusout', focusOut)
    }
  }, [])
  return (
    <Group ref={body} justify="space-between" align="center" gap="sm" wrap="nowrap">
      <Text size="sm" miw={0} style={{ overflowWrap: 'anywhere' }}>
        {`Branch “${label}” created`}
      </Text>
      {onShare && (
        <Button
          size="compact-sm"
          variant="subtle"
          style={{ flexShrink: 0 }}
          aria-haspopup="dialog"
          onClick={onShare}
          data-testid="branch-created-toast-share"
        >
          {`${EDITOR_ACTIONS.share}…`}
        </Button>
      )}
    </Group>
  )
}
