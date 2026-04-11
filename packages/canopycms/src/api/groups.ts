import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { CanopyGroupId } from '../types'
import {
  type InternalGroup,
  loadInternalGroups,
  saveInternalGroups,
  loadGroupsFile,
  RESERVED_GROUPS,
  isReservedGroup,
} from '../authorization'
import { defineEndpoint } from './route-builder'
import { getSettingsBranchContext, commitSettings } from './settings-helpers'
import { generateId } from '../id'

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
  groups: z.array(internalGroupSchema),
  expectedContentVersion: z.number().optional(),
})

const searchExternalGroupsParamsSchema = z.object({
  query: z.string(),
})

/**
 * Validate that an update to internal groups doesn't remove the last admin.
 * Considers both internal Admins group members and bootstrap admins.
 */
export const validateAdminGroupUpdate = (
  newGroups: InternalGroup[],
  bootstrapAdminIds: Set<string>,
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
    return {
      valid: false,
      error: 'Cannot remove last admin - at least one admin is required',
    }
  }

  return { valid: true }
}

/**
 * Validate that reserved groups are not deleted or renamed.
 */
export const validateReservedGroups = (
  newGroups: InternalGroup[],
): { valid: boolean; error?: string } => {
  // Check if any reserved group IDs have been altered
  for (const group of newGroups) {
    if (isReservedGroup(group.id)) {
      // Reserved group exists - make sure the name matches the ID
      if (group.name !== group.id) {
        return {
          valid: false,
          error: `Reserved group '${group.id}' cannot be renamed`,
        }
      }
    }
  }

  return { valid: true }
}

/**
 * Get internal groups (admin only)
 */
const getInternalGroupsHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  _req: ApiRequest,
): Promise<InternalGroupsResponse> => {
  try {
    const result = await getSettingsBranchContext(ctx)
    if ('error' in result) {
      return { ok: false, status: result.status, error: result.error }
    }

    const { context, mode } = result
    const groups = await loadInternalGroups(
      context.branchRoot,
      mode,
      ctx.services.bootstrapAdminIds,
    )

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
  _gc: Record<string, never>,
  ctx: ApiContext,
  req: ApiRequest,
  body: z.infer<typeof updateInternalGroupsBodySchema>,
): Promise<UpdateInternalGroupsResponse> => {
  if (!body?.groups) {
    return { ok: false, status: 400, error: 'groups array required' }
  }

  try {
    const result = await getSettingsBranchContext(ctx)
    if ('error' in result) {
      return { ok: false, status: result.status, error: result.error }
    }

    const { context, mode } = result

    // Load current file to check version (optimistic locking)
    const currentFile = await loadGroupsFile(context.branchRoot, mode)

    // Check for version conflict if client sent expected version
    if (body.expectedContentVersion !== undefined) {
      const currentVersion = currentFile?.contentVersion ?? 0
      if (currentVersion !== body.expectedContentVersion) {
        return {
          ok: false,
          status: 409,
          error: 'Groups were modified by another user. Please reload and try again.',
        }
      }
    }

    // Build map of existing group IDs
    const existingGroups = await loadInternalGroups(
      context.branchRoot,
      mode,
      ctx.services.bootstrapAdminIds,
    )
    const existingById = new Set(existingGroups.map((g) => g.id))

    // Process groups: generate IDs for new groups, keep IDs for existing groups
    const processedGroups = body.groups.map((group) => {
      // Existing group with valid ID - keep ID
      if (group.id && group.id.trim() !== '' && existingById.has(group.id)) {
        return group
      }

      // Check if this is a reserved group (by ID or name)
      if (isReservedGroup(group.id) || isReservedGroup(group.name)) {
        // Reserved groups: ID = name (e.g., "Admins", "Reviewers")
        return { ...group, id: group.name as CanopyGroupId }
      }

      // New regular group (empty ID or not in existing set) - generate ID
      return { ...group, id: generateId() as CanopyGroupId }
    })

    // Validate no duplicate IDs
    const idSet = new Set<string>()
    for (const group of processedGroups) {
      if (idSet.has(group.id)) {
        return {
          ok: false,
          status: 400,
          error: `Duplicate group ID detected: ${group.id}`,
        }
      }
      idSet.add(group.id)
    }

    // Validate no duplicate names
    const nameSet = new Set<string>()
    for (const group of processedGroups) {
      const normalizedName = group.name.toLowerCase().trim()
      if (nameSet.has(normalizedName)) {
        return {
          ok: false,
          status: 400,
          error: `Duplicate group name detected: ${group.name}`,
        }
      }
      nameSet.add(normalizedName)
    }

    // Validate reserved groups are not renamed (after ID generation)
    const reservedValidation = validateReservedGroups(processedGroups)
    if (!reservedValidation.valid) {
      return { ok: false, status: 400, error: reservedValidation.error }
    }

    // Validate we're not removing the last admin (after ID generation)
    const adminValidation = validateAdminGroupUpdate(
      processedGroups,
      ctx.services.bootstrapAdminIds,
    )
    if (!adminValidation.valid) {
      return { ok: false, status: 400, error: adminValidation.error }
    }

    // Increment version when saving
    const newContentVersion = (currentFile?.contentVersion ?? 0) + 1

    // Save file (uses mode-aware file path)
    await saveInternalGroups(
      context.branchRoot,
      processedGroups,
      req.user.userId,
      mode,
      newContentVersion,
    )

    // Commit and push (mode-aware)
    await commitSettings(ctx, {
      context,
      branchRoot: context.branchRoot,
      fileName: 'groups.json',
      message: 'Update internal groups',
      mode,
    })

    return { ok: true, status: 200, data: {} }
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
  _gc: Record<string, never>,
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof searchExternalGroupsParamsSchema>,
): Promise<ExternalGroupsResponse> => {
  const authPlugin = ctx.authPlugin
  if (!authPlugin || !authPlugin.searchExternalGroups) {
    return {
      ok: false,
      status: 501,
      error: 'External group search not configured',
    }
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
  guards: ['admin'] as const,
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
  bodyType: 'UpdateInternalGroupsBody',
  responseType: 'UpdateInternalGroupsResponse',
  response: {} as UpdateInternalGroupsResponse,
  defaultMockData: {},
  guards: ['admin'] as const,
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
  guards: ['admin'] as const,
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
