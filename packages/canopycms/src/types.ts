import type { ContentId } from './paths/types'

export type CanopyUserId = string
export type CanopyGroupId = string

export type BranchStatus = 'editing' | 'submitted' | 'approved' | 'locked' | 'archived'
export type SyncStatus = 'synced' | 'pending-sync' | 'sync-failed'
export type ConflictStatus = 'clean' | 'conflicts-detected'

export interface BranchAccessControl {
  allowedUsers?: CanopyUserId[]
  allowedGroups?: CanopyGroupId[]
  managerOrAdminAllowed?: boolean
  adminOnly?: boolean
}

export interface BranchMetadata {
  name: string
  title?: string
  description?: string
  status: BranchStatus
  access: BranchAccessControl
  createdBy: CanopyUserId
  createdAt: string
  updatedAt: string
  pullRequestUrl?: string
  pullRequestNumber?: number
  /** Sync status for async GitHub operations (used when Lambda has no internet) */
  syncStatus?: SyncStatus
  /** Whether this branch has unresolved merge conflicts with the base branch */
  conflictStatus?: ConflictStatus
  /** ContentIds of entries where --theirs was applied during rebase; cleared on clean rebase */
  conflictFiles?: ContentId[]
}

export interface BranchPaths {
  /** Root where all branches live (e.g., /mnt/efs/site, ~/.canopycms/branches) */
  baseRoot: string

  /** This branch's directory. Usually {baseRoot}/{branchName}, equals baseRoot in dev mode */
  branchRoot: string
}

export interface BranchContext extends BranchPaths {
  branch: BranchMetadata

  /** Per-branch flattened schema (lazy-loaded via getBranchContext with loadSchema: true) */
  flatSchema?: import('./config').FlatSchemaItem[]
}
