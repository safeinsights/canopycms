import { z } from 'zod'
import { branchParamSchema } from './validators'
import type { ApiContext, ApiRequest } from './types'
import type { BranchContext } from '../types'
import { toBranchListItem, type BranchListItemResponse } from './branch'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { defineEndpoint } from './route-builder'
import { syncConvertToDraft } from './github-sync'
import { CommentStore } from '../comment-store'
import { getErrorMessage } from '../utils/error'
import { REQUEST_CHANGES_NOTE_MAX_LENGTH } from '../authorization/review-role'
import { getBranchProtection } from '../authorization'

/** Optional on the wire: a bodiless request means no note. */
const requestChangesBodySchema = z
  .object({ note: z.string().trim().max(REQUEST_CHANGES_NOTE_MAX_LENGTH).optional() })
  .optional()

export interface RequestChangesBody {
  /** Saved as a branch comment; trimmed before its length is checked, and ignored when empty. */
  note?: string
}

const NOTE_NOT_SAVED_WARNING = "Changes were requested, but your note couldn't be saved."

/** A branch that left review before this request arrived: the reviewer's page was stale. */
const staleStatusError = (status: string | undefined, whenInReview: string): string =>
  status === 'editing'
    ? 'This branch is no longer in review. Its editor has it back for editing.'
    : whenInReview

const requestChangesHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
  body: z.infer<typeof requestChangesBodySchema>,
): Promise<BranchListItemResponse> => {
  const { branchContext } = gc

  const { status } = branchContext.branch
  if (status !== 'submitted' && status !== 'approved') {
    return {
      ok: false,
      status: 409,
      error: staleStatusError(status, `This branch is ${status}, so changes can't be requested.`),
    }
  }

  await syncConvertToDraft(ctx, branchContext)

  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)

  const updated = await meta.save({
    branch: { name: branchContext.branch.name, status: 'editing' },
  })

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

  const { status } = branchContext.branch
  if (status !== 'submitted') {
    return {
      ok: false,
      status: 409,
      error:
        status === 'approved'
          ? 'This branch is already approved.'
          : staleStatusError(status, `This branch is ${status}, so it can't be approved.`),
    }
  }

  if (branchContext.branch.pullRequestState === 'closed') {
    return {
      ok: false,
      status: 400,
      error:
        'The pull request was closed on GitHub, so this branch cannot be approved. Withdraw it from review, then submit it again to open a new one.',
    }
  }

  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)

  const updated = await meta.save({
    branch: { name: branchContext.branch.name, status: 'approved' },
  })

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
