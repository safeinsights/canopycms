/**
 * Types for PermissionManager component
 */

import type { PathPermission, PermissionLevel, PermissionTarget } from '../../config'
import type { UserSearchResult, GroupMetadata } from '../../auth/types'
import type { CanopyConfig } from '../../config'
import type { EditorCollection } from '../Editor'

export interface PermissionManagerProps {
  /** Content schema to build tree from (optional - can use collections instead) */
  schema?: CanopyConfig['schema']
  /** Collections from API (alternative to schema for file-based configs) */
  collections?: EditorCollection[]
  /** Content root path (default: 'content') */
  contentRoot?: string
  /** Current permissions */
  permissions: PathPermission[]
  /** Whether user can edit permissions (admin only) */
  canEdit: boolean
  /** Handler to save updated permissions */
  onSave?: (permissions: PathPermission[]) => Promise<void>
  /** Handler to search users */
  onSearchUsers?: (query: string, limit?: number) => Promise<UserSearchResult[]>
  /** Handler to get user metadata by ID */
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  /** Handler to list groups */
  onListGroups?: () => Promise<GroupMetadata[]>
  /** Close handler */
  onClose?: () => void
  /** Loading state */
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
}

/** Re-export for convenience */
export type { PathPermission, PermissionLevel, PermissionTarget, UserSearchResult, GroupMetadata }
