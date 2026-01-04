import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { PathPermission } from '../config'
import { loadPathPermissions, savePathPermissions } from '../permissions-loader'
import { resolveBranchPaths } from '../paths'
import { isAdmin, isReviewer } from '../reserved-groups'

/** Response type for getting permissions */
export type PermissionsResponse = ApiResponse<{ permissions: PathPermission[] }>

/**
 * Get current permissions (admin only)
 */
export const getPermissions = async (
  ctx: ApiContext,
  req: ApiRequest<undefined>
): Promise<PermissionsResponse> => {
  // Check admin permission
  if (!isAdmin(req.user.groups)) {
    return { ok: false, status: 403, error: 'Admin access required' }
  }

  try {
    // Load from main branch
    const mainBranch = ctx.services.config.defaultBaseBranch ?? 'main'
    const context = await ctx.getBranchContext(mainBranch)

    if (!context) {
      return { ok: false, status: 500, error: 'Main branch not found' }
    }

    const branchMode = ctx.services.config.mode ?? 'local-simple'
    const branchPaths = resolveBranchPaths(context, branchMode)
    const permissions = await loadPathPermissions(branchPaths.branchRoot)

    return {
      ok: true,
      status: 200,
      data: { permissions },
    }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : 'Failed to load permissions',
    }
  }
}

export interface UpdatePermissionsBody {
  permissions: PathPermission[]
}

/**
 * Update permissions (admin only)
 */
export const updatePermissions = async (
  ctx: ApiContext,
  req: ApiRequest<UpdatePermissionsBody>
): Promise<ApiResponse> => {
  // Check admin permission
  if (!isAdmin(req.user.groups)) {
    return { ok: false, status: 403, error: 'Admin access required' }
  }

  if (!req.body?.permissions) {
    return { ok: false, status: 400, error: 'permissions array required' }
  }

  try {
    // Save to main branch
    const mainBranch = ctx.services.config.defaultBaseBranch ?? 'main'
    const context = await ctx.getBranchContext(mainBranch)

    if (!context) {
      return { ok: false, status: 500, error: 'Main branch not found' }
    }

    const branchMode = ctx.services.config.mode ?? 'local-simple'
    const branchPaths = resolveBranchPaths(context, branchMode)

    await savePathPermissions(branchPaths.branchRoot, req.body.permissions, req.user.userId)

    // Commit the change
    if (ctx.services.createGitManagerFor) {
      const git = ctx.services.createGitManagerFor(branchPaths.branchRoot)
      await git.add('.canopycms/permissions.json')
      await git.commit('Update permissions', {
        name: ctx.services.config.gitBotAuthorName,
        email: ctx.services.config.gitBotAuthorEmail,
      })
    }

    return { ok: true, status: 200 }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : 'Failed to save permissions',
    }
  }
}

/**
 * Search users (for permission UI)
 */
export interface SearchUsersParams {
  query: string
  limit?: number
}

export const searchUsers = async (
  ctx: ApiContext,
  req: ApiRequest<undefined>,
  params: SearchUsersParams
): Promise<ApiResponse> => {
  // Require admin or reviewer for user search
  if (!isAdmin(req.user.groups) && !isReviewer(req.user.groups)) {
    return { ok: false, status: 403, error: 'Admin or Reviewer access required' }
  }

  const authPlugin = ctx.authPlugin
  if (!authPlugin) {
    return { ok: false, status: 501, error: 'Auth plugin not configured' }
  }

  try {
    const users = await authPlugin.searchUsers(params.query, params.limit)
    return { ok: true, status: 200, data: { users } }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : 'User search failed',
    }
  }
}

/**
 * List groups (for permission UI)
 */
export const listGroups = async (
  ctx: ApiContext,
  req: ApiRequest<undefined>
): Promise<ApiResponse> => {
  // Require admin or reviewer for group list
  if (!isAdmin(req.user.groups) && !isReviewer(req.user.groups)) {
    return { ok: false, status: 403, error: 'Admin or Reviewer access required' }
  }

  const authPlugin = ctx.authPlugin
  if (!authPlugin) {
    return { ok: false, status: 501, error: 'Auth plugin not configured' }
  }

  try {
    const groups = await authPlugin.listGroups()
    return { ok: true, status: 200, data: { groups } }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : 'Group list failed',
    }
  }
}
