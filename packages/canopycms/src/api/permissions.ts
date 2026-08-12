import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { PathPermission } from '../config'
import type { UserSearchResult, PermissionGroupOption } from '../auth/types'
import {
  loadPermissionsFile,
  mutatePermissionsFile,
  loadGroupsFile,
  deriveInternalGroups,
  SettingsVersionConflictError,
  SettingsFileConflictError,
} from '../authorization'
import { permissionPathSchema } from './validators'
import { MAX_ENTRIES_PER_PAGE } from './entries-constants'
import { defineEndpoint } from './route-builder'
import { getSettingsBranchContext, commitSettings } from './settings-helpers'
import { getErrorMessage, sanitizeErrorMessage } from '../utils/error'

/** Response type for getting permissions */
export type PermissionsResponse = ApiResponse<{ permissions: PathPermission[]; version: number }>

/** Response type for user search */
export type SearchUsersResponse = ApiResponse<{ users: UserSearchResult[] }>

/** Response type for list groups */
export type ListGroupsResponse = ApiResponse<{ groups: PermissionGroupOption[] }>

/** Response type for get user metadata */
export type GetUserMetadataResponse = ApiResponse<{
  user: UserSearchResult | null
}>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const permissionTargetSchema = z.object({
  allowedUsers: z.array(z.string()).optional(),
  allowedGroups: z.array(z.string()).optional(),
})

const pathPermissionSchema = z.object({
  path: permissionPathSchema,
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
  // Coerced + range-checked (consistent with api/entries.ts's listEntriesParamsSchema)
  // rather than z.string() + an unchecked parseInt(), which silently produced NaN
  // for a non-numeric limit (API-M2). Capped like listEntries so a caller cannot
  // request an unbounded page from the auth provider.
  limit: z.coerce.number().int().min(1).max(MAX_ENTRIES_PER_PAGE).optional(),
})

const getUserMetadataParamsSchema = z.object({
  userId: z.string(),
})

export type UpdatePermissionsBody = z.infer<typeof updatePermissionsBodySchema>
export type SearchUsersParams = z.infer<typeof searchUsersParamsSchema>
export type GetUserMetadataParams = z.infer<typeof getUserMetadataParamsSchema>

/**
 * Get current permissions (admin only)
 */
const getPermissionsHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  _req: ApiRequest,
): Promise<PermissionsResponse> => {
  try {
    const result = await getSettingsBranchContext(ctx)
    if ('error' in result) {
      return { ok: false, status: result.status, error: result.error }
    }

    const { context, mode } = result
    const file = await loadPermissionsFile(context.branchRoot, mode)

    return {
      ok: true,
      status: 200,
      data: { permissions: file?.pathPermissions ?? [], version: file?.version ?? 0 },
    }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: sanitizeErrorMessage(getErrorMessage(error)),
    }
  }
}

/**
 * Update permissions (admin only)
 */
const updatePermissionsHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  req: ApiRequest,
  body: z.infer<typeof updatePermissionsBodySchema>,
): Promise<ApiResponse> => {
  if (!body?.permissions) {
    return { ok: false, status: 400, error: 'permissions array required' }
  }

  try {
    const result = await getSettingsBranchContext(ctx)
    if ('error' in result) {
      return { ok: false, status: result.status, error: result.error }
    }

    const { context, mode } = result

    // Load -> compare -> write happens atomically under the cross-host
    // layered lock (see authorization/settings-file-store.ts) — no separate
    // pre-read here, so there's no TOCTOU window between the version check
    // and the write.
    await mutatePermissionsFile(context.branchRoot, mode, (_current, version) => {
      if (body.expectedContentVersion !== undefined && body.expectedContentVersion !== version) {
        throw new SettingsVersionConflictError(
          'Permissions were modified by another user. Please reload and try again.',
        )
      }

      return {
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.userId,
        pathPermissions: body.permissions,
      }
    })

    // Commit and push (mode-aware). A push failure means the change is saved
    // to the branch working tree but NOT durably persisted (API-H1) - surface
    // that to the client instead of reporting a bare 200.
    const commitResult = await commitSettings(ctx, {
      context,
      branchRoot: context.branchRoot,
      fileName: 'permissions.json',
      message: 'Update permissions',
      mode,
    })

    if (!commitResult.pushed) {
      return {
        ok: false,
        status: 502,
        error: `Permissions were saved but failed to sync to git: ${commitResult.error ?? 'unknown error'}`,
      }
    }

    return { ok: true, status: 200, data: {} }
  } catch (error) {
    if (error instanceof SettingsVersionConflictError) {
      return { ok: false, status: 409, error: error.message }
    }
    if (error instanceof SettingsFileConflictError) {
      return { ok: false, status: 409, error: 'Settings are busy, please try again.' }
    }
    return {
      ok: false,
      status: 500,
      error: sanitizeErrorMessage(getErrorMessage(error)),
    }
  }
}

/**
 * Search users (for permission UI)
 */
const searchUsersHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof searchUsersParamsSchema>,
): Promise<SearchUsersResponse> => {
  const authPlugin = ctx.authPlugin
  if (!authPlugin) {
    return { ok: false, status: 501, error: 'Auth plugin not configured' }
  }

  const query = params.q
  const limit = params.limit

  try {
    const users = await authPlugin.searchUsers(query, limit)
    return { ok: true, status: 200, data: { users } }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: sanitizeErrorMessage(getErrorMessage(error)),
    }
  }
}

/**
 * List groups (for permission UI)
 *
 * Merges BOTH group universes, because both are valid `allowedGroups` targets:
 * the auth provider's groups and Canopy's own internal groups from groups.json
 * (see PermissionGroupOption in auth/types.ts). Feeding this endpoint from the
 * auth plugin alone made internally-created groups unreachable from the
 * Permission Manager's picker -- they could only be granted a path permission
 * by hand-editing permissions.json.
 *
 * Internal entries are name-only (no members, no memberCount): this endpoint is
 * `privileged` (admin or reviewer) whereas `groups.getInternal` is admin-only,
 * so member identities and counts must not leak through here.
 */
const listGroupsHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  _req: ApiRequest,
): Promise<ListGroupsResponse> => {
  const authPlugin = ctx.authPlugin
  if (!authPlugin) {
    return { ok: false, status: 501, error: 'Auth plugin not configured' }
  }

  try {
    const externalGroups = await authPlugin.listGroups()

    const result = await getSettingsBranchContext(ctx)
    if ('error' in result) {
      return { ok: false, status: result.status, error: result.error }
    }

    const { context, mode } = result
    const file = await loadGroupsFile(context.branchRoot, mode)
    const internalGroups = deriveInternalGroups(file?.groups ?? [], ctx.services.bootstrapAdminIds)

    // Deduplicate by ID, internal first so it wins a collision. The two ID
    // spaces are not namespaced against each other, but `checkPathPermission`
    // matches `allowedGroups` by ID string against one flattened `user.groups`
    // list -- so two same-ID groups ARE a single permission target, and
    // emitting both would misrepresent what enforcement actually does.
    // (Reserved IDs can never arrive from the provider: stripReservedGroups in
    // user.ts removes them before they reach `user.groups`.)
    const byId = new Map<string, PermissionGroupOption>()

    for (const group of internalGroups) {
      byId.set(group.id, {
        id: group.id,
        name: group.name,
        description: group.description,
        source: 'internal',
      })
    }

    for (const group of externalGroups) {
      if (!byId.has(group.id)) {
        byId.set(group.id, { ...group, source: 'external' })
      }
    }

    return { ok: true, status: 200, data: { groups: Array.from(byId.values()) } }
  } catch (error) {
    // Deliberately NOT degrading to an external-only list on a groups.json read
    // failure: a silently incomplete picker is the exact bug this merge fixes.
    return {
      ok: false,
      status: 500,
      error: sanitizeErrorMessage(getErrorMessage(error)),
    }
  }
}

/**
 * Get user metadata by ID (for UI display)
 */
const getUserMetadataHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof getUserMetadataParamsSchema>,
): Promise<GetUserMetadataResponse> => {
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
      error: sanitizeErrorMessage(getErrorMessage(error)),
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
  defaultMockData: { permissions: [], version: 0 },
  guards: ['admin'] as const,
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
  guards: ['admin'] as const,
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
  guards: ['privileged'] as const,
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
  guards: ['privileged'] as const,
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
  guards: ['privileged'] as const,
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
