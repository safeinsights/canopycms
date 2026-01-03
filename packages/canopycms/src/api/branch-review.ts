import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchMetadata } from '../types'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { resolveBranchPaths } from '../paths'
import { isReviewer } from '../reserved-groups'

/**
 * Request changes on a submitted branch (reviewer action)
 * Converts PR to draft and unlocks branch for editing
 */
export const requestChanges = async (
  ctx: ApiContext,
  req: ApiRequest<{ comment?: string }>,
  params: { branch: string },
): Promise<ApiResponse<{ branch: BranchMetadata }>> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Check user is a Reviewer (or Admin)
  if (!isReviewer(req.user.groups)) {
    return {
      ok: false,
      status: 403,
      error: 'Only Admins and Reviewers can request changes',
    }
  }

  // Verify branch is submitted
  if (context.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot request changes on branch with status '${context.branch.status}'. Only 'submitted' branches can have changes requested.`,
    }
  }

  // Convert PR to draft if GitHub service is available
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

  // TODO: Optionally record comment in .canopycms/comments.json when comment system is implemented

  return { ok: true, status: 200, data: { branch: updated.branch } }
}

/**
 * Approve a branch (optional for v1)
 * This doesn't actually merge - that happens on GitHub
 */
export const approveBranch = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: { branch: string },
): Promise<ApiResponse<{ branch: BranchMetadata }>> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Check user is a Reviewer (or Admin)
  if (!isReviewer(req.user.groups)) {
    return {
      ok: false,
      status: 403,
      error: 'Only Admins and Reviewers can approve branches',
    }
  }

  // Verify branch is submitted
  if (context.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot approve branch with status '${context.branch.status}'. Only 'submitted' branches can be approved.`,
    }
  }

  // Update branch status to 'approved'
  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchPaths(context, branchMode)
  const meta = getBranchMetadataFileManager(branchPaths.branchRoot, branchPaths.baseRoot)

  const updated = await meta.save({
    branch: { name: context.branch.name, status: 'approved' },
  })

  // TODO: Optionally call githubService.approvePullRequest() when GitHub integration is needed

  return { ok: true, status: 200, data: { branch: updated.branch } }
}
