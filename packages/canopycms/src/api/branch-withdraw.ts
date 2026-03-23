import { z } from 'zod'
import { branchNameSchema } from './validators'
import type { ApiContext, ApiRequest } from './types'
import type { BranchContext } from '../types'
import type { BranchResponse } from './branch'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { defineEndpoint } from './route-builder'
import { canPerformWorkflowAction } from '../authorization'
import { syncConvertToDraft } from './github-sync'

const branchParamSchema = z.object({
  branch: branchNameSchema,
})

const withdrawBranchHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
): Promise<BranchResponse> => {
  const { branchContext } = gc

  // Check if user can perform workflow actions (creator OR ACL access)
  const defaultAccess = ctx.services.config.defaultBranchAccess ?? 'deny'
  const canWithdraw = canPerformWorkflowAction(branchContext, req.user, defaultAccess)
  if (!canWithdraw) {
    return {
      ok: false,
      status: 403,
      error:
        'Only the branch creator or users with explicit branch access can withdraw this branch',
    }
  }

  // Verify branch is in submitted status
  if (branchContext.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot withdraw branch with status '${branchContext.branch.status}'. Only 'submitted' branches can be withdrawn.`,
    }
  }

  // Convert PR to draft (sync via githubService, or async via task queue)
  await syncConvertToDraft(ctx, branchContext)

  // Update branch status to 'editing'
  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)

  const updated = await meta.save({
    branch: { name: branchContext.branch.name, status: 'editing' },
  })

  return { ok: true, status: 200, data: { branch: updated.branch } }
}

/**
 * Withdraw a submitted branch, converting the PR to draft and unlocking editing
 * POST /:branch/withdraw
 */
export const withdrawBranch = defineEndpoint({
  namespace: 'workflow',
  name: 'withdraw',
  method: 'POST',
  path: '/:branch/withdraw',
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
  guards: ['branch'] as const,
  handler: withdrawBranchHandler,
})
