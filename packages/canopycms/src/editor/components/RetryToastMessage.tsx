import { Button, Group, Text } from '@mantine/core'

export interface RetryToastMessageProps {
  /** What failed, in plain words. */
  message: string
  onRetry: () => void
  /** The button's label, when the way forward is not a plain retry. */
  actionLabel?: string
}

/** The body of an error toast whose failure the user can try again from the toast. */
export function RetryToastMessage({
  message,
  onRetry,
  actionLabel = 'Retry',
}: RetryToastMessageProps) {
  return (
    <Group justify="space-between" align="center" gap="sm" wrap="nowrap">
      <Text size="sm" miw={0}>
        {message}
      </Text>
      <Button size="compact-sm" variant="subtle" onClick={onRetry}>
        {actionLabel}
      </Button>
    </Group>
  )
}
