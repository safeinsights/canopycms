import { Button, Group, Text } from '@mantine/core'

export interface UndoToastMessageProps {
  /** Names what was removed: `"Branch-aware" from Features`, `item 2 from Features`. */
  label: string
  onUndo: () => void
  /**
   * Called when keyboard focus reaches the toast. Mantine pauses its timer on hover only, so the
   * caller stops it here or the toast can close under the focused Undo.
   */
  onHold?: () => void
}

/** The body of the toast a form Remove raises in place of a confirmation. */
export function UndoToastMessage({ label, onUndo, onHold }: UndoToastMessageProps) {
  return (
    <Group justify="space-between" align="center" gap="sm" wrap="nowrap" onFocus={onHold}>
      <Text size="sm">{`Removed ${label}`}</Text>
      <Button
        size="compact-sm"
        variant="subtle"
        onClick={onUndo}
        aria-label={`Undo removing ${label}`}
      >
        Undo
      </Button>
    </Group>
  )
}
