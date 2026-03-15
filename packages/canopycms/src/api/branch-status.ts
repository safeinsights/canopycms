import { z } from 'zod'
import type { ApiContext, ApiRequest } from './types'
import type { BranchResponse } from './branch'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { withdrawBranch } from './branch-withdraw'
import { requestChanges, approveBranch } from './branch-review'
import { markAsMerged } from './branch-merge'
import { defineEndpoint } from './route-builder'
import type { BranchMetadata } from '../types'
import { canPerformWorkflowAction } from '../authorization'
import { clientOperatingStrategy } from '../operating-mode'
import { guardBranchAccess, guardBranchExists, isBranchAccessError } from './middleware'
import { enqueueTask } from '../worker/task-queue'
import { getTaskQueueDir } from '../worker/task-queue-config'

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
  let syncStatus: BranchMetadata['syncStatus'] = undefined

  const operatingMode = ctx.services.config.mode
  if (githubService && clientOperatingStrategy(operatingMode).supportsPullRequests()) {
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
      syncStatus = 'synced'
    } catch (err) {
      // Log error but don't fail submission - code is already pushed
      const message = err instanceof Error ? err.message : 'Unknown error'
      console.error(`CanopyCMS: Failed to create/update PR for ${context.branch.name}:`, message)
    }
  } else if (clientOperatingStrategy(operatingMode).supportsPullRequests()) {
    // No GitHub service available (e.g., Lambda with no internet).
    // Queue the PR operation for the EC2 worker to execute.
    const taskDir = getTaskQueueDir(ctx.services.config)
    if (taskDir) {
      try {
        const prTitle = context.branch.title || `Submit ${context.branch.name}`
        const prBody = context.branch.description || ''
        const action = context.branch.pullRequestNumber
          ? 'push-and-update-pr' as const
          : 'push-and-create-pr' as const

        await enqueueTask(taskDir, {
          action,
          payload: {
            branch: context.branch.name,
            title: prTitle,
            body: prBody,
            baseBranch: ctx.services.config.defaultBaseBranch ?? 'main',
            pullRequestNumber: context.branch.pullRequestNumber,
          },
        })
        syncStatus = 'pending-sync'
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        console.error(`CanopyCMS: Failed to enqueue PR task for ${context.branch.name}:`, message)
        syncStatus = 'sync-failed'
      }
    }
  }

  // Update metadata with status and PR info
  const updated = await meta.save({
    branch: {
      name: context.branch.name,
      status: 'submitted',
      pullRequestUrl: prUrl,
      pullRequestNumber: prNumber,
      ...(syncStatus !== undefined ? { syncStatus } : {}),
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
