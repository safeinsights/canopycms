import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchState } from '../types'
import { BranchMetadata } from '../branch-metadata'
import { resolveBranchWorkspace } from '../paths'

/**
 * Withdraw a submitted branch, converting the PR to draft and unlocking editing
 */
export const withdrawBranch = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: { branch: string }
): Promise<ApiResponse<{ branch: BranchState }>> => {
  const state = await ctx.getBranchState(params.branch)
  if (!state) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const access = ctx.services.checkBranchAccess(state, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  // Verify branch is in submitted status
  if (state.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot withdraw branch with status '${state.branch.status}'. Only 'submitted' branches can be withdrawn.`,
    }
  }

  // Convert PR to draft if it exists
  const githubService = ctx.services.githubService
  if (githubService && state.pullRequestNumber) {
    try {
      await githubService.convertToDraft(state.pullRequestNumber)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`CanopyCMS: Failed to convert PR to draft for ${state.branch.name}:`, message)
      // Continue anyway - local state is more important
    }
  }

  // Update branch status to 'editing'
  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchWorkspace(state, branchMode)
  const meta = new BranchMetadata(branchPaths.metadataRoot)

  await meta.update({
    branch: { name: state.branch.name, status: 'editing' },
  })

  const updated = await ctx.getBranchState(params.branch)
  if (!updated) {
    return { ok: false, status: 500, error: 'Failed to update branch' }
  }

  return { ok: true, status: 200, data: { branch: updated } }
}
