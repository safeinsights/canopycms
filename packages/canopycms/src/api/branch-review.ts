import { z } from 'zod'
import { branchParamSchema } from './validators'
import type { ApiContext, ApiRequest } from './types'
import type { BranchContext } from '../types'
import { toBranchListItem, type BranchListItemResponse } from './branch'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { defineEndpoint } from './route-builder'
import { syncConvertToDraft } from './github-sync'

const requestChangesHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  _req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
): Promise<BranchListItemResponse> => {
  const { branchContext } = gc

  if (branchContext.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot request changes on branch with status '${branchContext.branch.status}'. Only 'submitted' branches can have changes requested.`,
    }
  }

  await syncConvertToDraft(ctx, branchContext)

  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)

  const updated = await meta.save({
    branch: { name: branchContext.branch.name, status: 'editing' },
  })

  // TODO: Optionally record comment in .canopy-meta/comments.json when comment system is implemented

  return {
    ok: true,
    status: 200,
    data: { branch: toBranchListItem(ctx.services.config, updated.branch) },
  }
}

const approveBranchHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  _req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
): Promise<BranchListItemResponse> => {
  const { branchContext } = gc

  if (branchContext.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot approve branch with status '${branchContext.branch.status}'. Only 'submitted' branches can be approved.`,
    }
  }

  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)

  const updated = await meta.save({
    branch: { name: branchContext.branch.name, status: 'approved' },
  })

  // TODO: Optionally call githubService.approvePullRequest() when GitHub integration is needed

  return {
    ok: true,
    status: 200,
    data: { branch: toBranchListItem(ctx.services.config, updated.branch) },
  }
}

export const requestChanges = defineEndpoint({
  namespace: 'workflow',
  name: 'requestChanges',
  method: 'POST',
  path: '/:branch/request-changes',
  params: branchParamSchema,
  // body/bodyType removed: comment field was declared but never stored.
  // Re-add when comment storage is implemented (see TODO in handler).
  responseType: 'BranchListItemResponse',
  response: {} as BranchListItemResponse,
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

export const approveBranch = defineEndpoint({
  namespace: 'workflow',
  name: 'approve',
  method: 'POST',
  path: '/:branch/approve',
  params: branchParamSchema,
  responseType: 'BranchListItemResponse',
  response: {} as BranchListItemResponse,
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
