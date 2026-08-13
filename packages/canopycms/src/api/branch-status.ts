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
import { canPerformWorkflowAction, getBranchProtection } from '../authorization'
import { syncSubmitPr } from './github-sync'
import { getErrorMessage, redactCredentials, sanitizeErrorMessage } from '../utils/error'
import { isNonFastForwardRejection } from '../utils/git'

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

  // Check if user can perform workflow actions (creator OR ACL access). isProtectedBranch
  // is passed for defense-in-depth (disables the system-branch grant); the 'submittableBranch'
  // guard above already refuses base-branch submits outright before the handler runs.
  const defaultAccess = ctx.services.config.defaultBranchAccess ?? 'deny'
  const { isProtected } = getBranchProtection(
    ctx.services.config,
    branchContext.branch.name,
    branchContext.branch.baseBranch,
  )
  const canSubmit = canPerformWorkflowAction(branchContext, req.user, defaultAccess, {
    isProtectedBranch: isProtected,
  })
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
    const message = getErrorMessage(err)
    // Full path detail (including branchRoot, an absolute path) to server logs
    // only; the client only ever sees the sanitized form (API-H2). Credentials
    // (e.g. x-access-token:TOKEN@github.com in git errors) are redacted even
    // from server logs — a live installation token must never persist in logs.
    console.error(
      `CanopyCMS: Failed to push branch changes (${branchContext.branchRoot}):`,
      redactCredentials(message),
    )

    // A non-fast-forward rejection means this branch and the deployment's
    // local repository have diverged. Retrying the identical push can never
    // succeed (see isNonFastForwardRejection), so surface 409 instead of the
    // generic 500 below. Everything else (network, auth, lock contention)
    // keeps the existing 500 path unchanged.
    //
    // This push targets the deployment's OWN local origin (remote.git), not
    // GitHub, so the message deliberately states only the observable fact and
    // names no cause: a foreign deployment cannot reach this repo, and the
    // realistic explanations are all internal (the worker's rebase loop
    // reconciling the branch, or a commit reaching remote.git that this
    // workspace never had). It also never advises renaming the branch --
    // a branch that reaches this point has usually been submitted before, so
    // it may well have an open PR that a rename would orphan.
    if (isNonFastForwardRejection(message)) {
      return {
        ok: false,
        status: 409,
        error:
          `Could not submit "${branchContext.branch.name}": it has diverged from the copy in ` +
          `this deployment's repository and needs to be reconciled before it can be submitted. ` +
          `The background worker reconciles branches when the base branch moves, so this often ` +
          `clears on its own within a few minutes -- try again shortly, and ask an administrator ` +
          `to check the worker if it persists.`,
      }
    }

    return {
      ok: false,
      status: 500,
      error: `Failed to push branch changes: ${sanitizeErrorMessage(message)}`,
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
      // PR-W2 (M2): the rebase loop skips submitted/approved branches, so a
      // pre-submit rebase-failure record would otherwise stick as a stale
      // warning through review and archive.
      rebaseFailure: undefined,
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
  // finer-grained authorization (creator OR ACL access). 'submittableBranch' blocks the
  // base branch outright (both modes — submitting it would push straight to itself).
  guards: ['branch', 'submittableBranch'] as const,
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
