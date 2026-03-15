import { z } from 'zod'
import type { ApiContext, ApiRequest } from './types'
import type { BranchResponse } from './branch'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { isReviewer } from '../authorization'
import { defineEndpoint } from './route-builder'
import { guardBranchExists, isBranchAccessError } from './middleware'
import { syncConvertToDraft } from './github-sync'

export interface RequestChangesBody {
  comment?: string
}

const branchParamSchema = z.object({
  branch: z.string().min(1)
})

const requestChangesBodySchema = z.object({
  comment: z.string().optional()
})

const requestChangesHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamSchema>,
  body?: z.infer<typeof requestChangesBodySchema>
): Promise<BranchResponse> => {
  const accessResult = await guardBranchExists(ctx, params.branch)
  if (isBranchAccessError(accessResult)) return accessResult
  const { context } = accessResult

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

  // Convert PR to draft (sync via githubService, or async via task queue)
  await syncConvertToDraft(ctx, context)

  // Update branch status to 'editing'
  const meta = getBranchMetadataFileManager(context.branchRoot, context.baseRoot)

  const updated = await meta.save({
    branch: { name: context.branch.name, status: 'editing' },
  })

  // TODO: Optionally record comment in .canopycms/comments.json when comment system is implemented

  return { ok: true, status: 200, data: { branch: updated.branch } }
}

const approveBranchHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamSchema>
): Promise<BranchResponse> => {
  const accessResult = await guardBranchExists(ctx, params.branch)
  if (isBranchAccessError(accessResult)) return accessResult
  const { context } = accessResult

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
  const meta = getBranchMetadataFileManager(context.branchRoot, context.baseRoot)

  const updated = await meta.save({
    branch: { name: context.branch.name, status: 'approved' },
  })

  // TODO: Optionally call githubService.approvePullRequest() when GitHub integration is needed

  return { ok: true, status: 200, data: { branch: updated.branch } }
}

/**
 * Request changes on a submitted branch (reviewer action)
 * POST /:branch/request-changes
 */
export const requestChanges = defineEndpoint({
  namespace: 'workflow',
  name: 'requestChanges',
  method: 'POST',
  path: '/:branch/request-changes',
  params: branchParamSchema,
  body: requestChangesBodySchema,
  bodyType: 'RequestChangesBody',
  responseType: 'BranchResponse',
  response: {} as BranchResponse,
  defaultMockData: { branch: { name: 'test-branch', status: 'editing', access: {}, createdBy: 'user-1', createdAt: '2024-01-01', updatedAt: '2024-01-01' } },
  handler: requestChangesHandler,
})

/**
 * Approve a branch (optional for v1)
 * POST /:branch/approve
 */
export const approveBranch = defineEndpoint({
  namespace: 'workflow',
  name: 'approve',
  method: 'POST',
  path: '/:branch/approve',
  params: branchParamSchema,
  responseType: 'BranchResponse',
  response: {} as BranchResponse,
  defaultMockData: { branch: { name: 'test-branch', status: 'approved', access: {}, createdBy: 'user-1', createdAt: '2024-01-01', updatedAt: '2024-01-01' } },
  handler: approveBranchHandler,
})
