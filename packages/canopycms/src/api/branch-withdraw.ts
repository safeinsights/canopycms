import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchMetadata } from '../types'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { resolveBranchPaths } from '../paths'

/**
 * Withdraw a submitted branch, converting the PR to draft and unlocking editing
 */
export const withdrawBranch = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: { branch: string }
): Promise<ApiResponse<{ branch: BranchMetadata }>> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const access = ctx.services.checkBranchAccess(context, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  // Verify branch is in submitted status
  if (context.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot withdraw branch with status '${context.branch.status}'. Only 'submitted' branches can be withdrawn.`,
    }
  }

  // Convert PR to draft if it exists
  const githubService = ctx.services.githubService
  if (githubService && context.branch.pullRequestNumber) {
    try {
      await githubService.convertToDraft(context.branch.pullRequestNumber)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`CanopyCMS: Failed to convert PR to draft for ${context.branch.name}:`, message)
      // Continue anyway - local state is more important
    }
  }

  // Update branch status to 'editing'
  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchPaths(context, branchMode)
  const meta = getBranchMetadataFileManager(branchPaths.branchRoot, branchPaths.baseRoot)

  const updated = await meta.save({
    branch: { name: context.branch.name, status: 'editing' },
  })

  return { ok: true, status: 200, data: { branch: updated.branch } }
}
