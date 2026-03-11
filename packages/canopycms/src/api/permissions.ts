import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { PathPermission } from '../config'
import type { UserSearchResult } from '../auth/types'
import { loadPathPermissions, savePathPermissions, loadPermissionsFile, isAdmin, isReviewer, toPermissionPath } from '../authorization'
import { defineEndpoint } from './route-builder'
import { getSettingsBranchContext, commitSettings } from './settings-helpers'

/** Response type for getting permissions */
export type PermissionsResponse = ApiResponse<{ permissions: PathPermission[] }>

/** Response type for user search */
export type SearchUsersResponse = ApiResponse<{ users: any[] }>

/** Response type for list groups */
export type ListGroupsResponse = ApiResponse<{ groups: any[] }>

/** Response type for get user metadata */
export type GetUserMetadataResponse = ApiResponse<{ user: UserSearchResult | null }>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const permissionTargetSchema = z.object({
  allowedUsers: z.array(z.string()).optional(),
  allowedGroups: z.array(z.string()).optional(),
})

const pathPermissionSchema = z.object({
  path: z.string().min(1).transform(toPermissionPath),
  read: permissionTargetSchema.optional(),
  edit: permissionTargetSchema.optional(),
  review: permissionTargetSchema.optional(),
})

const updatePermissionsBodySchema = z.object({
  permissions: z.array(pathPermissionSchema),
  expectedContentVersion: z.number().optional(),
})

const searchUsersParamsSchema = z.object({
  q: z.string(),
  limit: z.string().optional()
})

const getUserMetadataParamsSchema = z.object({
  userId: z.string()
})

export type UpdatePermissionsBody = z.infer<typeof updatePermissionsBodySchema>
export type SearchUsersParams = z.infer<typeof searchUsersParamsSchema>
export type GetUserMetadataParams = z.infer<typeof getUserMetadataParamsSchema>

/**
 * Get current permissions (admin only)
 */
const getPermissionsHandler = async (
  ctx: ApiContext,
  req: ApiRequest
): Promise<PermissionsResponse> => {
  // Check admin permission
  if (!isAdmin(req.user.groups)) {
    return { ok: false, status: 403, error: 'Admin access required' }
  }

  try {
    const result = await getSettingsBranchContext(ctx)
    if ('error' in result) {
      return { ok: false, status: result.status, error: result.error }
    }

    const { context, mode } = result
    const permissions = await loadPathPermissions(context.branchRoot, mode)

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
  body: z.infer<typeof updatePermissionsBodySchema>
): Promise<ApiResponse> => {
  // Check admin permission
  if (!isAdmin(req.user.groups)) {
    return { ok: false, status: 403, error: 'Admin access required' }
  }

  if (!body?.permissions) {
    return { ok: false, status: 400, error: 'permissions array required' }
  }

  try {
    const result = await getSettingsBranchContext(ctx)
    if ('error' in result) {
      return { ok: false, status: result.status, error: result.error }
    }

    const { context, mode } = result

    // Load current file to check version (optimistic locking)
    const currentFile = await loadPermissionsFile(context.branchRoot, mode)

    // Check for version conflict if client sent expected version
    if (body.expectedContentVersion !== undefined) {
      const currentVersion = currentFile?.contentVersion ?? 0
      if (currentVersion !== body.expectedContentVersion) {
        return {
          ok: false,
          status: 409,
          error: 'Permissions were modified by another user. Please reload and try again.',
        }
      }
    }

    // Increment version when saving
    const newContentVersion = (currentFile?.contentVersion ?? 0) + 1

    // Save file (uses mode-aware file path)
    await savePathPermissions(context.branchRoot, body.permissions, req.user.userId, mode, newContentVersion)

    // Commit and push (mode-aware)
    await commitSettings(ctx, {
      context,
      branchRoot: context.branchRoot,
      fileName: 'permissions.json',
      message: 'Update permissions',
      mode,
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
  params: z.infer<typeof searchUsersParamsSchema>
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
const listGroupsHandler = async (
  ctx: ApiContext,
  req: ApiRequest
): Promise<ListGroupsResponse> => {
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

/**
 * Get user metadata by ID (for UI display)
 */
const getUserMetadataHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof getUserMetadataParamsSchema>
): Promise<GetUserMetadataResponse> => {
  // Require admin or reviewer for user metadata
  if (!isAdmin(req.user.groups) && !isReviewer(req.user.groups)) {
    return { ok: false, status: 403, error: 'Admin or Reviewer access required' }
  }

  const authPlugin = ctx.authPlugin
  if (!authPlugin) {
    return { ok: false, status: 501, error: 'Auth plugin not configured' }
  }

  try {
    const user = await authPlugin.getUserMetadata(params.userId)
    return { ok: true, status: 200, data: { user } }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : 'Failed to get user metadata',
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
  bodyType: 'UpdatePermissionsBody',
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
 * Get user metadata by ID (admin/reviewer only)
 * GET /users/:userId
 */
const getUserMetadata = defineEndpoint({
  namespace: 'permissions',
  name: 'getUserMetadata',
  method: 'GET',
  path: '/users/:userId',
  params: getUserMetadataParamsSchema,
  responseType: 'GetUserMetadataResponse',
  response: {} as GetUserMetadataResponse,
  defaultMockData: { user: null },
  handler: getUserMetadataHandler,
})

/**
 * Exported routes for router registration
 */
export const PERMISSION_ROUTES = {
  get: getPermissions,
  update: updatePermissions,
  searchUsers: searchUsers,
  listGroups: listGroups,
  getUserMetadata: getUserMetadata,
} as const
