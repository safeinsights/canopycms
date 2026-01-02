import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchState } from '../types'
import { createBranchMetadata } from '../branch-metadata'
import { resolveBranchWorkspace } from '../paths'
import { isReviewer } from '../reserved-groups'

/**
 * Request changes on a submitted branch (reviewer action)
 * Converts PR to draft and unlocks branch for editing
 */
export const requestChanges = async (
  ctx: ApiContext,
  req: ApiRequest<{ comment?: string }>,
  params: { branch: string },
): Promise<ApiResponse<{ branch: BranchState }>> => {
  const state = await ctx.getBranchState(params.branch)
  if (!state) {
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
  if (state.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot request changes on branch with status '${state.branch.status}'. Only 'submitted' branches can have changes requested.`,
    }
  }

  // Convert PR to draft if GitHub service is available
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
  const meta = createBranchMetadata(branchPaths.metadataRoot, branchPaths.baseRoot)

  await meta.update({
    branch: { name: state.branch.name, status: 'editing' },
  })

  // TODO: Optionally record comment in .canopycms/comments.json when comment system is implemented

  const updated = await ctx.getBranchState(params.branch)
  if (!updated) {
    return { ok: false, status: 500, error: 'Failed to update branch' }
  }

  return { ok: true, status: 200, data: { branch: updated } }
}

/**
 * Approve a branch (optional for v1)
 * This doesn't actually merge - that happens on GitHub
 */
export const approveBranch = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: { branch: string },
): Promise<ApiResponse<{ branch: BranchState }>> => {
  const state = await ctx.getBranchState(params.branch)
  if (!state) {
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
  if (state.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot approve branch with status '${state.branch.status}'. Only 'submitted' branches can be approved.`,
    }
  }

  // Update branch status to 'approved'
  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchWorkspace(state, branchMode)
  const meta = createBranchMetadata(branchPaths.metadataRoot, branchPaths.baseRoot)

  await meta.update({
    branch: { name: state.branch.name, status: 'approved' },
  })

  // TODO: Optionally call githubService.approvePullRequest() when GitHub integration is needed

  const updated = await ctx.getBranchState(params.branch)
  if (!updated) {
    return { ok: false, status: 500, error: 'Failed to update branch' }
  }

  return { ok: true, status: 200, data: { branch: updated } }
}
