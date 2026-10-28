import { Button, Stack, Text } from '@mantine/core'

export interface BranchesLoadFailedNoticeProps {
  /** Loads the branch list again. Without it the notice is text alone. */
  onRetry?: () => void
  /** A retry is in flight. */
  retrying?: boolean
  align?: 'flex-start' | 'center'
  'data-testid'?: string
}

/**
 * The error state of an editor no branch is pinned in, while the branch list it takes its
 * branch from has failed to load. It outlasts the dismissible toast for the same failure.
 */
export function BranchesLoadFailedNotice({
  onRetry,
  retrying = false,
  align = 'flex-start',
  'data-testid': testId,
}: BranchesLoadFailedNoticeProps) {
  return (
    <Stack gap={4} py="sm" align={align} data-testid={testId}>
      <Text size="sm" c="var(--canopy-danger-text)">
        {"Couldn't load the branch list, so no branch can open."}
      </Text>
      {/* `aria-disabled`, not `loading`, which disables the button and drops its focus. */}
      {onRetry && (
        <Button
          size="compact-sm"
          variant="subtle"
          aria-disabled={retrying || undefined}
          style={{ cursor: retrying ? 'default' : undefined }}
          onClick={() => {
            if (!retrying) onRetry()
          }}
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </Button>
      )}
    </Stack>
  )
}
