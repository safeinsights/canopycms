import { z } from 'zod'
import type { ApiContext, ApiRequest } from './types'
import type { BranchResponse } from './branch'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { withdrawBranch } from './branch-withdraw'
import { requestChanges, approveBranch } from './branch-review'
import { markAsMerged } from './branch-merge'
import { defineEndpoint } from './route-builder'
import { canPerformWorkflowAction } from '../authorization'
import { guardBranchAccess, guardBranchExists, isBranchAccessError } from './middleware'
import { syncSubmitPr } from './github-sync'

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
  const accessResult = await guardBranchAccess(ctx, req, params.branch)
  if (isBranchAccessError(accessResult)) return accessResult
  const { context } = accessResult

  return { ok: true, status: 200, data: { branch: context.branch } }
}

const submitBranchForMergeHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamSchema>
): Promise<BranchResponse> => {
  const accessResult = await guardBranchExists(ctx, params.branch)
  if (isBranchAccessError(accessResult)) return accessResult
  const { context } = accessResult

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

  // Create or update PR (sync via githubService, or async via task queue)
  const prResult = await syncSubmitPr(ctx, context)

  // Update metadata with status and PR info
  const meta = getBranchMetadataFileManager(context.branchRoot, context.baseRoot)
  const updated = await meta.save({
    branch: {
      name: context.branch.name,
      status: 'submitted',
      pullRequestUrl: prResult.prUrl ?? context.branch.pullRequestUrl,
      pullRequestNumber: prResult.prNumber ?? context.branch.pullRequestNumber,
      ...(prResult.syncStatus !== undefined ? { syncStatus: prResult.syncStatus } : {}),
    },
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
