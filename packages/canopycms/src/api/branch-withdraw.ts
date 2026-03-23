import { z } from 'zod'
import { branchNameSchema } from './validators'
import type { ApiContext, ApiRequest } from './types'
import type { BranchResponse } from './branch'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { defineEndpoint } from './route-builder'
import { canPerformWorkflowAction } from '../authorization'
import { guardBranchExists, isBranchAccessError } from './middleware'
import { syncConvertToDraft } from './github-sync'

const branchParamSchema = z.object({
  branch: branchNameSchema,
})

const withdrawBranchHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamSchema>,
): Promise<BranchResponse> => {
  const accessResult = await guardBranchExists(ctx, params.branch)
  if (isBranchAccessError(accessResult)) return accessResult
  const { context } = accessResult

  // Check if user can perform workflow actions (creator OR ACL access)
  const defaultAccess = ctx.services.config.defaultBranchAccess ?? 'deny'
  const canWithdraw = canPerformWorkflowAction(context, req.user, defaultAccess)
  if (!canWithdraw) {
    return {
      ok: false,
      status: 403,
      error:
        'Only the branch creator or users with explicit branch access can withdraw this branch',
    }
  }

  // Verify branch is in submitted status
  if (context.branch.status !== 'submitted') {
    return {
      ok: false,
      status: 400,
      error: `Cannot withdraw branch with status '${context.branch.status}'. Only 'submitted' branches can be withdrawn.`,
    }
  }

  // Convert PR to draft (sync via githubService, or async via task queue)
  await syncConvertToDraft(ctx, context)

  // Update branch status to 'editing'
  const meta = getBranchMetadataFileManager(context.branchRoot, context.baseRoot)

  const updated = await meta.save({
    branch: { name: context.branch.name, status: 'editing' },
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
  handler: withdrawBranchHandler,
})
