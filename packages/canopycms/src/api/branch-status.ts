import { z } from 'zod'
import { branchParamSchema } from './validators'
import type { ApiContext, ApiRequest } from './types'
import type { BranchContext } from '../types'
import type { BranchResponse } from './branch'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { withdrawBranch } from './branch-withdraw'
import { requestChanges, approveBranch } from './branch-review'
import { markAsMerged } from './branch-merge'
import { defineEndpoint } from './route-builder'
import { canPerformWorkflowAction } from '../authorization'
import { syncSubmitPr } from './github-sync'

// Re-export for client generation
export type { BranchMergeResponse } from './branch-merge'

const getBranchStatusHandler = async (
  gc: { branchContext: BranchContext },
  _ctx: ApiContext,
  _req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
): Promise<BranchResponse> => {
  const { branchContext } = gc

  return { ok: true, status: 200, data: { branch: branchContext.branch } }
}

const submitBranchForMergeHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
): Promise<BranchResponse> => {
  const { branchContext } = gc

  // Check if user can perform workflow actions (creator OR ACL access)
  const defaultAccess = ctx.services.config.defaultBranchAccess ?? 'deny'
  const canSubmit = canPerformWorkflowAction(branchContext, req.user, defaultAccess)
  if (!canSubmit) {
    return {
      ok: false,
      status: 403,
      error: 'Only the branch creator or users with explicit branch access can submit this branch',
    }
  }

  // Commit and push changes
  try {
    await ctx.services.submitBranch({ context: branchContext })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to push branch changes'
    return {
      ok: false,
      status: 500,
      error: `Failed to push branch changes (${branchContext.branchRoot}): ${message}`,
    }
  }

  // Create or update PR (sync via githubService, or async via task queue)
  const prResult = await syncSubmitPr(ctx, branchContext)

  // Update metadata with status and PR info
  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)
  const updated = await meta.save({
    branch: {
      name: branchContext.branch.name,
      status: 'submitted',
      pullRequestUrl: prResult.prUrl ?? branchContext.branch.pullRequestUrl,
      pullRequestNumber: prResult.prNumber ?? branchContext.branch.pullRequestNumber,
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
  defaultMockData: {
    branch: {
      name: 'test-branch',
      status: 'editing',
      access: {},
      createdBy: 'user-1',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
  },
  guards: ['branchAccess'] as const,
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
  defaultMockData: {
    branch: {
      name: 'test-branch',
      status: 'submitted',
      access: {},
      createdBy: 'user-1',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
  },
  // Branch-level access not checked here — handler uses canPerformWorkflowAction() for
  // finer-grained authorization (creator OR ACL access).
  guards: ['branch'] as const,
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
