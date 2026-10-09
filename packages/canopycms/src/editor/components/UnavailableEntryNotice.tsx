'use client'

import { Alert } from '@mantine/core'
import { IconAlertCircle } from '@tabler/icons-react'

import { UnavailableTypeMessage } from './UnavailableTypeMessage'

export interface UnavailableEntryNoticeProps {
  /** Registry keys the entry's type names; empty when only the 503 flagged it. */
  schemaRefs: readonly string[]
}

/** Stands in for the form of an entry whose type the running code cannot resolve. */
export function UnavailableEntryNotice({ schemaRefs }: UnavailableEntryNoticeProps) {
  return (
    <div style={{ padding: 'var(--mantine-spacing-md)' }} data-testid="unavailable-entry-notice">
      <Alert
        color="yellow"
        icon={<IconAlertCircle size={16} />}
        title="This entry can't be edited yet"
      >
        <UnavailableTypeMessage schemaRefs={schemaRefs} />
      </Alert>
    </div>
  )
}
