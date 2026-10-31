import { z } from 'zod'
import { branchParamSchema } from './validators'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchContext } from '../types'
import { toBranchListItem, type BranchListItem, type BranchListItemResponse } from './branch'
import type { StampedEntry } from '../stamp-on-publish'
import { getBranchMetadataFileManager } from '../branch-metadata'
import { withdrawBranch } from './branch-withdraw'
import { requestChanges, approveBranch } from './branch-review'
import { markAsMerged } from './branch-merge'
import { defineEndpoint } from './route-builder'
import { canPerformWorkflowAction, getBranchProtection, isAdmin } from '../authorization'
import { syncSubmitPr } from './github-sync'
import { getErrorMessage, redactCredentials, sanitizeErrorMessage } from '../utils/error'
import { isNonFastForwardRejection } from '../utils/git'
import { ContentWriteLockBusyError } from '../utils/content-write-lock'
import { submissionEditorFromUser, type SubmissionEditor } from '../submission-attribution'
import { NothingToSubmitError } from '../services'
import { baseBranchOf } from '../utils/base-branch'
import { shortNameOf } from '../branch-param'
import { resolveEditorUrl } from '../editor-url'

// Re-export for client generation
export type { BranchMergeResponse } from './branch-merge'
export type { RequestChangesBody } from './branch-review'

/**
 * A submit's answer: the branch, plus the entries the submit stamped (stamp-on-publish.ts) when
 * there were any, so the editor can carry its open forms and drafts onto their new versions.
 */
export type SubmitBranchResponse = ApiResponse<{
  branch: BranchListItem
  stamped?: StampedEntry[]
}>

const getBranchStatusHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
): Promise<BranchListItemResponse> => {
  const { branchContext } = gc

  return {
    ok: true,
    status: 200,
    data: { branch: toBranchListItem(ctx.services.config, branchContext.branch, req.user) },
  }
}

const submitBranchBodySchema = z
  .object({
    /** The editor page's URL (`location.origin + location.pathname`), for the PR body's links. */
    // Any value but a usable URL costs only the links (editor-url.ts), never the submit.
    editorUrl: z.string().optional().catch(undefined),
  })
  .optional()

/** The submit request body. */
export type SubmitBranchBody = z.infer<typeof submitBranchBodySchema>

/**
 * The editor URL the PR body links to: `config.editorUrl`, else the URL the editor reported
 * when the request was addressed to its host (editor-url.ts). A reported URL that fails that
 * check is logged once per submit, since every link then goes missing.
 */
function submitEditorUrl(ctx: ApiContext, req: ApiRequest, claimed: string | undefined) {
  const configured = ctx.services.config.editorUrl
  const resolved = resolveEditorUrl({
    configured,
    claimed,
    header: req.rawRequest ? (name) => req.rawRequest?.header(name) ?? null : undefined,
  })
  if (!resolved && !configured && claimed) {
    console.warn(
      'CanopyCMS: The pull request body has no editor links: the editor URL the browser reported ' +
        'is not on the host the request was addressed to (X-Forwarded-Host, else Host). Set ' +
        'editorUrl in the CanopyCMS config to the editor page URL.',
    )
  }
  return resolved
}

const submitBranchForMergeHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
  body: SubmitBranchBody,
): Promise<SubmitBranchResponse> => {
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
      error: 'You do not have permission to submit this branch for review.',
    }
  }

  // Only an 'editing' branch may be submitted, mirroring
  // getBranchWriteProtection's status gate exactly so "can I edit this?" and
  // "can I submit this?" stay one question. Without this, an archived
  // (merged) branch could be re-submitted by its creator, re-stamping it
  // 'submitted' and overwriting the merged PR's title/body.
  //
  // Fails closed on a missing status, same as runWritableBranchGuard's
  // unreadable-status arm.
  const status = branchContext.branch.status
  if (status !== 'editing') {
    return {
      ok: false,
      status: 400,
      error:
        status === undefined
          ? `Branch "${branchContext.branch.name}" has no readable workflow status and cannot be submitted until its metadata is repaired.`
          : `Cannot submit branch with status '${status}'. Only 'editing' branches can be submitted.`,
    }
  }

  // The worker pushes nothing for such a branch, so this would commit and report a failure later.
  if (branchContext.branch.rewrittenOnGitHub !== undefined) {
    return {
      ok: false,
      status: 409,
      error:
        `"${shortNameOf(ctx.services.config, branchContext.branch.name)}" was changed on GitHub in ` +
        "a way CanopyCMS can't combine with the work here, so it can't be submitted. Nothing is " +
        'lost. ' +
        (isAdmin(req.user.groups)
          ? 'See the "Branches" tab in "System health".'
          : 'Ask an admin for help.'),
    }
  }

  // Commit and push changes
  const submitter = submissionEditorFromUser(req.user)
  const { authPlugin } = ctx
  let changedPaths: string[]
  let editors: SubmissionEditor[]
  let entryPaths: Map<string, string>
  let stamped: StampedEntry[]
  try {
    ;({ changedPaths, editors, entryPaths, stamped } = await ctx.services.submitBranch({
      context: branchContext,
      submitter,
      lookupEditor: authPlugin ? (id) => authPlugin.getUserMetadata(id) : undefined,
    }))
  } catch (err) {
    if (err instanceof NothingToSubmitError) {
      return { ok: false, status: 400, error: err.message }
    }
    const shortName = shortNameOf(ctx.services.config, branchContext.branch.name)
    // Retriable either way: a resubmit commits nothing new and pushes only
    // what has not reached the remote.
    if (err instanceof ContentWriteLockBusyError) {
      return {
        ok: false,
        status: 409,
        error:
          err.outcome === 'not-run'
            ? `Could not submit "${shortName}" right now: it is being synced with its base branch, or a save is in flight. Nothing was submitted; try again in a moment.`
            : `"${shortName}" was being synced while it was submitted, so the submit may not have completed. Try submitting again.`,
      }
    }
    const message = getErrorMessage(err)
    // Full path detail (including branchRoot, an absolute path) to server logs
    // only; the client only ever sees the sanitized form (API-H2). Credentials
    // (e.g. x-access-token:TOKEN@github.com in git errors) are redacted even
    // from server logs — a live installation token must never persist in logs.
    console.error(
      `CanopyCMS: Failed to push branch changes (${branchContext.branchRoot}):`,
      redactCredentials(message),
    )

    // This push targets the deployment's OWN remote.git, so a non-fast-forward
    // rejection means it holds a commit this clone lacks, which reached it from
    // GitHub (worker/github-commits.ts). The commit made above stays: the tree is
    // then clean, which is what the worker's merge needs, and the next submit
    // pushes the result. A branch that reaches this point has usually been
    // submitted before, so the message never advises renaming it: that would
    // orphan its open PR.
    if (isNonFastForwardRejection(message)) {
      return {
        ok: false,
        status: 409,
        error:
          `Could not submit "${shortName}": it has commits from GitHub that aren't in the editor ` +
          `yet. Your saved changes are safe. CanopyCMS brings those commits in at its next sync, ` +
          `usually within a few minutes, so submit again then. If this keeps happening, ` +
          `${isAdmin(req.user.groups) ? 'check' : 'ask an admin to check'} "System health".`,
      }
    }

    return {
      ok: false,
      status: 500,
      error: `Failed to push branch changes: ${sanitizeErrorMessage(message)}`,
    }
  }

  // The verdict covers one submit. It is cleared on disk before the PR is written, because a
  // comment sync between that write and the status save below renders the PR body from disk and
  // would otherwise put the last round's verdict back on the new body.
  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)
  if (branchContext.branch.review) {
    await meta.save({ branch: { name: branchContext.branch.name, review: undefined } })
  }

  // Create or update PR (sync via githubService, or async via task queue)
  const submittedAt = new Date().toISOString()
  const editorUrl = submitEditorUrl(ctx, req, body?.editorUrl)
  const prResult = await syncSubmitPr(ctx, branchContext, {
    submitter,
    editors,
    changedPaths,
    entryPaths,
    editorUrl,
    submittedAt,
  })

  const pushed = prResult.pushedToGitHub ? { pushedToGitHubAt: submittedAt } : {}
  // GitHub found nothing between the pushed branch and its base, though the diff above found
  // changes: GitHub's base can already hold them, or the diff could not be computed. The branch
  // stays editable; the stamp records that it is now on GitHub, for delete.
  if (prResult.nothingToSubmit) {
    await meta.save({ branch: { name: branchContext.branch.name, ...pushed } })
    const base = branchContext.branch.baseBranch ?? baseBranchOf(ctx.services.config)
    return {
      ok: false,
      status: 400,
      error: new NothingToSubmitError(
        shortNameOf(ctx.services.config, branchContext.branch.name),
        base,
      ).message,
    }
  }

  const updated = await meta.save({
    branch: {
      name: branchContext.branch.name,
      status: 'submitted',
      submittedAt,
      ...pushed,
      // Only a request-derived URL: config.editorUrl is read live by every later re-render.
      ...(editorUrl && !ctx.services.config.editorUrl ? { editorUrl } : {}),
      syncFailureReason: prResult.syncFailureReason,
      pullRequestUrl: prResult.prUrl ?? branchContext.branch.pullRequestUrl,
      pullRequestNumber: prResult.prNumber ?? branchContext.branch.pullRequestNumber,
      ...(prResult.syncStatus !== undefined ? { syncStatus: prResult.syncStatus } : {}),
      // PR-W2 (M2): the rebase loop skips submitted/approved branches, so a
      // pre-submit rebase-failure record would otherwise stick as a stale
      // warning through review and archive.
      rebaseFailure: undefined,
      review: undefined,
      // Read by the card as soon as the status says review, and the worker's next read is minutes
      // away, so what held the last submit must not show as holding this one.
      pullRequestHold: undefined,
      submitUnfinished: undefined,
    },
  })

  return {
    ok: true,
    status: 200,
    data: {
      branch: toBranchListItem(ctx.services.config, updated.branch, req.user),
      ...(stamped.length > 0 ? { stamped } : {}),
    },
  }
}

const getBranchStatus = defineEndpoint({
  namespace: 'workflow',
  name: 'getStatus',
  method: 'GET',
  path: '/:branch/status',
  params: branchParamSchema,
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
  guards: ['branchAccess'] as const,
  handler: getBranchStatusHandler,
})

const submitBranchForMerge = defineEndpoint({
  namespace: 'workflow',
  name: 'submit',
  clientTimeout: 'long',
  method: 'POST',
  path: '/:branch/submit',
  params: branchParamSchema,
  body: submitBranchBodySchema,
  bodyType: 'SubmitBranchBody',
  responseType: 'SubmitBranchResponse',
  response: {} as SubmitBranchResponse,
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

export const WORKFLOW_ROUTES = {
  getStatus: getBranchStatus,
  submit: submitBranchForMerge,
  withdraw: withdrawBranch,
  requestChanges: requestChanges,
  approve: approveBranch,
  markMerged: markAsMerged,
} as const
