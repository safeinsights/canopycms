import type { PathPermission, PermissionLevel, PermissionTarget } from '../../config'
import type {
  UserSearchResult,
  GroupMetadata,
  GroupSource,
  PermissionGroupOption,
} from '../../auth/types'
import type { EditorCollection } from '../Editor'

export interface PermissionManagerProps {
  /** Collections from API */
  collections?: EditorCollection[]
  /** Content root path (default: 'content') */
  contentRoot?: string
  permissions: PathPermission[]
  /** Whether user can edit permissions (admin only) */
  canEdit: boolean
  onSave?: (permissions: PathPermission[]) => Promise<void>
  onSearchUsers?: (query: string, limit?: number) => Promise<UserSearchResult[]>
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  /** Handler to list groups (internal + external, tagged by `source`) */
  onListGroups?: () => Promise<PermissionGroupOption[]>
  onClose?: () => void
  loading?: boolean
  /** Optional: actual filesystem content tree (for entries not in schema) */
  contentTree?: ContentNode
}

export interface ContentNode {
  path: string
  name: string
  type: 'folder' | 'file'
  children?: ContentNode[]
}

export interface TreeNode {
  path: string
  name: string
  type: 'folder' | 'file'
  children: TreeNode[]
  /** Permissions directly assigned to this node */
  directPermission?: PathPermission
  /** Permissions inherited from parent */
  inheritedPermission?: PathPermission
}

export interface GroupSelectItem {
  value: string
  label: string
  /** Which universe this option came from; shown as a tag in the picker. */
  source: GroupSource
}

/** Re-export for convenience */
export type {
  PathPermission,
  PermissionLevel,
  PermissionTarget,
  UserSearchResult,
  GroupMetadata,
  GroupSource,
  PermissionGroupOption,
}
