import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { PathPermission } from '../config'
import { loadPathPermissions, savePathPermissions } from '../permissions-loader'
import { isAdmin, isReviewer } from '../reserved-groups'
import { defineEndpoint } from './route-builder'

/** Response type for getting permissions */
export type PermissionsResponse = ApiResponse<{ permissions: PathPermission[] }>

/** Response type for user search */
export type SearchUsersResponse = ApiResponse<{ users: any[] }>

/** Response type for list groups */
export type ListGroupsResponse = ApiResponse<{ groups: any[] }>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const updatePermissionsBodySchema = z.object({
  permissions: z.array(z.any()), // PathPermission type is complex, using any for now
})

const searchUsersParamsSchema = z.object({
  q: z.string(),
  limit: z.string().optional(),
})

export type UpdatePermissionsBody = z.infer<typeof updatePermissionsBodySchema>
export type SearchUsersParams = z.infer<typeof searchUsersParamsSchema>

/**
 * Get current permissions (admin only)
 */
const getPermissionsHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
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

    const permissions = await loadPathPermissions(context.branchRoot)

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

/**
 * Update permissions (admin only)
 */
const updatePermissionsHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  body: z.infer<typeof updatePermissionsBodySchema>,
): Promise<ApiResponse> => {
  // Check admin permission
  if (!isAdmin(req.user.groups)) {
    return { ok: false, status: 403, error: 'Admin access required' }
  }

  if (!body?.permissions) {
    return { ok: false, status: 400, error: 'permissions array required' }
  }

  try {
    // Save to main branch
    const mainBranch = ctx.services.config.defaultBaseBranch ?? 'main'
    const context = await ctx.getBranchContext(mainBranch)

    if (!context) {
      return { ok: false, status: 500, error: 'Main branch not found' }
    }

    await savePathPermissions(context.branchRoot, body.permissions, req.user.userId)

    // Commit the change
    await ctx.services.commitFiles({
      context,
      files: '.canopycms/permissions.json',
      message: 'Update permissions',
    })

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
const searchUsersHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof searchUsersParamsSchema>,
): Promise<SearchUsersResponse> => {
  // Require admin or reviewer for user search
  if (!isAdmin(req.user.groups) && !isReviewer(req.user.groups)) {
    return { ok: false, status: 403, error: 'Admin or Reviewer access required' }
  }

  const authPlugin = ctx.authPlugin
  if (!authPlugin) {
    return { ok: false, status: 501, error: 'Auth plugin not configured' }
  }

  const query = params.q
  const limit = params.limit ? parseInt(params.limit, 10) : undefined

  try {
    const users = await authPlugin.searchUsers(query, limit)
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
const listGroupsHandler = async (ctx: ApiContext, req: ApiRequest): Promise<ListGroupsResponse> => {
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

// ============================================================================
// Route Definitions with defineEndpoint
// ============================================================================

/**
 * Get current permissions (admin only)
 * GET /permissions
 */
const getPermissions = defineEndpoint({
  namespace: 'permissions',
  name: 'get',
  method: 'GET',
  path: '/permissions',
  responseType: 'PermissionsResponse',
  response: {} as PermissionsResponse,
  defaultMockData: { permissions: [] },
  handler: getPermissionsHandler,
})

/**
 * Update permissions (admin only)
 * PUT /permissions
 */
const updatePermissions = defineEndpoint({
  namespace: 'permissions',
  name: 'update',
  method: 'PUT',
  path: '/permissions',
  body: updatePermissionsBodySchema,
  responseType: 'PermissionsResponse',
  response: {} as PermissionsResponse,
  defaultMockData: { permissions: [] },
  handler: updatePermissionsHandler,
})

/**
 * Search for users (admin/reviewer only)
 * GET /users/search?q=...
 */
const searchUsers = defineEndpoint({
  namespace: 'permissions',
  name: 'searchUsers',
  method: 'GET',
  path: '/users/search',
  params: searchUsersParamsSchema,
  responseType: 'SearchUsersResponse',
  response: {} as SearchUsersResponse,
  defaultMockData: { users: [] },
  handler: searchUsersHandler,
})

/**
 * List groups (admin/reviewer only)
 * GET /groups
 */
const listGroups = defineEndpoint({
  namespace: 'permissions',
  name: 'listGroups',
  method: 'GET',
  path: '/groups',
  responseType: 'ListGroupsResponse',
  response: {} as ListGroupsResponse,
  defaultMockData: { groups: [] },
  handler: listGroupsHandler,
})

/**
 * Exported routes for router registration
 */
export const PERMISSION_ROUTES = {
  get: getPermissions,
  update: updatePermissions,
  searchUsers: searchUsers,
  listGroups: listGroups,
} as const
