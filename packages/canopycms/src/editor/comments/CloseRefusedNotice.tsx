import { Text, VisuallyHidden } from '@mantine/core'
import { CLOSE_WAITS_FOR_WRITE } from './use-tracked-writes'

/** Why a comments surface stayed open: an always-mounted live region, so it is announced. */
export function CloseRefusedNotice({ refused }: { refused: boolean }) {
  return (
    <>
      <VisuallyHidden role="status">{refused ? CLOSE_WAITS_FOR_WRITE : ''}</VisuallyHidden>
      {refused && (
        <Text size="xs" c="dimmed" aria-hidden>
          {CLOSE_WAITS_FOR_WRITE}
        </Text>
      )}
    </>
  )
}
