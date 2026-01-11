import { z } from 'zod'
import type { ApiContext, ApiRequest } from './types'
import type { BranchResponse } from './branch'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { withdrawBranch } from './branch-withdraw'
import { requestChanges, approveBranch } from './branch-review'
import { markAsMerged } from './branch-merge'
import { defineEndpoint } from './route-builder'
import type { BranchMetadata } from '../types'
import { canPerformWorkflowAction } from '../authz'

// Re-export for client generation
export type { BranchMergeResponse } from './branch-merge'

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const branchParamSchema = z.object({
  branch: z.string().min(1)
})

const getBranchStatusHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamSchema>
): Promise<BranchResponse> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }
  const access = ctx.services.checkBranchAccess(context, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }
  return { ok: true, status: 200, data: { branch: context.branch } }
}

const submitBranchForMergeHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamSchema>
): Promise<BranchResponse> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Check if user can perform workflow actions (creator OR ACL access)
  const defaultAccess = ctx.services.config.defaultBranchAccess ?? 'deny'
  const canSubmit = canPerformWorkflowAction(context, req.user, defaultAccess)
  if (!canSubmit) {
    return {
      ok: false,
      status: 403,
      error: 'Only the branch creator or users with explicit branch access can submit this branch',
    }
  }

  const meta = getBranchMetadataFileManager(context.branchRoot, context.baseRoot)

  // Commit and push changes
  try {
    await ctx.services.submitBranch({ context })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to push branch changes'
    return {
      ok: false,
      status: 500,
      error: `Failed to push branch changes (${context.branchRoot}): ${message}`,
    }
  }

  // Create or update PR if GitHub service is available
  const githubService = ctx.services.githubService
  let prUrl = context.branch.pullRequestUrl
  let prNumber = context.branch.pullRequestNumber

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  if (githubService && branchMode !== 'local-simple') {
    try {
      const prTitle = context.branch.title || `Submit ${context.branch.name}`
      const prBody = context.branch.description || ''

      if (context.branch.pullRequestNumber) {
        // Update existing PR
        await githubService.updatePullRequest(context.branch.pullRequestNumber, {
          title: prTitle,
          body: prBody,
        })
        // Convert to ready if it was draft
        const pr = await githubService.getPullRequest(context.branch.pullRequestNumber)
        if (pr.draft) {
          await githubService.convertToReady(context.branch.pullRequestNumber)
        }
        // Keep existing URL and number
        prUrl = context.branch.pullRequestUrl
        prNumber = context.branch.pullRequestNumber
      } else {
        // Create new PR
        const result = await githubService.createPullRequest({
          branchName: context.branch.name,
          title: prTitle,
          body: prBody,
          draft: false,
        })
        prUrl = result.url
        prNumber = result.number
      }
    } catch (err) {
      // Log error but don't fail submission - code is already pushed
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`CanopyCMS: Failed to create/update PR for ${context.branch.name}:`, message)
    }
  }

  // Update metadata with status and PR info
  const updated = await meta.save({
    branch: { name: context.branch.name, status: 'submitted', pullRequestUrl: prUrl, pullRequestNumber: prNumber },
  })

  return { ok: true, status: 200, data: { branch: updated.branch } }
}

// ============================================================================
// Route Definitions with defineEndpoint
// ============================================================================

/**
 * Get branch status
 * GET /:branch/status
 */
const getBranchStatus = defineEndpoint({
  namespace: 'workflow',
  name: 'getStatus',
  method: 'GET',
  path: '/:branch/status',
  params: branchParamSchema,
  responseType: 'BranchResponse',
  response: {} as BranchResponse,
  defaultMockData: { branch: { name: 'test-branch', status: 'editing', access: {}, createdBy: 'user-1', createdAt: '2024-01-01', updatedAt: '2024-01-01' } },
  handler: getBranchStatusHandler,
})

/**
 * Submit branch for merge/review
 * POST /:branch/submit
 */
const submitBranchForMerge = defineEndpoint({
  namespace: 'workflow',
  name: 'submit',
  method: 'POST',
  path: '/:branch/submit',
  params: branchParamSchema,
  responseType: 'BranchResponse',
  response: {} as BranchResponse,
  defaultMockData: { branch: { name: 'test-branch', status: 'submitted', access: {}, createdBy: 'user-1', createdAt: '2024-01-01', updatedAt: '2024-01-01' } },
  handler: submitBranchForMergeHandler,
})

/**
 * Exported routes for router registration
 */
export const WORKFLOW_ROUTES = {
  getStatus: getBranchStatus,
  submit: submitBranchForMerge,
  withdraw: withdrawBranch,
  requestChanges: requestChanges,
  approve: approveBranch,
  markMerged: markAsMerged,
} as const
