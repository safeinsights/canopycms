'use client'

import React, { useState } from 'react'
import { Alert, Loader } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import { SLOW_NOTICE, WAITING_NOTICE, type BaseUpdateWait } from '../base-update-wait'

/**
 * The one notice above the form while the open branch gets the latest changes: blue while the
 * form is read-only, then yellow once the wait is slow and the form is editable again, which can
 * be dismissed until the wait changes.
 */
export function BaseUpdateNotice({ wait }: { wait: Exclude<BaseUpdateWait, 'none'> }) {
  // Dismissed for one wait only: a new phase shows it again.
  const [dismissedFor, setDismissedFor] = useState<BaseUpdateWait | null>(null)
  if (wait === 'waiting') {
    return (
      <Alert
        color="blue"
        variant="light"
        icon={<Loader size={16} aria-hidden="true" />}
        data-testid="base-update-waiting-notice"
      >
        {WAITING_NOTICE}
      </Alert>
    )
  }
  if (dismissedFor === wait) return null
  return (
    <Alert
      color="yellow"
      variant="light"
      icon={<IconAlertTriangle size={16} aria-hidden="true" />}
      withCloseButton
      closeButtonLabel="Dismiss"
      onClose={() => setDismissedFor(wait)}
      data-testid="base-update-slow-notice"
    >
      {SLOW_NOTICE}
    </Alert>
  )
}
