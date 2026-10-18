'use client'

import { useId, useState } from 'react'
import { Anchor, Button, Code, Group, Stack, Text } from '@mantine/core'

export interface RetryToastMessageProps {
  /** What failed, in plain words. */
  message: string
  onRetry: () => void
  /** The button's label, when the way forward is not a plain retry. */
  actionLabel?: string
  /** A developer diagnostic, shown only once "Details" is opened. */
  details?: string
}

/** The body of an error toast whose failure the user can try again from the toast. */
export function RetryToastMessage({
  message,
  onRetry,
  actionLabel = 'Retry',
  details,
}: RetryToastMessageProps) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()
  return (
    <Stack gap={4}>
      <Group justify="space-between" align="center" gap="sm" wrap="nowrap">
        <Text size="sm" miw={0}>
          {message}
        </Text>
        <Button size="compact-sm" variant="subtle" onClick={onRetry}>
          {actionLabel}
        </Button>
      </Group>
      {details && (
        <>
          <Anchor
            component="button"
            type="button"
            size="xs"
            style={{ alignSelf: 'flex-start' }}
            aria-expanded={detailsOpen}
            aria-controls={detailsOpen ? detailsId : undefined}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            Details
          </Anchor>
          {detailsOpen && (
            <Code id={detailsId} block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {details}
            </Code>
          )}
        </>
      )}
    </Stack>
  )
}
