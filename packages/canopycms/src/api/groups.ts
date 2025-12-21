import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { InternalGroup } from '../groups-file'
import { loadInternalGroups, saveInternalGroups } from '../groups-loader'
import { resolveBranchWorkspace } from '../paths'
import type { CanopyGroupId, CanopyUserId } from '../types'

/**
 * Get internal groups (admin only)
 */
export const getInternalGroups = async (
  ctx: ApiContext,
  req: ApiRequest<undefined>,
): Promise<ApiResponse<{ groups: InternalGroup[] }>> => {
  // Check admin permission
  if (req.user.role !== 'admin') {
    return { ok: false, status: 403, error: 'Admin access required' }
  }

  try {
    // Load from main branch
    const mainBranch = ctx.services.config.defaultBaseBranch ?? 'main'
    const branchState = await ctx.getBranchState(mainBranch)

    if (!branchState) {
      return { ok: false, status: 500, error: 'Main branch not found' }
    }

    const branchMode = ctx.services.config.mode ?? 'local-simple'
    const branchPaths = resolveBranchWorkspace(branchState, branchMode)
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
export const updateInternalGroups = async (
  ctx: ApiContext,
  req: ApiRequest<UpdateInternalGroupsBody>,
): Promise<ApiResponse> => {
  // Check admin permission
  if (req.user.role !== 'admin') {
    return { ok: false, status: 403, error: 'Admin access required' }
  }

  if (!req.body?.groups) {
    return { ok: false, status: 400, error: 'groups array required' }
  }

  try {
    // Save to main branch
    const mainBranch = ctx.services.config.defaultBaseBranch ?? 'main'
    const branchState = await ctx.getBranchState(mainBranch)

    if (!branchState) {
      return { ok: false, status: 500, error: 'Main branch not found' }
    }

    const branchMode = ctx.services.config.mode ?? 'local-simple'
    const branchPaths = resolveBranchWorkspace(branchState, branchMode)

    await saveInternalGroups(branchPaths.branchRoot, req.body.groups, req.user.userId)

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

export const searchExternalGroups = async (
  ctx: ApiContext,
  req: ApiRequest<undefined>,
  params: SearchExternalGroupsParams,
): Promise<ApiResponse<{ groups: ExternalGroup[] }>> => {
  // Require admin for external group search
  if (req.user.role !== 'admin') {
    return { ok: false, status: 403, error: 'Admin access required' }
  }

  const authPlugin = ctx.services.config.authPlugin
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
