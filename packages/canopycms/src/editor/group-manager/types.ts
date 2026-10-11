import type { UserSearchResult } from '../../auth/types'
import type { CanopyGroupId, CanopyUserId } from '../../types'
import type { InternalGroup } from '../../authorization'
import type { ExternalGroup } from '../../api/groups'

export type { UserSearchResult, InternalGroup, ExternalGroup }
export type { CanopyGroupId, CanopyUserId }

export interface GroupManagerProps {
  opened: boolean
  /** Closes the drawer; while there are unsaved changes it runs only after the user confirms discarding them. */
  onClose: () => void
  internalGroups: InternalGroup[]
  loading?: boolean
  canEdit: boolean
  onSave?: (groups: InternalGroup[]) => Promise<void>
  onSearchUsers?: (query: string, limit?: number) => Promise<UserSearchResult[]>
  onGetUserMetadata?: (userId: string) => Promise<UserSearchResult | null>
  onSearchExternalGroups?: (query: string) => Promise<ExternalGroup[]>
}

export interface GroupFormData {
  name: string
  description: string
}
