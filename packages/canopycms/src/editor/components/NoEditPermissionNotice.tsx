import { Text } from '@mantine/core'

export interface NoEditPermissionNoticeProps {
  /** Branch being edited. */
  branchName?: string
  /** True when the branch is the read-only protected base branch. */
  branchReadOnly?: boolean
  /** True when the server blocks writes to the branch (read-only base branch or locked status). */
  branchWriteBlocked?: boolean
  /** Workflow status of the branch, when known. */
  branchStatus?: string
  /** Logical path of the entry the user cannot edit. */
  entryPath: string
}

/**
 * Explains why an entry cannot be edited. The branch reason wins over the
 * permission reason: when writes to the branch are blocked, a permission grant
 * would not help.
 */
export function NoEditPermissionNotice({
  branchName,
  branchReadOnly = false,
  branchWriteBlocked = false,
  branchStatus,
  entryPath,
}: NoEditPermissionNoticeProps) {
  const branchLabel = branchName ? `"${branchName}"` : 'This branch'
  const statusLocked =
    branchWriteBlocked &&
    !branchReadOnly &&
    branchStatus !== undefined &&
    branchStatus !== 'editing'

  let message: string
  if (branchReadOnly) {
    message = `${branchLabel} is the protected base branch, so its content is read-only. Create or switch to another branch to edit.`
  } else if (statusLocked) {
    message =
      branchStatus === 'submitted'
        ? `${branchLabel} is submitted for review and locked for edits. Withdraw it to resume editing.`
        : `${branchLabel} is ${branchStatus}, so its content is read-only.`
  } else {
    message = `You don't have edit access to "${entryPath}". Ask a CanopyCMS admin to grant it in Manage Permissions.`
  }

  return (
    <div
      role="status"
      data-testid="no-edit-permission-notice"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: '0 var(--mantine-spacing-md)',
        textAlign: 'center',
      }}
    >
      <Text size="sm" c="dimmed">
        {message}
      </Text>
    </div>
  )
}
