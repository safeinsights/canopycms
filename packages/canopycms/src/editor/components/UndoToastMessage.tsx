import { Button, Group, Text } from '@mantine/core'

export interface UndoToastMessageProps {
  /** Names what was removed: `"Branch-aware" from Features`, `item 2 from Features`. */
  label: string
  /** `clear` for an optional object's Clear. */
  action?: 'remove' | 'clear'
  /** A sentence after the message, such as where the item's comments went. */
  note?: string
  onUndo: () => void
  /**
   * Called when keyboard focus reaches the toast. Mantine pauses its timer on hover only, so the
   * caller stops it here or the toast can close under the focused Undo.
   */
  onHold?: () => void
  /** Called when focus leaves the toast, so its timer can run again. */
  onRelease?: () => void
}

/** The body of the toast a form Remove raises in place of a confirmation. */
export function UndoToastMessage({
  label,
  action = 'remove',
  note,
  onUndo,
  onHold,
  onRelease,
}: UndoToastMessageProps) {
  const [done, doing] = action === 'clear' ? ['Cleared', 'clearing'] : ['Removed', 'removing']
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
      <Text size="sm" miw={0}>
        {note ? `${done} ${label}. ${note}` : `${done} ${label}`}
      </Text>
      <Button
        size="compact-sm"
        variant="subtle"
        onClick={onUndo}
        aria-label={`Undo ${doing} ${label}`}
      >
        Undo
      </Button>
    </Group>
  )
}
