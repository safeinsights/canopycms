import { z } from 'zod'

import {
  ageDeletionHold,
  archivedBefore,
  archivedCutoff,
  deletableByAge,
  type AgeDeletionHold,
} from '../branch-archive'
import { deleteBranchWorkspace } from '../branch-delete'
import { buildUnmergedArchiveUpdate, getBranchMetadataFileManager } from '../branch-metadata'
import { clientOperatingStrategy, operatingStrategy } from '../operating-mode'
import { isSettingsBranchName } from '../paths'
import { getBranchProtection } from '../authorization'
import type { BranchContext } from '../types'
import { getErrorMessage } from '../utils/error'
import { branchDeleteOptions } from './branch'
import type { BranchMergeResponse } from './branch-merge'
import { defineEndpoint } from './route-builder'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { branchNameSchema } from './validators'

const archiveBranchParamsSchema = z.object({ branch: branchNameSchema })

const archiveBranchHandler = async (
  gc: { branchContext: BranchContext },
  _ctx: ApiContext,
): Promise<BranchMergeResponse> => {
  const { branchContext } = gc
  const name = branchContext.branch.name
  const meta = getBranchMetadataFileManager(branchContext.branchRoot, branchContext.baseRoot)
  const archived = await meta.update((current) =>
    current?.branch.name === name &&
    current.branch.status !== 'archived' &&
    current.branch.pullRequestState === 'closed'
      ? { branch: buildUnmergedArchiveUpdate() }
      : null,
  )
  if (archived === null) {
    return {
      ok: false,
      status: 409,
      error: 'Only a branch whose pull request closed without merging can be archived this way.',
    }
  }
  return { ok: true, status: 200, data: { branch: { name, status: 'archived' } } }
}

/**
 * Archive a branch whose PR closed without merging. A close never changes the status by itself,
 * so this is an admin's decision that the work is abandoned. The handler's checks run on the
 * branch.json read under its lock, where a reopened PR or a resubmit since the guard read refuses
 * it. They also cover the base branch, which has no PR.
 */
const archiveBranch = defineEndpoint({
  namespace: 'workflow',
  name: 'archive',
  method: 'POST',
  path: '/:branch/archive',
  params: archiveBranchParamsSchema,
  responseType: 'BranchMergeResponse',
  response: {} as BranchMergeResponse,
  defaultMockData: { branch: { name: 'test-branch', status: 'archived' } },
  guards: ['admin', 'branch'] as const,
  handler: archiveBranchHandler,
})

export const ARCHIVE_BRANCH_ROUTES = { archive: archiveBranch } as const

/**
 * Wall-clock budget for starting deletes, well inside the CMS Lambda's default 60 s timeout
 * (`DEFAULT_CMS_LAMBDA_TIMEOUT` in canopycms-cdk), so one slow `rm` can still finish. A Lambda
 * killed in an `rm` costs nothing: the branch is already gone, and the worker sweeps what is left.
 * @internal Exported for tests.
 */
export const DELETE_ARCHIVED_BUDGET_MS = 25_000

const deleteArchivedBranchesBodySchema = z.object({
  olderThanDays: z.number().int().min(1),
  branches: z.array(z.string()),
})

export interface DeleteArchivedBranchesBody {
  olderThanDays: number
  /** The full names the admin confirmed. Nothing outside them is deleted. */
  branches: string[]
}

interface DeleteArchivedBranchesData {
  /** Full names of the branches deleted. */
  deleted: string[]
  /** Old enough, but left for a person to delete, by reason (`ageDeletionHold`). */
  skipped: { notMerged: string[]; unpublished: string[]; movedOnGitHub: string[] }
  /** Old enough, but not deleted: busy, gone, or changed since they were listed. */
  failed: string[]
  /** Not reached before the time budget ran out; asking again continues. */
  remaining: number
  /** Deleted, with something left behind; show it to the admin. */
  warnings: string[]
}

/** Response type for POST /admin/archived-branches/delete */
export type DeleteArchivedBranchesResponse = ApiResponse<DeleteArchivedBranchesData>

/** @internal Exported for tests. */
export const deleteArchivedBranchesHandler = async (
  _gc: unknown,
  ctx: ApiContext,
  _req: ApiRequest,
  body: z.infer<typeof deleteArchivedBranchesBodySchema>,
): Promise<DeleteArchivedBranchesResponse> => {
  const { config, registry } = ctx.services
  if (!clientOperatingStrategy(config.mode).supportsBranching()) {
    return { ok: false, status: 400, error: 'Cannot delete branches in this operating mode' }
  }
  if (!registry) {
    return {
      ok: false,
      status: 400,
      error: 'Branch registry not initialized — ensure the workspace has been initialized',
    }
  }

  const startedAt = Date.now()
  const cutoff = archivedCutoff(body.olderThanDays, startedAt)
  const settingsBranch = operatingStrategy(config.mode).getSettingsBranchName(config)
  const old = (await registry.list()).filter(
    ({ branch }) =>
      archivedBefore(branch, cutoff) &&
      !isSettingsBranchName(branch.name, settingsBranch) &&
      !getBranchProtection(config, branch.name, branch.baseBranch).isProtected,
  )
  const confirmed = new Set(body.branches)
  const due = old.filter(
    ({ branch }) => deletableByAge(branch, cutoff) && confirmed.has(branch.name),
  )
  const heldFor = (hold: AgeDeletionHold) =>
    old.filter(({ branch }) => ageDeletionHold(branch) === hold).map(({ branch }) => branch.name)

  const data: DeleteArchivedBranchesData = {
    deleted: [],
    skipped: {
      notMerged: heldFor('not-merged'),
      unpublished: heldFor('unpublished'),
      movedOnGitHub: heldFor('moved-on-github'),
    },
    failed: [],
    remaining: 0,
    warnings: [],
  }
  for (const [index, context] of due.entries()) {
    if (Date.now() - startedAt > DELETE_ARCHIVED_BUDGET_MS) {
      data.remaining = due.length - index
      break
    }
    const name = context.branch.name
    try {
      const outcome = await deleteBranchWorkspace({
        ...branchDeleteOptions(ctx, context, registry),
        stillWanted: (current) => current.name === name && deletableByAge(current, cutoff),
      })
      if (outcome.kind === 'deleted') {
        data.deleted.push(name)
        if (outcome.cleanupWarning) data.warnings.push(`${name}: ${outcome.cleanupWarning}`)
      } else {
        data.failed.push(name)
      }
    } catch (err: unknown) {
      console.error(`CanopyCMS: Failed to delete archived branch ${name}:`, getErrorMessage(err))
      data.failed.push(name)
    }
  }
  return { ok: true, status: 200, data }
}

/**
 * Delete merged, archived branches older than a number of days, by the rule the retention sweep
 * uses.
 * Here rather than queued for the worker so the admin gets the answer, and so it works where no
 * worker runs.
 */
const deleteArchivedBranches = defineEndpoint({
  namespace: 'admin',
  name: 'deleteArchivedBranches',
  method: 'POST',
  path: '/admin/archived-branches/delete',
  body: deleteArchivedBranchesBodySchema,
  bodyType: 'DeleteArchivedBranchesBody',
  responseType: 'DeleteArchivedBranchesResponse',
  response: {} as DeleteArchivedBranchesResponse,
  defaultMockData: {
    deleted: [],
    skipped: { notMerged: [], unpublished: [], movedOnGitHub: [] },
    failed: [],
    remaining: 0,
    warnings: [],
  },
  clientTimeout: 'long',
  guards: ['admin'] as const,
  handler: deleteArchivedBranchesHandler,
})

export const ADMIN_ARCHIVED_BRANCH_ROUTES = { deleteArchivedBranches } as const
