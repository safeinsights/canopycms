import type { BranchAccessControl, BranchState } from '../types'
import { BranchWorkspaceManager } from '../branch-workspace'
import { BranchRegistry } from '../branch-registry'
import { BranchMetadata } from '../branch-metadata'
import type { ApiContext, ApiRequest, ApiResponse, RequestUser } from './types'
import { getDefaultBranchBase } from '../paths'
import { isPrivileged, isAdmin } from '../reserved-groups'
import type { PathPermission } from '../config'

/**
 * Check if a user can create branches.
 * Returns true if:
 * - User is Admin or Reviewer (privileged)
 * - User has access to at least one path via pathPermissions rules
 * - No path permissions are defined (open access)
 */
export const canCreateBranch = (
  user: RequestUser,
  pathPermissions: PathPermission[]
): { allowed: boolean; reason: string } => {
  // Admins and Reviewers can always create branches
  if (isPrivileged(user.groups)) {
    return { allowed: true, reason: 'privileged_user' }
  }

  // If no path permissions defined, anyone can create branches
  if (pathPermissions.length === 0) {
    return { allowed: true, reason: 'no_restrictions' }
  }

  // Check if user has access to at least one path rule
  for (const rule of pathPermissions) {
    // Skip rules that only allow managers/admins
    if (rule.managerOrAdminAllowed) {
      continue
    }

    // Check if rule has no user/group constraints (open to all)
    const hasUserConstraint = !!rule.allowedUsers?.length
    const hasGroupConstraint = !!rule.allowedGroups?.length
    if (!hasUserConstraint && !hasGroupConstraint) {
      return { allowed: true, reason: 'open_path_rule' }
    }

    // Check if user matches the rule
    const matchesUser = hasUserConstraint && rule.allowedUsers?.includes(user.userId)
    const matchesGroup =
      hasGroupConstraint && user.groups?.some((gid) => rule.allowedGroups?.includes(gid))

    if (matchesUser || matchesGroup) {
      return { allowed: true, reason: 'path_access' }
    }
  }

  return { allowed: false, reason: 'no_path_access' }
}

export interface CreateBranchBody {
  branch: string
  title?: string
  description?: string
  access?: BranchState['branch']['access']
}

export const createBranch = async (
  ctx: ApiContext,
  req: ApiRequest<CreateBranchBody>
): Promise<ApiResponse<{ branch: BranchState }>> => {
  const branchName = req.body?.branch
  if (!branchName) {
    return { ok: false, status: 400, error: 'branch is required' }
  }

  // Check if user can create branches
  const pathPermissions = ctx.services.config.pathPermissions ?? []
  const canCreate = canCreateBranch(req.user, pathPermissions)
  if (!canCreate.allowed) {
    return { ok: false, status: 403, error: 'You do not have permission to create branches' }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const manager = new BranchWorkspaceManager(ctx.services.config)
  const workspace = await manager.openOrCreateBranch({
    branchName,
    mode: branchMode,
    createdBy: req.user.userId,
    title: req.body?.title,
    description: req.body?.description,
    access: req.body?.access,
  })
  return { ok: true, status: 200, data: { branch: workspace.state } }
}

export const listBranches = async (
  ctx: ApiContext,
  req: ApiRequest
): Promise<ApiResponse<{ branches: BranchState[] }>> => {
  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const registry = new BranchRegistry(getDefaultBranchBase(branchMode))
  const allBranches = await registry.list()

  // Admins and Reviewers see all branches
  if (isPrivileged(req.user.groups)) {
    return { ok: true, status: 200, data: { branches: allBranches } }
  }

  // Regular users only see branches they created or have explicit access to
  const visibleBranches = allBranches.filter((state) => {
    const branch = state.branch
    // User created the branch
    if (branch.createdBy === req.user.userId) {
      return true
    }
    // User is in allowedUsers
    if (branch.access?.allowedUsers?.includes(req.user.userId)) {
      return true
    }
    // User's group is in allowedGroups
    if (
      branch.access?.allowedGroups?.some((groupId) => req.user.groups?.includes(groupId))
    ) {
      return true
    }
    return false
  })

  return { ok: true, status: 200, data: { branches: visibleBranches } }
}

/**
 * Check if a user can delete a specific branch.
 * Returns true if user is Admin or the branch creator.
 */
export const canDeleteBranch = (
  user: RequestUser,
  branchState: BranchState
): { allowed: boolean; reason: string } => {
  // Admins can delete any branch
  if (isAdmin(user.groups)) {
    return { allowed: true, reason: 'admin' }
  }

  // Branch creator can delete their own branch
  if (branchState.branch.createdBy === user.userId) {
    return { allowed: true, reason: 'creator' }
  }

  return { allowed: false, reason: 'not_authorized' }
}

export const deleteBranch = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: { branch: string }
): Promise<ApiResponse<{ deleted: boolean }>> => {
  const branchName = params.branch
  if (!branchName) {
    return { ok: false, status: 400, error: 'branch is required' }
  }

  // Get branch state
  const branchState = await ctx.getBranchState(branchName)
  if (!branchState) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Check permission
  const canDelete = canDeleteBranch(req.user, branchState)
  if (!canDelete.allowed) {
    return { ok: false, status: 403, error: 'You do not have permission to delete this branch' }
  }

  // Block deletion if branch has open PR (submitted status)
  if (branchState.branch.status === 'submitted') {
    return { ok: false, status: 400, error: 'Cannot delete branch with open pull request' }
  }

  // Remove from registry
  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const registry = new BranchRegistry(getDefaultBranchBase(branchMode))
  await registry.remove(branchName)

  // TODO: Clean up workspace files and delete remote branch if exists
  // This would require additional filesystem operations and git commands
  // For now, we just remove from the registry

  return { ok: true, status: 200, data: { deleted: true } }
}

export interface UpdateBranchAccessBody {
  allowedUsers?: string[]
  allowedGroups?: string[]
}

/**
 * Check if a user can modify branch access.
 * Returns true if user is Admin or the branch creator.
 */
export const canModifyBranchAccess = (
  user: RequestUser,
  branchState: BranchState
): { allowed: boolean; reason: string } => {
  // Admins can modify any branch
  if (isAdmin(user.groups)) {
    return { allowed: true, reason: 'admin' }
  }

  // Branch creator can modify their own branch
  if (branchState.branch.createdBy === user.userId) {
    return { allowed: true, reason: 'creator' }
  }

  return { allowed: false, reason: 'not_authorized' }
}

export const updateBranchAccess = async (
  ctx: ApiContext,
  req: ApiRequest<UpdateBranchAccessBody>,
  params: { branch: string }
): Promise<ApiResponse<{ branch: BranchState }>> => {
  const branchName = params.branch
  if (!branchName) {
    return { ok: false, status: 400, error: 'branch is required' }
  }

  // Get branch state
  const branchState = await ctx.getBranchState(branchName)
  if (!branchState) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Check permission
  const canModify = canModifyBranchAccess(req.user, branchState)
  if (!canModify.allowed) {
    return { ok: false, status: 403, error: 'You do not have permission to modify this branch' }
  }

  // Build new access control
  const newAccess: BranchAccessControl = {
    ...branchState.branch.access,
  }
  if (req.body?.allowedUsers !== undefined) {
    newAccess.allowedUsers = req.body.allowedUsers
  }
  if (req.body?.allowedGroups !== undefined) {
    newAccess.allowedGroups = req.body.allowedGroups
  }

  // Update metadata
  if (!branchState.metadataRoot) {
    return { ok: false, status: 500, error: 'Branch metadata root not found' }
  }
  const metadata = new BranchMetadata(branchState.metadataRoot)
  const updated = await metadata.update({
    branch: { access: newAccess },
  })

  // Update registry
  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const registry = new BranchRegistry(getDefaultBranchBase(branchMode))
  const newState: BranchState = {
    ...branchState,
    branch: {
      ...branchState.branch,
      access: newAccess,
      updatedAt: updated.branch.updatedAt,
    },
  }
  await registry.upsert(newState)

  return { ok: true, status: 200, data: { branch: newState } }
}
