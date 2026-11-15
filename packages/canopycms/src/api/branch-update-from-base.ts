import type { z } from 'zod'
import { branchParamSchema } from './validators'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchContext } from '../types'
import { toBranchListItem, type BranchListItem } from './branch'
import { defineEndpoint } from './route-builder'
import { canPerformWorkflowAction, getBranchProtection } from '../authorization'
import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { clientOperatingStrategy, operatingStrategy } from '../operating-mode'
import { enqueueTask, listTasks } from '../task-queue/cms-task-queue'
import { getTaskQueueDir } from '../task-queue/task-queue-config'
import {
  BASE_UPDATE_GIVE_UP_MS,
  BASE_UPDATE_REQUEST_INTERVAL_MS,
  SYNC_BRANCH_ACTION,
  isBaseUpdatePending,
  type BaseUpdateRun,
} from '../base-update'
import { ContentWriteLockBusyError } from '../utils/content-write-lock'
import { getErrorMessage, redactCredentials } from '../utils/error'
import { baseBranchOf } from '../utils/base-branch'

/**
 * A request for the latest changes: when it was made, which the editor waits on until the
 * branch's `lastBaseUpdate.at` reaches it, and the branch as it stands with the request recorded.
 */
export type UpdateFromBaseResponse = ApiResponse<{ requestedAt: string; branch: BranchListItem }>

/**
 * Ask the worker to bring the base branch into this one now, rather than at its next sync
 * (base-update.ts). Saved work is committed first, locally: the sync skips a branch with
 * uncommitted changes, so without the commit the request would do nothing.
 *
 * The request is recorded on branch.json, which is what the worker answers, so a lost task or a
 * worker restart costs only the wait for its next regular cycle. The task only wakes it early.
 * Where the mode runs no worker loop (operating-mode `baseUpdateRunsInRequest`), a new request runs
 * the worker's merge itself and is answered before the response; one it joins is answered by the
 * run that made it.
 * A request joins the last one, answering with its time: while that is unanswered, under
 * BASE_UPDATE_GIVE_UP_MS old and either under BASE_UPDATE_REQUEST_INTERVAL_MS old or still queued;
 * or once it was answered under BASE_UPDATE_REQUEST_INTERVAL_MS ago without failing. Anything
 * else, a Retry after a failure among them, is a new request.
 */
const updateFromBaseHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
): Promise<UpdateFromBaseResponse> => {
  const { branchContext } = gc
  const { config } = ctx.services
  const { branch } = branchContext

  const runsInRequest = operatingStrategy(config.mode).baseUpdateRunsInRequest()
  if (!clientOperatingStrategy(config.mode).syncsBranchesWithBase()) {
    return {
      ok: false,
      status: 409,
      error: `Getting the latest changes needs the CMS worker, which ${config.mode} mode doesn't run.`,
    }
  }

  const { isProtected } = getBranchProtection(config, branch.name, branch.baseBranch)
  const allowed = canPerformWorkflowAction(
    branchContext,
    req.user,
    config.defaultBranchAccess ?? 'deny',
    { isProtectedBranch: isProtected },
  )
  if (!allowed) {
    return {
      ok: false,
      status: 403,
      error: 'You do not have permission to get the latest changes for this branch.',
    }
  }
  if (isProtected) {
    return {
      ok: false,
      status: 409,
      error: 'This branch is the one changes come from, so it has no latest changes to get.',
    }
  }
  // Only an editing branch takes the base in; the worker leaves the others as they are.
  if (branch.status !== 'editing') {
    return {
      ok: false,
      status: 409,
      error:
        branch.status === 'submitted' || branch.status === 'approved'
          ? 'This branch is in review. Withdraw it from review to get the latest changes.'
          : "This branch can't be edited, so it can't get the latest changes.",
    }
  }

  const base = branch.baseBranch ?? baseBranchOf(config)
  const { authPlugin } = ctx
  try {
    await ctx.services.commitSavedWork({
      context: branchContext,
      message: `Save changes before getting the latest from ${base}`,
      lookupEditor: authPlugin ? (id) => authPlugin.getUserMetadata(id) : undefined,
    })
  } catch (err) {
    if (err instanceof ContentWriteLockBusyError) {
      return {
        ok: false,
        status: 409,
        error:
          err.outcome === 'not-run'
            ? 'This branch is being synced, or a save is in progress. Nothing changed; try again in a moment.'
            : "This branch was being synced while your saved work was prepared, so the latest changes weren't requested. Try again.",
      }
    }
    console.error(
      `CanopyCMS: Could not commit the saved changes of ${branch.name} before getting the latest:`,
      redactCredentials(getErrorMessage(err)),
    )
    return {
      ok: false,
      status: 500,
      error: "Your saved changes couldn't be prepared, so the latest changes weren't requested.",
    }
  }

  const taskDir = getTaskQueueDir(config)
  const queued =
    !runsInRequest &&
    (await listTasks(taskDir, 'pending', Number.MAX_SAFE_INTEGER)).some(
      (t) => t.action === SYNC_BRANCH_ACTION && t.payload.branch === branch.name,
    )
  const now = Date.now()
  let requestedAt = new Date(now).toISOString()
  let joined = false
  let leftEditing: string | undefined
  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)
  const saved = await meta.update(
    (existing) => {
      if (existing?.branch.name !== branch.name) return null
      // A submit since the guard read: the worker would leave the request standing until a withdraw.
      if (existing.branch.status !== 'editing') {
        leftEditing = existing.branch.status
        return null
      }
      const last = existing.branch.baseUpdateRequestedAt
      const age = last === undefined ? Infinity : now - Date.parse(last)
      const answer = existing.branch.lastBaseUpdate
      const pending = isBaseUpdatePending(existing.branch)
      // An unanswered request is joined until the editor stops waiting on it. An answer under the
      // interval old stands for a new click too, except a failure, whose Retry must ask again, and
      // except where the request runs the merge itself, which costs no worker cycle.
      const joinsPending =
        pending && age < BASE_UPDATE_GIVE_UP_MS && (queued || age < BASE_UPDATE_REQUEST_INTERVAL_MS)
      const answeredRecently =
        !runsInRequest &&
        !pending &&
        answer !== undefined &&
        answer.outcome !== 'failed' &&
        now - Date.parse(answer.at) < BASE_UPDATE_REQUEST_INTERVAL_MS
      if (last !== undefined && (joinsPending || answeredRecently)) {
        requestedAt = last
        joined = true
        return null
      }
      return { branch: { baseUpdateRequestedAt: requestedAt } }
    },
    { keepUpdatedAt: true },
  )
  if (leftEditing) {
    return {
      ok: false,
      status: 409,
      error:
        leftEditing === 'submitted' || leftEditing === 'approved'
          ? 'This branch is in review. Withdraw it from review to get the latest changes.'
          : "This branch can't be edited, so it can't get the latest changes.",
    }
  }
  let current = saved ?? (await BranchMetadataFileManager.loadOnly(branchContext.branchRoot))
  if (current?.branch.name !== branch.name) {
    return { ok: false, status: 404, error: 'This branch no longer exists.' }
  }

  // A joined request is answered by the run that made it.
  if (runsInRequest && !joined) {
    // Answered here where the run couldn't, as nothing else would: an open request holds the form
    // read-only.
    const answerFailed = () =>
      meta
        .update(
          (existing) =>
            existing?.branch.name === branch.name &&
            existing.branch.baseUpdateRequestedAt === requestedAt &&
            isBaseUpdatePending(existing.branch)
              ? { branch: { lastBaseUpdate: { at: requestedAt, outcome: 'failed' } } }
              : null,
          { keepUpdatedAt: true },
        )
        .catch(() => undefined)
    let run: BaseUpdateRun
    try {
      run = await ctx.services.runBaseUpdateNow(branchContext)
    } catch (err) {
      console.error(
        `CanopyCMS: Could not bring the latest changes into ${branch.name}:`,
        redactCredentials(getErrorMessage(err)),
      )
      await answerFailed()
      return {
        ok: false,
        status: 500,
        error: "The latest changes couldn't be added. Your work is safe.",
      }
    }
    if (run === 'other-remote') {
      await answerFailed()
      return {
        ok: false,
        status: 409,
        error:
          "This branch uses a git remote other than the local one, so its latest changes can't be brought in here.",
      }
    }
    if (run === 'busy') {
      return {
        ok: false,
        status: 409,
        error:
          "This branch is busy with a save or another update, so the latest changes weren't added. Try again in a moment.",
      }
    }
    current = await BranchMetadataFileManager.loadOnly(branchContext.branchRoot)
    if (current?.branch.name !== branch.name) {
      return { ok: false, status: 404, error: 'This branch no longer exists.' }
    }
  }

  // A wake-up already queued serves the new request too.
  if (!runsInRequest && !joined && !queued) {
    try {
      await enqueueTask(taskDir, { action: SYNC_BRANCH_ACTION, payload: { branch: branch.name } })
    } catch (err) {
      // The worker's next regular sync answers the recorded request anyway, only later.
      console.warn(
        `CanopyCMS: Could not queue the request for the latest changes on ${branch.name}:`,
        getErrorMessage(err),
      )
    }
  }

  return {
    ok: true,
    status: 202,
    data: { requestedAt, branch: toBranchListItem(config, current.branch, req.user) },
  }
}

/** Get the latest changes: bring the base branch into this one at the worker's next chance. */
export const updateFromBase = defineEndpoint({
  namespace: 'workflow',
  name: 'updateFromBase',
  // Commits saved work on the shared filesystem before answering.
  clientTimeout: 'long',
  method: 'POST',
  path: '/:branch/update-from-base',
  params: branchParamSchema,
  responseType: 'UpdateFromBaseResponse',
  response: {} as UpdateFromBaseResponse,
  defaultMockData: {
    requestedAt: '2024-01-01T00:00:00.000Z',
    branch: {
      name: 'test-branch',
      status: 'editing',
      access: {},
      createdBy: 'user-1',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      baseUpdateRequestedAt: '2024-01-01T00:00:00.000Z',
    },
  },
  // As Withdraw: the handler's canPerformWorkflowAction decides who may ask.
  guards: ['branch'] as const,
  handler: updateFromBaseHandler,
})
