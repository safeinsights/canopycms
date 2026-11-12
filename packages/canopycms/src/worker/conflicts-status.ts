/**
 * The "CanopyCMS conflicts" commit status (`CONFLICTS_STATUS_CONTEXT`) on each pull request's head:
 * failure while the branch has conflicts open, success once none are, by the rule Submit and
 * Approve refuse on (`assertNoOpenConflicts`), so an adopter who makes it a required check has
 * GitHub refuse what the CMS refuses.
 *
 * Set once per git sync, after the rebase cycle, on the head that cycle's fetch read from GitHub:
 * only what reached GitHub gets a status. A status is set again only when its head, state,
 * description or link changes from what this worker last set. A failure is never cached, so the
 * next cycle retries it; none fails the sync.
 */
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { BranchMetadataFileManager } from '../branch-metadata'
import { BranchMetadataCorruptError } from '../branch-metadata-file'
import { editorDeepLink, resolveEditorUrl } from '../editor-url'
import {
  MergeConflictStore,
  MergeConflictsFileFormatError,
  MergeConflictsFileMalformedError,
  openConflictCount,
} from '../merge-conflicts'
import type { ConflictsStatusFailure } from '../types'
import { getErrorMessage, isNodeError, sanitizeErrorMessage } from '../utils/error'
import { escapeForLog } from '../utils/escape-text'
import { GatewayRefusalError, MAX_COMMIT_STATUS_URL_LENGTH } from './branch-policy'
import { getHttpStatus, isPermissionDenial } from './github-errors'
import type { GitHubConflictsStatus } from './github-gateway'
import { workerLog, workerLogWarn } from './log'
import type { WorkerContext } from './worker-context'

export type ConflictsStatusContext = Pick<
  WorkerContext,
  | 'contentBranchesPath'
  | 'sanitizedBaseBranch'
  | 'github'
  | 'conflictsStatusesSet'
  | 'shutdownSignal'
  | 'taskTimeoutMs'
  | 'requestBranchSync'
>

/** The most branch names a failure report lists. */
const MAX_REPORTED_BRANCHES = 50

/** The state and description a branch's conflict record calls for. */
type ConflictsStatusText = Pick<GitHubConflictsStatus, 'state' | 'description'>

/**
 * What `branchRoot`'s conflict record calls for: failure with the number of choices open, or while
 * the record is held after a damaged one was set aside, or does not parse; success otherwise.
 * @internal Exported for tests.
 */
export async function conflictsStatusOf(branchRoot: string): Promise<ConflictsStatusText> {
  try {
    const record = await new MergeConflictStore(branchRoot).read()
    if (record?.held) {
      return {
        state: 'failure',
        description: 'Conflict record set aside: an admin must release the branch in the editor',
      }
    }
    const open = record ? openConflictCount(record.entries) : 0
    if (open === 0) return { state: 'success', description: 'No conflicting changes to resolve' }
    return {
      state: 'failure',
      description:
        open === 1
          ? '1 conflicting change to resolve in the editor'
          : `${open} conflicting changes to resolve in the editor`,
    }
  } catch (err) {
    if (
      err instanceof MergeConflictsFileMalformedError ||
      err instanceof MergeConflictsFileFormatError
    ) {
      return { state: 'failure', description: "Couldn't read this branch's conflicts" }
    }
    throw err
  }
}

/** One branch's status: what to set, and the key it is remembered by. */
interface DueStatus {
  branch: string
  status: GitHubConflictsStatus
  key: string
}

/**
 * Set the conflicts status on every pull request whose head, as `githubTips` (this cycle's GitHub
 * fetch) holds it, lacks the one its branch calls for. Returns the failure to report, undefined
 * when every status was set, or null when the stage could not say: the branches could not be
 * listed, or a drain cut it off. Never throws.
 */
export async function setConflictsStatuses(
  ctx: ConflictsStatusContext,
  githubTips: ReadonlyMap<string, string>,
): Promise<ConflictsStatusFailure | undefined | null> {
  let due: DueStatus[]
  let unreadable: Unreadable[]
  try {
    ;({ due, unreadable } = await dueStatuses(ctx, githubTips))
  } catch (err) {
    workerLogWarn(
      `Could not read the branches' conflicts for their status: ${getErrorMessage(err)}`,
    )
    return null
  }
  const set = ctx.conflictsStatusesSet()
  const failed = unreadable.map((u) => u.branch)
  let failure: Omit<ConflictsStatusFailure, 'branches' | 'count' | 'at'> | undefined =
    unreadable[0] && { reason: 'other', message: unreadable[0].message }
  for (const [index, { branch, status, key }] of due.entries()) {
    if (ctx.shutdownSignal().aborted) return null
    try {
      // Bounded, so a GitHub that stalls holds the sync for one timeout, not one per branch.
      await ctx
        .github()
        .setConflictsStatus(
          status,
          AbortSignal.any([ctx.shutdownSignal(), AbortSignal.timeout(ctx.taskTimeoutMs)]),
        )
      set.set(branch, key)
      workerLog(
        `Set the conflicts status of PR #${status.pullRequest} (${escapeForLog(branch)}) at ` +
          `${status.sha.slice(0, 7)}: ${status.state}`,
      )
    } catch (err) {
      if (ctx.shutdownSignal().aborted) return null
      if (err instanceof GatewayRefusalError && err.reason === 'not-head') {
        // GitHub moves a pull request's head a moment after the push, so this cycle's tip can be
        // ahead of it: one more sync for that tip, and no loop if the two never agree.
        const asked = `not-head:${branch}`
        if (set.get(asked) !== status.sha) {
          set.set(asked, status.sha)
          ctx.requestBranchSync(branch)
        }
        continue
      }
      const message = sanitizeErrorMessage(getErrorMessage(err))
      failed.push(branch)
      workerLogWarn(`Could not set the conflicts status of ${escapeForLog(branch)}: ${message}`)
      // The gateway's refusals for the pull request itself report as `other`, retried each cycle.
      const reason =
        err instanceof GatewayRefusalError
          ? 'other'
          : isPermissionDenial(err)
            ? 'permission'
            : isUnreachable(err)
              ? 'unreachable'
              : 'other'
      // A refused credential names its remedy over any other failure.
      if (reason === 'permission' || !failure) failure = { reason, message }
      // GitHub answers every later write in the cycle the same way; the next cycle tries again.
      if (reason !== 'other') {
        failed.push(...due.slice(index + 1).map((d) => d.branch))
        break
      }
    }
  }
  if (!failure) return undefined
  return {
    ...failure,
    branches: failed.slice(0, MAX_REPORTED_BRANCHES),
    count: failed.length,
    at: new Date().toISOString(),
  }
}

/**
 * A failure to reach GitHub or the gateway, or GitHub busy: no status at all, a timeout, a rate
 * limit (a 403 that is not a permission denial), or a server error.
 */
function isUnreachable(err: unknown): boolean {
  const status = getHttpStatus(err)
  return status === null || status === 403 || status === 408 || status === 429 || status >= 500
}

/** A branch whose branch.json or conflict record could not be read, by its directory. */
interface Unreadable {
  branch: string
  message: string
}

/**
 * Each branch with a pull request whose head lacks the status it calls for, and each branch that
 * could not be read, which costs only its own status. Throws only when the branches directory
 * cannot be listed.
 */
async function dueStatuses(
  ctx: ConflictsStatusContext,
  githubTips: ReadonlyMap<string, string>,
): Promise<{ due: DueStatus[]; unreadable: Unreadable[] }> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(ctx.contentBranchesPath, { withFileTypes: true })
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return { due: [], unreadable: [] }
    throw err
  }
  const set = ctx.conflictsStatusesSet()
  const due: DueStatus[] = []
  const unreadable: Unreadable[] = []
  const cannotRead = (branch: string, err: unknown) => {
    const message = sanitizeErrorMessage(getErrorMessage(err))
    workerLogWarn(`Could not read ${escapeForLog(branch)} for its conflicts status: ${message}`)
    unreadable.push({ branch, message })
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = entry.name
    // The base branch has no pull request; `.trash-*` directories hold purged branches.
    if (!entry.isDirectory() || dir.startsWith('.') || dir === ctx.sanitizedBaseBranch) continue
    const branchRoot = path.join(ctx.contentBranchesPath, dir)
    let meta: Awaited<ReturnType<typeof BranchMetadataFileManager.loadOnly>>
    try {
      meta = await BranchMetadataFileManager.loadOnly(branchRoot)
    } catch (err) {
      if (err instanceof BranchMetadataCorruptError || (isNodeError(err) && err.code === 'ENOENT'))
        continue
      cannotRead(dir, err)
      continue
    }
    const branch = meta?.branch
    if (!branch || branch.status === 'archived' || branch.pullRequestNumber === undefined) continue
    if (branch.pullRequestState === 'merged' || branch.pullRequestState === 'closed') continue
    const sha = githubTips.get(branch.name)
    if (sha === undefined) continue
    let text: ConflictsStatusText
    try {
      text = await conflictsStatusOf(branchRoot)
    } catch (err) {
      cannotRead(branch.name, err)
      continue
    }
    const editorUrl = branch.editorUrl && resolveEditorUrl({ configured: branch.editorUrl })
    const link = editorUrl && editorDeepLink(editorUrl, branch.name)
    const status: GitHubConflictsStatus = {
      pullRequest: branch.pullRequestNumber,
      sha,
      ...text,
      // A link the gateway would refuse is left off, so it never costs the status.
      ...(link && link.length <= MAX_COMMIT_STATUS_URL_LENGTH && { targetUrl: link }),
    }
    const key = JSON.stringify(status)
    if (set.get(branch.name) !== key) due.push({ branch: branch.name, status, key })
  }
  return { due, unreadable }
}
