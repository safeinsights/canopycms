import { z } from 'zod'
import { branchParamSchema } from './validators'
import type { ApiContext, ApiRequest } from './types'
import type { BranchContext } from '../types'
import { toBranchListItem, type BranchListItemResponse } from './branch'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { defineEndpoint } from './route-builder'
import { syncConvertToDraft } from './github-sync'
import { syncPrComments } from './pr-comment-sync'
import { CommentStore } from '../comment-store'
import { getErrorMessage } from '../utils/error'
import { REQUEST_CHANGES_NOTE_MAX_LENGTH } from '../authorization/review-role'
import { getBranchProtection } from '../authorization'
import type { CanopyUser } from '../user'
import type { BranchReview } from '../types'
import { sanitizeDisplayName } from '../submission-attribution'

/** Optional on the wire: a bodiless request means no note. */
const requestChangesBodySchema = z
  .object({ note: z.string().trim().max(REQUEST_CHANGES_NOTE_MAX_LENGTH).optional() })
  .optional()

export interface RequestChangesBody {
  /** Saved as a branch comment; trimmed before its length is checked, and ignored when empty. */
  note?: string
}

const NOTE_NOT_SAVED_WARNING = "Changes were requested, but your note couldn't be saved."

/**
 * The 409 for a branch that left review before this request arrived, because the reviewer's page
 * was stale. `action` finishes "so ..." for any status that has no wording of its own.
 */
const staleStatusError = (status: string | undefined, action: string): string =>
  status === 'editing'
    ? "This branch is no longer in review: it's back with its editor."
    : status === undefined
      ? `This branch's status can't be read, so ${action}.`
      : `This branch is ${status}, so ${action}.`

const canRequestChangesFrom = (status: string | undefined) =>
  status === 'submitted' || status === 'approved'

const requestChangesConflict = (status: string | undefined): BranchListItemResponse => ({
  ok: false,
  status: 409,
  error: staleStatusError(status, "changes can't be requested"),
})

const approveConflict = (status: string | undefined): BranchListItemResponse => ({
  ok: false,
  status: 409,
  error:
    status === 'approved'
      ? 'This branch is already approved.'
      : staleStatusError(status, "it can't be approved"),
})

/**
 * The verdict `user` gives. The reviewer guard admits only authenticated users, and the record is
 * always written, so a new verdict replaces whatever the last one left.
 */
const reviewBy = (user: CanopyUser, state: BranchReview['state']): BranchReview => ({
  state,
  by: {
    userId: user.userId,
    name: user.type === 'authenticated' ? sanitizeDisplayName(user.name) : undefined,
  },
  at: new Date().toISOString(),
})

const requestChangesHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
  body: z.infer<typeof requestChangesBodySchema>,
): Promise<BranchListItemResponse> => {
  const { branchContext } = gc

  if (!canRequestChangesFrom(branchContext.branch.status)) {
    return requestChangesConflict(branchContext.branch.status)
  }

  await syncConvertToDraft(ctx, branchContext)

  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)

  // The status the guard read can be stale by now, so the save checks the status on disk, in the
  // same step that writes. A branch that left review meanwhile is refused, and the draft
  // conversion above is left as it is: withdraw converts the pull request to a draft too, and a
  // merged one cannot be converted.
  let found: string | undefined
  const updated = await meta.saveIf(
    {
      branch: {
        name: branchContext.branch.name,
        status: 'editing',
        review: reviewBy(req.user, 'changes-requested'),
      },
    },
    (existing) => {
      found = existing?.branch.status
      return canRequestChangesFrom(found)
    },
  )
  if (!updated) return requestChangesConflict(found)

  // The note is written after the status change so a failed write never blocks the branch from
  // returning to editing; the caller is warned instead.
  const note = body?.note
  let warning: string | undefined
  if (note) {
    try {
      await new CommentStore(branchContext.branchRoot).addComment({
        userId: req.user.userId,
        text: `Changes requested: ${note}`,
        type: 'branch',
      })
    } catch (err) {
      console.error(
        `CanopyCMS: Failed to save the request-changes note for ${branchContext.branch.name}:`,
        getErrorMessage(err),
      )
      warning = NOTE_NOT_SAVED_WARNING
    }
  }

  // After the save and the note, which the PR body renders from, so one update carries both; the
  // draft conversion above never writes the body. The branch is the one the status write returned:
  // the guard read it earlier, and on the queued path the worker can record the PR's number in
  // between. Best-effort: syncPrComments only logs failures.
  await syncPrComments(ctx, { ...branchContext, branch: updated.branch })

  return {
    ok: true,
    status: 200,
    data: {
      branch: toBranchListItem(ctx.services.config, updated.branch, req.user),
      ...(warning && { warning }),
    },
  }
}

const approveBranchHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
): Promise<BranchListItemResponse> => {
  const { branchContext } = gc

  // Approve is a CanopyCMS status only. The CMS authors its pull requests and GitHub refuses
  // an author's approval review, so nothing is sent to GitHub.
  if (branchContext.branch.createdBy === req.user.userId) {
    return {
      ok: false,
      status: 403,
      error: "You can't approve a branch you created. Ask another reviewer to approve it.",
    }
  }

  // Request changes stays open on the base branch, as Withdraw does, to recover one stuck in review.
  const { isProtected } = getBranchProtection(
    ctx.services.config,
    branchContext.branch.name,
    branchContext.branch.baseBranch,
  )
  if (isProtected) {
    return { ok: false, status: 400, error: "The base branch can't be approved." }
  }

  if (branchContext.branch.status !== 'submitted')
    return approveConflict(branchContext.branch.status)

  if (branchContext.branch.pullRequestState === 'closed') {
    return {
      ok: false,
      status: 400,
      error:
        'The pull request was closed on GitHub, so this branch cannot be approved. Withdraw it from review, then submit it again to open a new one.',
    }
  }

  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)

  // As for request changes, the status on disk decides, in the step that writes.
  let found: string | undefined
  const updated = await meta.saveIf(
    {
      branch: {
        name: branchContext.branch.name,
        status: 'approved',
        review: reviewBy(req.user, 'approved'),
      },
    },
    (existing) => {
      found = existing?.branch.status
      return found === 'submitted'
    },
  )
  if (!updated) return approveConflict(found)

  // Against the branch the save returned, as for request changes. Best-effort: syncPrComments
  // only logs failures.
  await syncPrComments(ctx, { ...branchContext, branch: updated.branch })

  return {
    ok: true,
    status: 200,
    data: { branch: toBranchListItem(ctx.services.config, updated.branch, req.user) },
  }
}

export const requestChanges = defineEndpoint({
  namespace: 'workflow',
  name: 'requestChanges',
  method: 'POST',
  path: '/:branch/request-changes',
  params: branchParamSchema,
  body: requestChangesBodySchema,
  bodyType: 'RequestChangesBody',
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
