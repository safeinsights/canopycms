import { Button, Group, Text } from '@mantine/core'

export interface UndoToastMessageProps {
  /** Names what was removed, e.g. a list item's title or a field's label. */
  label: string
  onUndo: () => void
}

/** The body of the toast a form Remove raises in place of a confirmation. */
export function UndoToastMessage({ label, onUndo }: UndoToastMessageProps) {
  return (
    <Group justify="space-between" align="center" gap="sm" wrap="nowrap">
      <Text size="sm">{`Removed "${label}"`}</Text>
      <Button size="compact-sm" variant="subtle" onClick={onUndo}>
        Undo
      </Button>
    </Group>
  )
}
