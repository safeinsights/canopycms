'use client'

import React, { useState } from 'react'
import { Alert } from '@mantine/core'
import { IconAlertTriangle, IconInfoCircle } from '@tabler/icons-react'
import {
  SLOW_NOTICE,
  WAITING_DRAFT_NOTE,
  WAITING_NOTICE,
  type BaseUpdateWait,
} from '../base-update-wait'

/**
 * The one notice above the form while the open branch gets the latest changes: blue while the
 * form is read-only, then yellow once the wait is slow and the form is editable again, which can
 * be dismissed until the wait changes. The bar's status region announces the wait starting, so the
 * blue notice is not a live region; the yellow one, which the bar doesn't announce, is polite.
 */
export function BaseUpdateNotice({
  wait,
  hidesDraft = false,
}: {
  wait: Exclude<BaseUpdateWait, 'none'>
  /** The read-only form hides this viewer's unsaved changes meanwhile. */
  hidesDraft?: boolean
}) {
  // Dismissed for one wait only: a new phase shows it again.
  const [dismissedFor, setDismissedFor] = useState<BaseUpdateWait | null>(null)
  if (wait === 'waiting') {
    return (
      <Alert
        color="blue"
        variant="light"
        // Mantine sets role="alert" after the props it's given, so the root sets the role.
        renderRoot={(props) => <div {...props} role="note" />}
        icon={<IconInfoCircle size={16} aria-hidden="true" />}
        data-testid="base-update-waiting-notice"
      >
        {hidesDraft ? `${WAITING_NOTICE} ${WAITING_DRAFT_NOTE}` : WAITING_NOTICE}
      </Alert>
    )
  }
  if (dismissedFor === wait) return null
  return (
    <Alert
      color="yellow"
      variant="light"
      renderRoot={(props) => <div {...props} role="status" />}
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
