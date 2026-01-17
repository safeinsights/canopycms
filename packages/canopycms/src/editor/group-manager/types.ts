/**
 * Type definitions for GroupManager module
 */

import type { UserSearchResult, GroupMetadata } from '../../auth/types'
import type { CanopyGroupId, CanopyUserId } from '../../types'
import type { InternalGroup } from '../../authorization'
import type { ExternalGroup } from '../../api/groups'

// Re-export commonly used types for convenience
export type { UserSearchResult, GroupMetadata, InternalGroup, ExternalGroup }
export type { CanopyGroupId, CanopyUserId }

export interface GroupManagerProps {
  internalGroups: InternalGroup[]
  loading?: boolean
  canEdit: boolean
  onSave?: (groups: InternalGroup[]) => Promise<void>
  onSearchUsers?: (query: string, limit?: number) => Promise<UserSearchResult[]>
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  onSearchExternalGroups?: (query: string) => Promise<ExternalGroup[]>
  onClose?: () => void
}

export interface GroupFormData {
  name: string
  description: string
}
