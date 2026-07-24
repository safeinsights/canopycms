import { z } from 'zod'
import { branchParamSchema } from './validators'
import type { ApiContext, ApiRequest } from './types'
import type { BranchContext } from '../types'
import type { BranchResponse } from './branch'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { defineEndpoint } from './route-builder'
import { canPerformWorkflowAction, getBranchProtection } from '../authorization'
import { syncConvertToDraft } from './github-sync'

const withdrawBranchHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
): Promise<BranchResponse> => {
  const { branchContext } = gc

  // Check if user can perform workflow actions (creator OR ACL access). On the
  // protected base branch, the system-branch grant is disabled -- withdraw is
  // still allowed (it's the only self-serve recovery for a base branch wrongly
  // stuck in 'submitted'), but restricted to privileged/creator/ACL users.
  const defaultAccess = ctx.services.config.defaultBranchAccess ?? 'deny'
  const { isProtected } = getBranchProtection(
    ctx.services.config,
    branchContext.branch.name,
    branchContext.branch.baseBranch,
  )
  const canWithdraw = canPerformWorkflowAction(branchContext, req.user, defaultAccess, {
    isProtectedBranch: isProtected,
  })
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

  // Convert PR to draft (sync via githubService, or async via task queue) --
  // but a PR closed on GitHub without merging can't be converted to draft.
  // Withdraw (back to 'editing') is the deliberate recovery path for a
  // closed-unmerged PR, and a later resubmit opens a fresh PR via
  // createOrUpdatePullRequest, so skip the conversion in that case.
  const wasClosed = branchContext.branch.pullRequestState === 'closed'
  if (!wasClosed) {
    await syncConvertToDraft(ctx, branchContext)
  }

  // Update branch status to 'editing'. A closed PR is dead after withdraw
  // (resubmit opens a fresh one), so drop its metadata rather than leaving a
  // stale PR chip on an editing branch; a drafted PR is still live, so keep it.
  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)

  const updated = await meta.save({
    branch: {
      name: branchContext.branch.name,
      status: 'editing',
      ...(wasClosed
        ? { pullRequestState: undefined, pullRequestNumber: undefined, pullRequestUrl: undefined }
        : {}),
    },
  })

  return { ok: true, status: 200, data: { branch: updated.branch } }
}

/**
 * Withdraw a submitted branch, converting the PR to draft and unlocking editing
 * POST /:branch/withdraw
 *
 * Deliberately no 'submittableBranch' guard: withdraw is the only self-serve
 * recovery path for a base branch wrongly stuck in 'submitted' (e.g. a failed
 * submit backstop, see services.ts submitBranch / github-sync.ts syncSubmitPr).
 * The handler restricts it on protected branches via canPerformWorkflowAction's
 * isProtectedBranch option instead of blocking it outright.
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
