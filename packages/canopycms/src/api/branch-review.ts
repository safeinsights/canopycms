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
import { assertNoOpenConflicts, OpenMergeConflictsError } from '../merge-conflicts'
import { ContentWriteLockBusyError, withContentWriteLock } from '../utils/content-write-lock'
import { getErrorMessage } from '../utils/error'
import { REQUEST_CHANGES_NOTE_MAX_LENGTH } from '../authorization/review-role'
import { getBranchProtection, isAdmin } from '../authorization'
import type { CanopyUser } from '../user'
import type { BranchReview } from '../types'
import { sanitizeDisplayName } from '../submission-attribution'

/** Optional on the wire, so a request without one gets {@link BRANCH_MOVED_ERROR}, not a 400. */
const headShaSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  .optional()

const requestChangesBodySchema = z
  .object({
    note: z.string().trim().max(REQUEST_CHANGES_NOTE_MAX_LENGTH).optional(),
    headSha: headShaSchema,
  })
  .optional()

const approveBodySchema = z.object({ headSha: headShaSchema }).optional()

/** What a verdict carries besides the branch: the commit the reviewer's page showed. */
interface ReviewedHead {
  /** The listing's `headSha` (api/branch.ts) the page was showing. */
  headSha?: string
}

export interface RequestChangesBody extends ReviewedHead {
  /** Saved as a branch comment; trimmed before its length is checked, and ignored when empty. */
  note?: string
}

export type ApproveBody = ReviewedHead

/** @internal Exported for tests. */
export const BRANCH_MOVED_ERROR =
  'This branch changed since you opened it. Review the latest changes.'

const branchMoved: BranchListItemResponse = {
  ok: false,
  status: 409,
  code: 'BRANCH_MOVED',
  error: BRANCH_MOVED_ERROR,
}

class BranchMovedError extends Error {
  override readonly name = 'BranchMovedError'
}

class HeadUnreadableError extends Error {
  override readonly name = 'HeadUnreadableError'
}

const headUnreadable: BranchListItemResponse = {
  ok: false,
  status: 503,
  error: "Couldn't read this branch right now. Try again in a moment.",
}

/**
 * Throws unless the clone's HEAD is `sent`, the commit the reviewer saw, and returns it. A request
 * naming none, from a page loaded before the editor sent one, is refused: what it showed is
 * unknown. Called under the content-write lock: a submit and the worker move HEAD only while
 * holding it, so the head checked is the one the verdict is written against.
 */
const assertReviewedHead = async (
  ctx: ApiContext,
  { branch, branchRoot }: BranchContext,
  sent: string | undefined,
): Promise<string> => {
  if (!sent) throw new BranchMovedError()
  let head: string
  try {
    const git = ctx.services.createGitManagerFor(branchRoot, { baseBranch: branch.baseBranch })
    head = await git.headSha()
  } catch (err) {
    console.error(`CanopyCMS: Could not read the head of ${branch.name}:`, getErrorMessage(err))
    throw new HeadUnreadableError()
  }
  if (head !== sent) throw new BranchMovedError()
  return sent
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
const reviewBy = (
  user: CanopyUser,
  state: BranchReview['state'],
  commit: string,
): BranchReview => ({
  state,
  by: {
    userId: user.userId,
    name: user.type === 'authenticated' ? sanitizeDisplayName(user.name) : undefined,
  },
  at: new Date().toISOString(),
  commit,
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

  const headSha = body?.headSha
  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)

  // The status the guard read can be stale by now, so the save checks the status on disk, in the
  // same step that writes, and the head under the lock with it. A branch that left review or moved
  // meanwhile is refused before the pull request is touched.
  let found: string | undefined
  let updated: Awaited<ReturnType<typeof meta.saveIf>>
  try {
    updated = await withContentWriteLock(branchContext.branchRoot, async () => {
      const commit = await assertReviewedHead(ctx, branchContext, headSha)
      return meta.saveIf(
        {
          branch: {
            name: branchContext.branch.name,
            status: 'editing',
            review: reviewBy(req.user, 'changes-requested', commit),
          },
        },
        (existing) => {
          found = existing?.branch.status
          return canRequestChangesFrom(found)
        },
      )
    })
  } catch (err) {
    if (err instanceof BranchMovedError) return branchMoved
    if (err instanceof HeadUnreadableError) return headUnreadable
    if (err instanceof ContentWriteLockBusyError) {
      return {
        ok: false,
        status: 409,
        error:
          err.outcome === 'not-run'
            ? "This branch is being synced, so changes weren't requested. Try again in a moment."
            : 'This branch was being synced while changes were requested, so the request may not have been recorded. Refresh to check.',
      }
    }
    throw err
  }
  if (!updated) return requestChangesConflict(found)

  // Best-effort: syncConvertToDraft only logs a failure.
  await syncConvertToDraft(ctx, { ...branchContext, branch: updated.branch })

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
  body: z.infer<typeof approveBodySchema>,
): Promise<BranchListItemResponse> => {
  const { branchContext } = gc
  const headSha = body?.headSha

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

  // As for request changes, the status on disk and the head decide, in the step that writes. So
  // does an unfinished submit: what's approved may not be what the pull request holds. So do
  // conflicts: a merge of GitHub's commits can record some on a branch in review, under the
  // content-write lock held here, so none lands between the check and the write.
  let found: string | undefined
  let unfinished = false
  let notQueued = false
  let updated: Awaited<ReturnType<typeof meta.saveIf>>
  try {
    updated = await withContentWriteLock(branchContext.branchRoot, async () => {
      const commit = await assertReviewedHead(ctx, branchContext, headSha)
      await assertNoOpenConflicts(branchContext.branchRoot)
      return meta.saveIf(
        {
          branch: {
            name: branchContext.branch.name,
            status: 'approved',
            review: reviewBy(req.user, 'approved', commit),
          },
        },
        (existing) => {
          found = existing?.branch.status
          unfinished = existing?.branch.submitUnfinished === true
          notQueued = existing?.branch.submitNotQueued === true
          return found === 'submitted' && !unfinished
        },
      )
    })
  } catch (err) {
    if (err instanceof BranchMovedError) return branchMoved
    if (err instanceof HeadUnreadableError) return headUnreadable
    if (err instanceof OpenMergeConflictsError) {
      return {
        ok: false,
        status: 409,
        code: 'OPEN_CONFLICTS',
        error:
          err.count === null
            ? err.message
            : `${err.message} Use "Request changes" so its editor can choose what to keep.`,
      }
    }
    if (err instanceof ContentWriteLockBusyError) {
      return {
        ok: false,
        status: 409,
        error:
          err.outcome === 'not-run'
            ? 'This branch is being synced, or a save is in flight, so it was not approved. Try again in a moment.'
            : 'This branch was being synced while it was approved, so the approval may not have been recorded. Refresh to check.',
      }
    }
    throw err
  }
  if (unfinished && found === 'submitted') {
    return {
      ok: false,
      status: 409,
      error:
        "This branch's last submit didn't finish, so it can't be approved until it does. " +
        (notQueued
          ? 'Use "Request changes" to send it back to its editor.'
          : isAdmin(req.user.groups)
            ? 'Retry the submit from the "Tasks" tab in "System health".'
            : 'Ask an admin to retry the submit.'),
    }
  }
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
  body: approveBodySchema,
  bodyType: 'ApproveBody',
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
