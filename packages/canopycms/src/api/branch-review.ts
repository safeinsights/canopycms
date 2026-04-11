import { z } from 'zod'
import { branchParamSchema } from './validators'
import type { ApiContext, ApiRequest } from './types'
import type { BranchContext } from '../types'
import type { BranchResponse } from './branch'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { defineEndpoint } from './route-builder'
import { syncConvertToDraft } from './github-sync'

const requestChangesHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  _req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
): Promise<BranchResponse> => {
  const { branchContext } = gc

  // Verify branch is submitted
  if (branchContext.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot request changes on branch with status '${branchContext.branch.status}'. Only 'submitted' branches can have changes requested.`,
    }
  }

  // Convert PR to draft (sync via githubService, or async via task queue)
  await syncConvertToDraft(ctx, branchContext)

  // Update branch status to 'editing'
  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)

  const updated = await meta.save({
    branch: { name: branchContext.branch.name, status: 'editing' },
  })

  // TODO: Optionally record comment in .canopycms/comments.json when comment system is implemented

  return { ok: true, status: 200, data: { branch: updated.branch } }
}

const approveBranchHandler = async (
  gc: { branchContext: BranchContext },
  _ctx: ApiContext,
  _req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
): Promise<BranchResponse> => {
  const { branchContext } = gc

  // Verify branch is submitted
  if (branchContext.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot approve branch with status '${branchContext.branch.status}'. Only 'submitted' branches can be approved.`,
    }
  }

  // Update branch status to 'approved'
  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)

  const updated = await meta.save({
    branch: { name: branchContext.branch.name, status: 'approved' },
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
  // body/bodyType removed: comment field was declared but never stored.
  // Re-add when comment storage is implemented (see TODO in handler).
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
  guards: ['reviewer', 'branch'] as const,
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
  defaultMockData: {
    branch: {
      name: 'test-branch',
      status: 'approved',
      access: {},
      createdBy: 'user-1',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    },
  },
  guards: ['reviewer', 'branch'] as const,
  handler: approveBranchHandler,
})
