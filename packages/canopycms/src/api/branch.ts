import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import type { BranchAccessControl, BranchContext, BranchMetadata } from '../types'
import { BranchWorkspaceManager } from '../branch-workspace'
import { getBranchMetadataFileManager } from '../branch-metadata'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { defineEndpoint } from './route-builder'
import { createDebugLogger } from '../utils/debug'
import { clientOperatingStrategy } from '../operating-mode'
import { isNotFoundError, getErrorMessage } from '../utils/error'
import { branchNameSchema } from './validators'

const log = createDebugLogger({ prefix: 'BranchAPI' })

/** Response type for single branch operations (create, update, status) */
export type BranchResponse = ApiResponse<{ branch: BranchMetadata }>

/** Response type for listing branches */
export type BranchListResponse = ApiResponse<{ branches: BranchMetadata[] }>

/** Response type for branch deletion */
export type BranchDeleteResponse = ApiResponse<{ deleted: boolean }>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const branchParamSchema = z.object({
  branch: branchNameSchema,
})

const createBranchBodySchema = z.object({
  branch: branchNameSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  access: z
    .object({
      allowedUsers: z.array(z.string()).optional(),
      allowedGroups: z.array(z.string()).optional(),
    })
    .optional(),
})

const updateBranchAccessBodySchema = z.object({
  allowedUsers: z.array(z.string()).optional(),
  allowedGroups: z.array(z.string()).optional(),
})

import { isPrivileged, isAdmin, loadPathPermissions } from '../authorization'
import type { PathPermission } from '../config'
import type { CanopyUser } from '../user'
import { operatingStrategy } from '../operating-mode'

/**
 * Check if a user can create branches.
 * Returns true if:
 * - User is Admin or Reviewer (privileged)
 * - User has edit access to at least one path via pathPermissions rules
 * - No path permissions are defined (open access)
 */
export const canCreateBranch = (
  user: CanopyUser,
  pathPermissions: PathPermission[],
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

export const createBranchHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  body: z.infer<typeof createBranchBodySchema>,
): Promise<BranchResponse> => {
  return log.timed('api', 'createBranch', async () => {
    const branchName = body.branch
    log.debug('api', 'Create branch request', {
      branchName,
      userId: req.user.userId,
    })

    // Prevent git branch name collision with settings branch
    // Settings live in separate directory but share same git remote
    const strategy = operatingStrategy(ctx.services.config.mode)
    if (strategy.usesSeparateSettingsBranch()) {
      const settingsBranchName = strategy.getSettingsBranchName(ctx.services.config)
      if (branchName === settingsBranchName) {
        return {
          ok: false,
          status: 400,
          error:
            'Cannot create content branch with settings branch name (git branch name collision)',
        }
      }
    }

    // Load path permissions from the main branch's JSON file
    const mainBranch = ctx.services.config.defaultBaseBranch ?? 'main'
    const mainBranchContext = await ctx.getBranchContext(mainBranch)

    let pathPermissions: PathPermission[] = []
    if (mainBranchContext) {
      const operatingMode = ctx.services.config.mode
      pathPermissions = await loadPathPermissions(mainBranchContext.branchRoot, operatingMode)
    }

    // Check if user can create branches
    const canCreate = canCreateBranch(req.user, pathPermissions)
    if (!canCreate.allowed) {
      log.debug('api', 'Permission denied', { reason: canCreate.reason })
      return {
        ok: false,
        status: 403,
        error: 'You do not have permission to create branches',
      }
    }

    const manager = new BranchWorkspaceManager(ctx.services.config)
    const operatingMode = ctx.services.config.mode
    const context = await manager.openOrCreateBranch({
      branchName,
      mode: operatingMode,
      createdBy: req.user.userId,
      title: body.title,
      description: body.description,
      access: body.access,
    })

    log.debug('api', 'Branch created', { branchName: context.branch.name })
    return { ok: true, status: 200, data: { branch: context.branch } }
  })
}

export const listBranchesHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
): Promise<BranchListResponse> => {
  if (!ctx.services.registry) {
    return {
      ok: false,
      status: 400,
      error: 'Branch registry not initialized for this operating mode',
    }
  }

  const allBranches = await ctx.services.registry.list()

  // Admins and Reviewers see all branches
  if (isPrivileged(req.user.groups)) {
    return {
      ok: true,
      status: 200,
      data: { branches: allBranches.map((c) => c.branch) },
    }
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
      branch.access?.allowedGroups?.some((groupId) =>
        (req.user.groups as readonly string[])?.includes(groupId),
      )
    ) {
      return true
    }
    return false
  })

  return {
    ok: true,
    status: 200,
    data: { branches: visibleBranches.map((c) => c.branch) },
  }
}

/**
 * Check if a user can delete a specific branch.
 * Returns true if user is Admin or the branch creator.
 */
export const canDeleteBranch = (
  user: CanopyUser,
  branchContext: BranchContext,
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

export const deleteBranchHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamSchema>,
): Promise<BranchDeleteResponse> => {
  const branchName = params.branch

  // Disallow delete in modes that don't support branching (branch = developer's git checkout)
  const operatingMode = ctx.services.config.mode
  if (!clientOperatingStrategy(operatingMode).supportsBranching()) {
    return {
      ok: false,
      status: 400,
      error: 'Cannot delete branches in this operating mode',
    }
  }

  // Get branch context
  const branchContext = await ctx.getBranchContext(branchName)
  if (!branchContext) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Check permission
  const canDelete = canDeleteBranch(req.user, branchContext)
  if (!canDelete.allowed) {
    return {
      ok: false,
      status: 403,
      error: 'You do not have permission to delete this branch',
    }
  }

  // Block deletion if branch has open PR (submitted status)
  if (branchContext.branch.status === 'submitted') {
    return {
      ok: false,
      status: 400,
      error: 'Cannot delete branch with open pull request',
    }
  }

  // Delete branch metadata file so it disappears from registry scans
  const metadataFile = path.join(branchContext.branchRoot, '.canopy-meta', 'branch.json')
  try {
    await fs.unlink(metadataFile)
  } catch (err: unknown) {
    if (!isNotFoundError(err)) {
      console.error(
        `CanopyCMS: Failed to delete branch metadata for ${branchName}:`,
        getErrorMessage(err),
      )
    }
  }

  // In multi-branch modes, also delete the entire branch directory
  if (branchContext.branchRoot !== branchContext.baseRoot) {
    try {
      await fs.rm(branchContext.branchRoot, { recursive: true, force: true })
    } catch (err: unknown) {
      console.error(
        `CanopyCMS: Failed to delete branch directory for ${branchName}:`,
        getErrorMessage(err),
      )
    }
  }

  // Invalidate registry cache so next list() will regenerate without this branch
  if (!ctx.services.registry) {
    return {
      ok: false,
      status: 400,
      error: 'Branch operations not available in dev mode',
    }
  }
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
  branchContext: BranchContext,
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

export const updateBranchAccessHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamSchema>,
  body: z.infer<typeof updateBranchAccessBodySchema>,
): Promise<BranchResponse> => {
  const branchName = params.branch

  // Get branch context
  const branchContext = await ctx.getBranchContext(branchName)
  if (!branchContext) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Check permission
  const canModify = canModifyBranchAccess(req.user, branchContext)
  if (!canModify.allowed) {
    return {
      ok: false,
      status: 403,
      error: 'You do not have permission to modify this branch',
    }
  }

  // Build new access control
  const newAccess: BranchAccessControl = {
    ...branchContext.branch.access,
  }
  if (body.allowedUsers !== undefined) {
    newAccess.allowedUsers = body.allowedUsers
  }
  if (body.allowedGroups !== undefined) {
    newAccess.allowedGroups = body.allowedGroups
  }

  // Update metadata (automatically invalidates registry cache)
  const metadata = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)
  const updated = await metadata.save({
    branch: { access: newAccess },
  })

  return { ok: true, status: 200, data: { branch: updated.branch } }
}

// ============================================================================
// Route Definitions with defineEndpoint
// ============================================================================

/**
 * List all branches visible to current user
 * GET /branches
 */
const listBranches = defineEndpoint({
  namespace: 'branches',
  name: 'list',
  method: 'GET',
  path: '/branches',
  responseType: 'BranchListResponse',
  response: {} as BranchListResponse,
  defaultMockData: { branches: [] },
  handler: listBranchesHandler,
})

/**
 * Create a new branch
 * POST /branches
 */
const createBranch = defineEndpoint({
  namespace: 'branches',
  name: 'create',
  method: 'POST',
  path: '/branches',
  body: createBranchBodySchema,
  bodyType: 'CreateBranchBody',
  responseType: 'BranchResponse',
  response: {} as BranchResponse,
  defaultMockData: {
    branch: {
      name: 'test-branch',
      status: 'editing',
      access: {},
      createdBy: 'user-1',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
  },
  handler: createBranchHandler,
})

/**
 * Delete a branch
 * DELETE /:branch
 */
const deleteBranch = defineEndpoint({
  namespace: 'branches',
  name: 'delete',
  method: 'DELETE',
  path: '/:branch',
  params: branchParamSchema,
  responseType: 'BranchDeleteResponse',
  response: {} as BranchDeleteResponse,
  defaultMockData: { deleted: true },
  handler: deleteBranchHandler,
})

/**
 * Update branch access control
 * PATCH /:branch/access
 */
const updateBranchAccess = defineEndpoint({
  namespace: 'branches',
  name: 'updateAccess',
  method: 'PATCH',
  path: '/:branch/access',
  params: branchParamSchema,
  body: updateBranchAccessBodySchema,
  bodyType: 'UpdateBranchAccessBody',
  responseType: 'BranchResponse',
  response: {} as BranchResponse,
  defaultMockData: {
    branch: {
      name: 'test-branch',
      status: 'editing',
      access: {},
      createdBy: 'user-1',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
  },
  handler: updateBranchAccessHandler,
})

/**
 * Exported routes for router registration
 */
export const BRANCH_ROUTES = {
  list: listBranches,
  create: createBranch,
  delete: deleteBranch,
  updateAccess: updateBranchAccess,
} as const
