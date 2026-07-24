import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { CanopyGroupId } from '../types'
import {
  type InternalGroup,
  loadInternalGroups,
  loadGroupsFile,
  deriveInternalGroups,
  mutateGroupsFile,
  RESERVED_GROUPS,
  isReservedGroup,
  SettingsVersionConflictError,
  SettingsFileConflictError,
} from '../authorization'
import { defineEndpoint } from './route-builder'
import { getSettingsBranchContext, commitSettings } from './settings-helpers'
import { generateId } from '../id'
import { getErrorMessage, sanitizeErrorMessage } from '../utils/error'

/** Response type for getting internal groups */
export type InternalGroupsResponse = ApiResponse<{ groups: InternalGroup[]; version: number }>

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
 * Thrown for any of the groups-specific validation failures (duplicate
 * id/name, reserved-group rename, removing the last admin) discovered
 * inside the `mutateGroupsFile` mutator, running under the settings-file
 * lock. Mapped to a 400 with the original message at the handler's catch
 * boundary — kept module-local since only `updateInternalGroupsHandler`
 * throws or catches it.
 */
class GroupsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GroupsValidationError'
  }
}

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
    const [groups, file] = await Promise.all([
      loadInternalGroups(context.branchRoot, mode, ctx.services.bootstrapAdminIds),
      loadGroupsFile(context.branchRoot, mode),
    ])

    // NOTE: groups always includes the derived reserved groups (Admins,
    // Reviewers) even when the file doesn't exist yet, so `version: 0` with
    // a non-empty `groups` array is a legitimate combination here.
    return {
      ok: true,
      status: 200,
      data: { groups, version: file?.version ?? 0 },
    }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: sanitizeErrorMessage(getErrorMessage(error)),
    }
  }
}

export interface UpdateInternalGroupsBody {
  groups: InternalGroup[]
  /** Optimistic-concurrency guard — compared against the groups file's current `version` (see updateInternalGroupsHandler). */
  expectedContentVersion?: number
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

    // Load -> compare -> reconcile -> validate -> write all happen atomically
    // under the cross-host layered lock (see
    // authorization/settings-file-store.ts), against the mutator's own
    // freshly-reloaded file — no separate pre-read here, so there's no
    // TOCTOU window between the version/reconciliation checks and the write.
    await mutateGroupsFile(context.branchRoot, mode, (currentFile, version) => {
      if (body.expectedContentVersion !== undefined && body.expectedContentVersion !== version) {
        throw new SettingsVersionConflictError(
          'Groups were modified by another user. Please reload and try again.',
        )
      }

      // Reconcile against the mutator's own fresh file (deriveInternalGroups
      // is pure, so this needs no second disk read via loadInternalGroups).
      const existingGroups = deriveInternalGroups(
        currentFile?.groups ?? [],
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
          throw new GroupsValidationError(`Duplicate group ID detected: ${group.id}`)
        }
        idSet.add(group.id)
      }

      // Validate no duplicate names
      const nameSet = new Set<string>()
      for (const group of processedGroups) {
        const normalizedName = group.name.toLowerCase().trim()
        if (nameSet.has(normalizedName)) {
          throw new GroupsValidationError(`Duplicate group name detected: ${group.name}`)
        }
        nameSet.add(normalizedName)
      }

      // Validate reserved groups are not renamed (after ID generation)
      const reservedValidation = validateReservedGroups(processedGroups)
      if (!reservedValidation.valid) {
        throw new GroupsValidationError(reservedValidation.error ?? 'Invalid reserved group')
      }

      // Validate we're not removing the last admin (after ID generation)
      const adminValidation = validateAdminGroupUpdate(
        processedGroups,
        ctx.services.bootstrapAdminIds,
      )
      if (!adminValidation.valid) {
        throw new GroupsValidationError(adminValidation.error ?? 'Invalid admin group update')
      }

      return {
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.userId,
        groups: processedGroups,
      }
    })

    // Commit and push (mode-aware). A push failure means the change is saved
    // to the branch working tree but NOT durably persisted (API-H1) - surface
    // that to the client instead of reporting a bare 200.
    const commitResult = await commitSettings(ctx, {
      context,
      branchRoot: context.branchRoot,
      fileName: 'groups.json',
      message: 'Update internal groups',
      mode,
    })

    if (!commitResult.pushed) {
      return {
        ok: false,
        status: 502,
        error: `Groups were saved but failed to sync to git: ${commitResult.error ?? 'unknown error'}`,
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
    if (error instanceof GroupsValidationError) {
      return { ok: false, status: 400, error: error.message }
    }
    return {
      ok: false,
      status: 500,
      error: sanitizeErrorMessage(getErrorMessage(error)),
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
      error: sanitizeErrorMessage(getErrorMessage(error)),
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
  defaultMockData: { groups: [], version: 0 },
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
