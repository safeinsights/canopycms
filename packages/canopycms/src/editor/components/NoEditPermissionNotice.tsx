import { Text } from '@mantine/core'

export interface NoEditPermissionNoticeProps {
  /** Logical path of the entry the user cannot edit. */
  entryPath: string
}

/**
 * Explains why an entry cannot be edited and whom to ask. An entry's `canEdit` is false only
 * when a path rule (or `defaultPathAccess`) denies edit, so that is the reason it gives. A locked
 * or protected branch instead shows its banner in the header over a read-only form, the rule
 * `contentReadOnly` in `Editor.tsx` holds.
 */
export function NoEditPermissionNotice({ entryPath }: NoEditPermissionNoticeProps) {
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
        You don&apos;t have edit access to &quot;{entryPath}&quot;. Ask a CanopyCMS admin to grant
        it in Manage Permissions.
      </Text>
    </div>
  )
}
