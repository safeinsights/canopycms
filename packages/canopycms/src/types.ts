export type CanopyUserId = string
export type CanopyGroupId = string

export type BranchStatus = 'editing' | 'submitted' | 'approved' | 'locked' | 'archived'

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
}

export interface BranchState {
  branch: BranchMetadata
  pullRequestUrl?: string
  pullRequestNumber?: number
  workspaceRoot?: string
  baseRoot?: string
  metadataRoot?: string
}
