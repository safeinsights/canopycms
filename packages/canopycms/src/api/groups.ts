import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { InternalGroup } from '../groups-file'
import { loadInternalGroups, saveInternalGroups } from '../groups-loader'
import { resolveBranchPaths } from '../paths'
import type { CanopyGroupId } from '../types'
import { isAdmin, RESERVED_GROUPS, isReservedGroup } from '../reserved-groups'
import { defineEndpoint } from './route-builder'

/** Response type for getting internal groups */
export type InternalGroupsResponse = ApiResponse<{ groups: InternalGroup[] }>

/** Response type for updating internal groups */
export type UpdateInternalGroupsResponse = ApiResponse<Record<string, never>>

/** Response type for searching external groups */
export type ExternalGroupsResponse = ApiResponse<{ groups: ExternalGroup[] }>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const internalGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  members: z.array(z.string()),
})

const updateInternalGroupsBodySchema = z.object({
  groups: z.array(internalGroupSchema)
})

const searchExternalGroupsParamsSchema = z.object({
  query: z.string()
})

/**
 * Validate that an update to internal groups doesn't remove the last admin.
 * Considers both internal Admins group members and bootstrap admins.
 */
export const validateAdminGroupUpdate = (
  newGroups: InternalGroup[],
  bootstrapAdminIds: Set<string>
): { valid: boolean; error?: string } => {
  // Find the Admins group in the new groups
  const adminsGroup = newGroups.find((g) => g.id === RESERVED_GROUPS.ADMINS)
  const adminMembersCount = adminsGroup?.members?.length ?? 0

  // Total admins = internal Admins group members + bootstrap admins (excluding overlap)
  const internalAdmins = new Set(adminsGroup?.members ?? [])
  let totalAdmins = adminMembersCount

  // Add bootstrap admins that aren't already in the internal group
  for (const bootstrapId of bootstrapAdminIds) {
    if (!internalAdmins.has(bootstrapId)) {
      totalAdmins++
    }
  }

  if (totalAdmins === 0) {
    return { valid: false, error: 'Cannot remove last admin - at least one admin is required' }
  }

  return { valid: true }
}

/**
 * Validate that reserved groups are not deleted or renamed.
 */
export const validateReservedGroups = (
  newGroups: InternalGroup[]
): { valid: boolean; error?: string } => {
  // Check if any reserved group IDs have been altered
  for (const group of newGroups) {
    if (isReservedGroup(group.id)) {
      // Reserved group exists - make sure the name matches the ID
      if (group.name !== group.id) {
        return { valid: false, error: `Reserved group '${group.id}' cannot be renamed` }
      }
    }
  }

  return { valid: true }
}

/**
 * Get internal groups (admin only)
 */
const getInternalGroupsHandler = async (
  ctx: ApiContext,
  req: ApiRequest
): Promise<InternalGroupsResponse> => {
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
    const groups = await loadInternalGroups(branchPaths.branchRoot)

    return {
      ok: true,
      status: 200,
      data: { groups },
    }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : 'Failed to load groups',
    }
  }
}

export interface UpdateInternalGroupsBody {
  groups: InternalGroup[]
}

/**
 * Update internal groups (admin only)
 */
const updateInternalGroupsHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  body: z.infer<typeof updateInternalGroupsBodySchema>
): Promise<UpdateInternalGroupsResponse> => {
  // Check admin permission
  if (!isAdmin(req.user.groups)) {
    return { ok: false, status: 403, error: 'Admin access required' }
  }

  if (!body?.groups) {
    return { ok: false, status: 400, error: 'groups array required' }
  }

  // Validate reserved groups are not renamed
  const reservedValidation = validateReservedGroups(body.groups)
  if (!reservedValidation.valid) {
    return { ok: false, status: 400, error: reservedValidation.error }
  }

  // Validate we're not removing the last admin
  const adminValidation = validateAdminGroupUpdate(body.groups, ctx.services.bootstrapAdminIds)
  if (!adminValidation.valid) {
    return { ok: false, status: 400, error: adminValidation.error }
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

    await saveInternalGroups(branchPaths.branchRoot, body.groups, req.user.userId)

    // Commit the change
    if (ctx.services.createGitManagerFor) {
      const git = ctx.services.createGitManagerFor(branchPaths.branchRoot)
      await git.add('.canopycms/groups.json')
      await git.commit('Update internal groups', {
        name: ctx.services.config.gitBotAuthorName,
        email: ctx.services.config.gitBotAuthorEmail,
      })
    }

    return { ok: true, status: 200 }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : 'Failed to save groups',
    }
  }
}

/**
 * Search external groups (for group UI)
 */
export interface SearchExternalGroupsParams {
  query: string
}

export interface ExternalGroup {
  id: CanopyGroupId
  name: string
}

const searchExternalGroupsHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof searchExternalGroupsParamsSchema>
): Promise<ExternalGroupsResponse> => {
  // Require admin for external group search
  if (!isAdmin(req.user.groups)) {
    return { ok: false, status: 403, error: 'Admin access required' }
  }

  const authPlugin = ctx.authPlugin
  if (!authPlugin || !authPlugin.searchExternalGroups) {
    return { ok: false, status: 501, error: 'External group search not configured' }
  }

  try {
    const groups = await authPlugin.searchExternalGroups(params.query)
    return { ok: true, status: 200, data: { groups } }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : 'External group search failed',
    }
  }
}

// ============================================================================
// Route Definitions with defineEndpoint
// ============================================================================

/**
 * Get internal groups
 * GET /groups/internal
 */
const getInternal = defineEndpoint({
  namespace: 'groups',
  name: 'getInternal',
  method: 'GET',
  path: '/groups/internal',
  responseType: 'InternalGroupsResponse',
  response: {} as InternalGroupsResponse,
  defaultMockData: { groups: [] },
  handler: getInternalGroupsHandler,
})

/**
 * Update internal groups
 * PUT /groups/internal
 */
const updateInternal = defineEndpoint({
  namespace: 'groups',
  name: 'updateInternal',
  method: 'PUT',
  path: '/groups/internal',
  body: updateInternalGroupsBodySchema,
  responseType: 'UpdateInternalGroupsResponse',
  response: {} as UpdateInternalGroupsResponse,
  defaultMockData: {},
  handler: updateInternalGroupsHandler,
})

/**
 * Search external groups
 * GET /groups/search?q=...
 */
const searchExternal = defineEndpoint({
  namespace: 'groups',
  name: 'searchExternal',
  method: 'GET',
  path: '/groups/search',
  params: searchExternalGroupsParamsSchema,
  responseType: 'ExternalGroupsResponse',
  response: {} as ExternalGroupsResponse,
  defaultMockData: { groups: [] },
  handler: searchExternalGroupsHandler,
})

/**
 * Exported routes for router registration
 */
export const GROUP_ROUTES = {
  getInternal,
  updateInternal,
  searchExternal,
} as const
