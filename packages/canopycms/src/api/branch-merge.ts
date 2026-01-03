import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { loadBranchState } from '../branch-workspace'
import { getBranchMetadata } from '../branch-metadata'
import { isAdmin } from '../reserved-groups'

export interface MarkAsMergedParams {
  branch: string
}

/**
 * Mark a branch as merged and archived after PR is merged on GitHub.
 * This is typically called manually by admins or via a webhook (future).
 */
export async function markAsMerged(
  ctx: ApiContext,
  req: ApiRequest,
  params: MarkAsMergedParams
): Promise<ApiResponse<{ branch: { name: string; status: string } }>> {
  const { branch: branchName } = params

  // Load branch state
  const state = await ctx.getBranchState(branchName)
  if (!state) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Check permissions - only admins can mark as merged
  if (!isAdmin(req.user.groups)) {
    return { ok: false, status: 403, error: 'Forbidden: admin access required' }
  }

  // Verify branch is submitted with a PR
  if (state.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot mark as merged: branch status is "${state.branch.status}", expected "submitted"`,
    }
  }

  if (!state.pullRequestNumber) {
    return {
      ok: false,
      status: 400,
      error: 'Cannot mark as merged: no pull request associated with this branch',
    }
  }

  // Optionally verify PR is actually merged via GitHub API
  if (ctx.services.githubService) {
    try {
      const pr = await ctx.services.githubService.getPullRequest(state.pullRequestNumber)
      if (!pr.merged) {
        return {
          ok: false,
          status: 400,
          error: `Cannot mark as merged: PR #${state.pullRequestNumber} is not merged on GitHub`,
        }
      }
    } catch (err) {
      console.error(`CanopyCMS: Failed to verify PR merge status for ${branchName}:`, err)
      // Don't fail if we can't verify - allow manual override
    }
  }

  // Update branch status to 'archived'
  const meta = getBranchMetadata(state.metadataRoot!, state.baseRoot!)
  await meta.save({
    branch: {
      status: 'archived',
    },
  })

  // Optionally delete remote branch (disabled by default for safety)
  // if (ctx.services.githubService && req.body?.deleteRemoteBranch) {
  //   try {
  //     await ctx.services.githubService.deleteBranch(branchName)
  //   } catch (err) {
  //     console.error(`CanopyCMS: Failed to delete remote branch ${branchName}:`, err)
  //   }
  // }

  // Comments.json is already in the branch workspace at .canopycms/comments.json
  // It will be preserved with the archived branch - no action needed

  return {
    ok: true,
    status: 200,
    data: {
      branch: {
        name: branchName,
        status: 'archived',
      },
    },
  }
}
