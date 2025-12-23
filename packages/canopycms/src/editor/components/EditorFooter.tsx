import { Group, Paper, Text } from '@mantine/core'

/**
 * Props for the EditorFooter component.
 */
export interface EditorFooterProps {
  /**
   * Optional custom footer content.
   */
  children?: React.ReactNode
}

/**
 * Footer component for the Editor.
 * Displays static links (Terms, Privacy) and copyright notice.
 *
 * @example
 * ```tsx
 * <EditorFooter />
 * ```
 */
export function EditorFooter({ children }: EditorFooterProps) {
  return (
    <Paper
      withBorder
      radius={0}
      shadow="sm"
      px="md"
      py="xs"
      style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 40 }}
    >
      {children ?? (
        <Group gap="md" justify="center">
          <Text size="xs" c="dimmed">
            Terms
          </Text>
          <Text size="xs" c="dimmed">
            Privacy
          </Text>
          <Text size="xs" c="dimmed">
            © CanopyCMS
          </Text>
        </Group>
      )}
    </Paper>
  )
}
