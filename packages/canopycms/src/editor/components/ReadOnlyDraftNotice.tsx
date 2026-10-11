import { Alert, Button, Group, Stack, Text } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'

export interface ReadOnlyDraftNoticeProps {
  /** The branch never becomes editable again: the protected base branch, or an archived one. */
  permanentlyReadOnly: boolean
  /** Discards the entry's kept draft; the caller confirms first, since the draft is unsaved work. */
  onDiscard: () => void
}

/**
 * Says that this entry has a draft the read-only form is not showing. The draft is kept until it
 * is discarded, so it comes back as the editable value if the branch unlocks.
 */
export function ReadOnlyDraftNotice({ permanentlyReadOnly, onDiscard }: ReadOnlyDraftNoticeProps) {
  return (
    <Alert
      role="status"
      icon={<IconAlertTriangle size={16} />}
      color="yellow"
      variant="light"
      mb="md"
      data-testid="read-only-draft-notice"
    >
      <Group justify="space-between" align="center" gap="sm" wrap="wrap">
        <Stack gap={2}>
          <Text size="sm">You have unsaved changes from earlier on this read-only branch.</Text>
          <Text size="sm">
            {permanentlyReadOnly
              ? "This branch won't become editable, so they can only be discarded."
              : "They're kept on this device and come back when the branch is editable again."}
          </Text>
        </Stack>
        <Button variant="default" onClick={onDiscard}>
          Discard changes
        </Button>
      </Group>
    </Alert>
  )
}
