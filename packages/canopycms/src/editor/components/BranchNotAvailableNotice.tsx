import { Button, Stack, Text } from '@mantine/core'
import { EDITOR_ACTIONS } from '../copy'

export interface BranchNotAvailableNoticeProps {
  /** Opens the Branches drawer. Without it the notice is text alone. */
  onSwitchBranch?: () => void
  align?: 'flex-start' | 'center'
  'data-testid'?: string
}

/**
 * The empty state of a branch on the bar's "Not available" row (`branchBarStatus`), where the
 * branch list answered without it, so nothing of the branch can show.
 */
export function BranchNotAvailableNotice({
  onSwitchBranch,
  align = 'flex-start',
  'data-testid': testId,
}: BranchNotAvailableNoticeProps) {
  return (
    <Stack gap={4} py="sm" align={align} data-testid={testId}>
      <Text size="sm" c="dimmed">
        {"You don't have access to this branch."}
      </Text>
      {onSwitchBranch && (
        <Button size="compact-sm" variant="subtle" onClick={onSwitchBranch}>
          {`${EDITOR_ACTIONS.switchBranch}…`}
        </Button>
      )}
    </Stack>
  )
}
