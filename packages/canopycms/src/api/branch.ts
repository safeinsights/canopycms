import fs from 'node:fs/promises'
import path from 'node:path'

import type { BranchAccessControl, BranchContext, BranchMetadata } from '../types'
import { BranchWorkspaceManager } from '../branch-workspace'
import { getBranchMetadataFileManager } from '../branch-metadata'
import type { ApiContext, ApiRequest, ApiResponse } from './types'

/** Response type for single branch operations (create, update, status) */
export type BranchResponse = ApiResponse<{ branch: BranchMetadata }>

/** Response type for listing branches */
export type BranchListResponse = ApiResponse<{ branches: BranchMetadata[] }>

/** Response type for branch deletion */
export type BranchDeleteResponse = ApiResponse<{ deleted: boolean }>
import { resolveBranchPaths } from '../paths'
import { isPrivileged, isAdmin } from '../reserved-groups'
import type { PathPermission } from '../config'
import { loadPathPermissions } from '../permissions-loader'
import type { CanopyUser } from '../user'

/**
 * Check if a user can create branches.
 * Returns true if:
 * - User is Admin or Reviewer (privileged)
 * - User has edit access to at least one path via pathPermissions rules
 * - No path permissions are defined (open access)
 */
export const canCreateBranch = (
  user: CanopyUser,
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

  // Check if user has edit access to at least one path rule
  for (const rule of pathPermissions) {
    const editTarget = rule.edit
    if (!editTarget) continue

    // Check if rule has no user/group constraints (open to all)
    const hasUserConstraint = !!editTarget.allowedUsers?.length
    const hasGroupConstraint = !!editTarget.allowedGroups?.length
    if (!hasUserConstraint && !hasGroupConstraint) {
      return { allowed: true, reason: 'open_path_rule' }
    }

    // Check if user matches the rule
    const matchesUser = hasUserConstraint && editTarget.allowedUsers?.includes(user.userId)
    const matchesGroup =
      hasGroupConstraint && user.groups?.some((gid) => editTarget.allowedGroups?.includes(gid))

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
  access?: BranchMetadata['access']
}

export const createBranch = async (
  ctx: ApiContext,
  req: ApiRequest<CreateBranchBody>
): Promise<BranchResponse> => {
  const branchName = req.body?.branch
  if (!branchName) {
    return { ok: false, status: 400, error: 'branch is required' }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'

  // Load path permissions from the main branch's JSON file
  const mainBranch = ctx.services.config.defaultBaseBranch ?? 'main'
  const mainBranchContext = await ctx.getBranchContext(mainBranch)

  let pathPermissions: PathPermission[] = []
  if (mainBranchContext) {
    const branchPaths = resolveBranchPaths(mainBranchContext, branchMode)
    pathPermissions = await loadPathPermissions(branchPaths.branchRoot)
  }

  // Check if user can create branches
  const canCreate = canCreateBranch(req.user, pathPermissions)
  if (!canCreate.allowed) {
    return { ok: false, status: 403, error: 'You do not have permission to create branches' }
  }

  const manager = new BranchWorkspaceManager(ctx.services.config)
  const context = await manager.openOrCreateBranch({
    branchName,
    mode: branchMode,
    createdBy: req.user.userId,
    title: req.body?.title,
    description: req.body?.description,
    access: req.body?.access,
  })
  return { ok: true, status: 200, data: { branch: context.branch } }
}

export const listBranches = async (
  ctx: ApiContext,
  req: ApiRequest
): Promise<BranchListResponse> => {
  const allBranches = await ctx.services.registry.list()

  // Admins and Reviewers see all branches
  if (isPrivileged(req.user.groups)) {
    return { ok: true, status: 200, data: { branches: allBranches.map((c) => c.branch) } }
  }

  // Regular users only see branches they created or have explicit access to
  const visibleBranches = allBranches.filter((context) => {
    const branch = context.branch
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
      branch.access?.allowedGroups?.some((groupId) => (req.user.groups as readonly string[])?.includes(groupId))
    ) {
      return true
    }
    return false
  })

  return { ok: true, status: 200, data: { branches: visibleBranches.map((c) => c.branch) } }
}

/**
 * Check if a user can delete a specific branch.
 * Returns true if user is Admin or the branch creator.
 */
export const canDeleteBranch = (
  user: CanopyUser,
  branchContext: BranchContext
): { allowed: boolean; reason: string } => {
  // Admins can delete any branch
  if (isAdmin(user.groups)) {
    return { allowed: true, reason: 'admin' }
  }

  // Branch creator can delete their own branch
  if (branchContext.branch.createdBy === user.userId) {
    return { allowed: true, reason: 'creator' }
  }

  return { allowed: false, reason: 'not_authorized' }
}

export const deleteBranch = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: { branch: string }
): Promise<BranchDeleteResponse> => {
  const branchName = params.branch
  if (!branchName) {
    return { ok: false, status: 400, error: 'branch is required' }
  }

  // Disallow delete in local-simple mode (branch = developer's git checkout)
  const branchMode = ctx.services.config.mode ?? 'local-simple'
  if (branchMode === 'local-simple') {
    return { ok: false, status: 400, error: 'Cannot delete branches in local-simple mode' }
  }

  // Get branch context
  const branchContext = await ctx.getBranchContext(branchName)
  if (!branchContext) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Check permission
  const canDelete = canDeleteBranch(req.user, branchContext)
  if (!canDelete.allowed) {
    return { ok: false, status: 403, error: 'You do not have permission to delete this branch' }
  }

  // Block deletion if branch has open PR (submitted status)
  if (branchContext.branch.status === 'submitted') {
    return { ok: false, status: 400, error: 'Cannot delete branch with open pull request' }
  }

  const branchPaths = resolveBranchPaths(branchContext, branchMode)

  // Delete branch metadata file so it disappears from registry scans
  const metadataFile = path.join(branchPaths.branchRoot, '.canopycms', 'branch.json')
  try {
    await fs.unlink(metadataFile)
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.error(`CanopyCMS: Failed to delete branch metadata for ${branchName}:`, err.message)
    }
  }

  // In multi-branch modes, also delete the entire branch directory
  if (branchPaths.branchRoot !== branchPaths.baseRoot) {
    try {
      await fs.rm(branchPaths.branchRoot, { recursive: true, force: true })
    } catch (err: any) {
      console.error(`CanopyCMS: Failed to delete branch directory for ${branchName}:`, err.message)
    }
  }

  // Invalidate registry cache so next list() will regenerate without this branch
  await ctx.services.registry.invalidate()

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
  user: CanopyUser,
  branchContext: BranchContext
): { allowed: boolean; reason: string } => {
  // Admins can modify any branch
  if (isAdmin(user.groups)) {
    return { allowed: true, reason: 'admin' }
  }

  // Branch creator can modify their own branch
  if (branchContext.branch.createdBy === user.userId) {
    return { allowed: true, reason: 'creator' }
  }

  return { allowed: false, reason: 'not_authorized' }
}

export const updateBranchAccess = async (
  ctx: ApiContext,
  req: ApiRequest<UpdateBranchAccessBody>,
  params: { branch: string }
): Promise<BranchResponse> => {
  const branchName = params.branch
  if (!branchName) {
    return { ok: false, status: 400, error: 'branch is required' }
  }

  // Get branch context
  const branchContext = await ctx.getBranchContext(branchName)
  if (!branchContext) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Check permission
  const canModify = canModifyBranchAccess(req.user, branchContext)
  if (!canModify.allowed) {
    return { ok: false, status: 403, error: 'You do not have permission to modify this branch' }
  }

  // Build new access control
  const newAccess: BranchAccessControl = {
    ...branchContext.branch.access,
  }
  if (req.body?.allowedUsers !== undefined) {
    newAccess.allowedUsers = req.body.allowedUsers
  }
  if (req.body?.allowedGroups !== undefined) {
    newAccess.allowedGroups = req.body.allowedGroups
  }

  // Update metadata (automatically invalidates registry cache)
  const metadata = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)
  const updated = await metadata.save({
    branch: { access: newAccess },
  })

  return { ok: true, status: 200, data: { branch: updated.branch } }
}
