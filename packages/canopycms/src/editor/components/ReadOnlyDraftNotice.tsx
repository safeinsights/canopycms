import { Alert, Button, Group, Text } from '@mantine/core'
import { IconInfoCircle } from '@tabler/icons-react'

export interface ReadOnlyDraftNoticeProps {
  /** Discards the entry's kept draft; the caller confirms first, since the draft is unsaved work. */
  onDiscard: () => void
}

/**
 * Says that this entry has a draft the read-only form is not showing. The draft is kept until it
 * is discarded, so it comes back as the editable value if the branch unlocks.
 */
export function ReadOnlyDraftNotice({ onDiscard }: ReadOnlyDraftNoticeProps) {
  return (
    <Alert
      icon={<IconInfoCircle size={16} />}
      color="yellow"
      variant="light"
      mb="md"
      data-testid="read-only-draft-notice"
    >
      <Group justify="space-between" align="center" gap="sm" wrap="wrap">
        <Text size="sm">You have unsaved changes from earlier on this read-only branch.</Text>
        <Button variant="light" color="yellow" onClick={onDiscard}>
          Discard changes
        </Button>
      </Group>
    </Alert>
  )
}
