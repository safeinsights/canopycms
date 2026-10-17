import { Alert, Box, Button, Group, Text } from '@mantine/core'
import { IconLock } from '@tabler/icons-react'
import type { BranchStatus } from '../../types'
import { EDITOR_ACTIONS } from '../copy'

export interface BranchLockInput {
  branchStatus: BranchStatus | undefined
  /** The protected base branch, read-only in prod. */
  branchReadOnly?: boolean
  branchWriteBlocked?: boolean
}

/**
 * Which lock applies. `branchWriteBlocked` is the server's own answer (getBranchProtection), so
 * nothing offers a write the API would reject; `branchReadOnly` only picks the message, and
 * base-branch read-only takes precedence over a workflow status lock.
 */
function branchLockState({
  branchStatus,
  branchReadOnly = false,
  branchWriteBlocked = false,
}: BranchLockInput) {
  const statusLocked = branchWriteBlocked && !branchReadOnly
  // `branchStatus` can't describe the lock while branch data loads (undefined) or under version
  // skew (an old server omits `branchWriteBlocked` but reports 'editing'), so both read as
  // "details unavailable" rather than naming a status the lock contradicts.
  const branchDataUnavailable =
    statusLocked && (branchStatus === undefined || branchStatus === 'editing')
  return { statusLocked, branchDataUnavailable }
}

/**
 * Whether the banner renders; the top bar reads the same answer, so the two cannot drift.
 * @internal Exported for tests.
 */
export function branchLockBannerShown(lock: BranchLockInput): boolean {
  return !!lock.branchReadOnly || branchLockState(lock).statusLocked
}

/**
 * Why the branch takes no writes, with the way forward; undefined when it does take them. The
 * top bar's Save and the navigator's row locks say this; the banner describes the same lock.
 */
export function describeBranchLock(lock: BranchLockInput): string | undefined {
  if (!branchLockBannerShown(lock)) return undefined
  const { statusLocked, branchDataUnavailable } = branchLockState(lock)
  if (lock.branchReadOnly) return 'The base branch is read-only. Create a branch to make changes.'
  if (branchDataUnavailable)
    return 'Branch details could not be loaded. Use "Switch branch…" to retry.'
  if (!statusLocked) return undefined
  if (lock.branchStatus === 'submitted')
    return 'This branch is in review. Withdraw it to make changes.'
  if (lock.branchStatus === 'approved')
    return 'This branch is approved. Withdraw it to make changes.'
  return `This branch is ${lock.branchStatus}. Its content is read-only.`
}

export interface BranchLockBannerProps extends BranchLockInput {
  branchName: string
  onBranchManagerOpen: () => void
}

/** The banner region's explanation of a read-only branch; not dismissible while it applies. */
export function BranchLockBanner({
  branchName,
  onBranchManagerOpen,
  ...lock
}: BranchLockBannerProps) {
  const { branchDataUnavailable } = branchLockState(lock)
  if (!branchLockBannerShown(lock)) return null

  const [testId, message, action] = lock.branchReadOnly
    ? [
        'protected-branch-banner',
        `You are viewing the protected base branch "${branchName}". Content is read-only — create a branch to make changes.`,
        `${EDITOR_ACTIONS.newBranch}…`,
      ]
    : [
        'status-locked-banner',
        branchDataUnavailable
          ? `Branch details for "${branchName}" could not be loaded, so content is locked until they arrive. Use Switch branch… to retry.`
          : lock.branchStatus === 'submitted'
            ? `Branch "${branchName}" is submitted for review and locked for edits. Withdraw it from review to make changes.`
            : `Branch "${branchName}" is ${lock.branchStatus} — content is read-only.`,
        `${EDITOR_ACTIONS.switchBranch}…`,
      ]

  return (
    <Box px="md" py="sm">
      <Alert icon={<IconLock size={16} />} color="yellow" variant="light" data-testid={testId}>
        <Group justify="space-between" align="center" gap="sm" wrap="wrap">
          <Text size="sm">{message}</Text>
          <Button variant="default" onClick={onBranchManagerOpen}>
            {action}
          </Button>
        </Group>
      </Alert>
    </Box>
  )
}
