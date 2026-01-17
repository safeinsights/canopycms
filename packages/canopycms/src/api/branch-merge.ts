import { z } from 'zod'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { isAdmin } from '../authorization'
import { defineEndpoint } from './route-builder'

const markAsMergedParamsSchema = z.object({
  branch: z.string().min(1)
})

export interface MarkAsMergedParams {
  branch: string
}

/** Response type for branch merge operations */
export type BranchMergeResponse = ApiResponse<{ branch: { name: string; status: string } }>

const markAsMergedHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof markAsMergedParamsSchema>
): Promise<BranchMergeResponse> => {
  const { branch: branchName } = params

  // Load branch context
  const context = await ctx.getBranchContext(branchName)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Check permissions - only admins can mark as merged
  if (!isAdmin(req.user.groups)) {
    return { ok: false, status: 403, error: 'Forbidden: admin access required' }
  }

  // Verify branch is submitted with a PR
  if (context.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot mark as merged: branch status is "${context.branch.status}", expected "submitted"`,
    }
  }

  if (!context.branch.pullRequestNumber) {
    return {
      ok: false,
      status: 400,
      error: 'Cannot mark as merged: no pull request associated with this branch',
    }
  }

  // Optionally verify PR is actually merged via GitHub API
  if (ctx.services.githubService) {
    try {
      const pr = await ctx.services.githubService.getPullRequest(context.branch.pullRequestNumber)
      if (!pr.merged) {
        return {
          ok: false,
          status: 400,
          error: `Cannot mark as merged: PR #${context.branch.pullRequestNumber} is not merged on GitHub`,
        }
      }
    } catch (err) {
      console.error(`CanopyCMS: Failed to verify PR merge status for ${branchName}:`, err)
      // Don't fail if we can't verify - allow manual override
    }
  }

  // Update branch status to 'archived'
  const meta = getBranchMetadataFileManager(context.branchRoot, context.baseRoot)
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

/**
 * Mark a branch as merged and archived after PR is merged on GitHub
 * POST /:branch/mark-merged
 */
export const markAsMerged = defineEndpoint({
  namespace: 'workflow',
  name: 'markMerged',
  method: 'POST',
  path: '/:branch/mark-merged',
  params: markAsMergedParamsSchema,
  responseType: 'BranchMergeResponse',
  response: {} as BranchMergeResponse,
  defaultMockData: { branch: { name: 'test-branch', status: 'archived' } },
  handler: markAsMergedHandler,
})
