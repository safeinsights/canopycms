import React from 'react'
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

/** The toast a create raises once the Branches drawer it started in has closed. */
export function BranchCreatedToast({ label, onShare, onHold, onRelease }: BranchCreatedToastProps) {
  return (
    <Group
      justify="space-between"
      align="center"
      gap="sm"
      wrap="nowrap"
      onFocus={onHold}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onRelease?.()
      }}
    >
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
