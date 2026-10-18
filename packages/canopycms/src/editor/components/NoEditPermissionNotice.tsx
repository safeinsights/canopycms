import { Text } from '@mantine/core'

export interface NoEditPermissionNoticeProps {
  /** Label of the entry the user cannot edit. */
  entryLabel: string
}

/**
 * Explains why an entry cannot be edited and whom to ask. An entry's `canEdit` is false only
 * when a path rule (or `defaultPathAccess`) denies edit, so that is the reason it gives. A locked
 * or protected branch instead says so in the branch bar's status over a read-only form, the rule
 * `contentReadOnly` in `Editor.tsx` holds.
 */
export function NoEditPermissionNotice({ entryLabel }: NoEditPermissionNoticeProps) {
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
        You don&apos;t have edit access to &quot;{entryLabel}&quot;. Ask a CanopyCMS admin to grant
        it in &quot;Manage permissions&quot;.
      </Text>
    </div>
  )
}
