import type { SimpleGit } from 'simple-git'

import { getBranchMetadataFileManager, type BranchMetadataFile } from '../branch-metadata'
import { invalidateBranchContentCaches } from '../content-index-generation'
import { GITHUB_TRACKING_REF_PREFIX } from '../git-manager'
import { SYNC_PR_COMMENTS_ACTION } from '../pr-comments'
import { enqueueTask } from '../task-queue/cms-task-queue'
import { getErrorMessage } from '../utils/error'
import { publishesBranch, type BranchPolicyDescription } from './branch-policy'
import {
  buildMergeCommit,
  commitsApart,
  conflictFilesToContentIds,
  publishPlainToLocalRemote,
  recordConflicts,
} from './branch-merge'
import { enqueueGitHubPush, readPublishedSha } from './history-rewrite'
import { workerLog, workerLogWarn } from './log'
import { assertNoIncomingSubmodules, fetchFromRemoteGit } from './shared-repo-git'
import type { WorkerContext } from './worker-context'

/**
 * Commits that reach a branch on GitHub without passing through its clone: Update branch, a
 * maintainer's fix, or a push this worker made. `reconcileTrackedBranches` fast-forwards
 * `remote.git` to them, but branch clones never fetch their own branch, so without this step the
 * clone's next rebase or commit diverges from `remote.git` and every submit after that is refused.
 *
 * Runs once per cycle for every branch this deployment has published, whatever its status, under
 * the provisioning and content-write locks the caller holds, ahead of the rebase. It never forces
 * anything: a clone behind GitHub fast-forwards, and a clone with commits GitHub lacks gets a real
 * merge (branch-merge.ts), which keeps every commit on both sides.
 *
 * Two commits are compared. `remote.git`'s head is what the clone must contain for its next push,
 * and it stays behind GitHub only while a head is diverged; GitHub's tip, from this cycle's fetch,
 * is the one a diverged head is reconciled against.
 */
export type GitHubCommitsContext = Pick<
  WorkerContext,
  | 'baseBranch'
  | 'contentBranchesPath'
  | 'contentRoot'
  | 'remoteGitPath'
  | 'taskDir'
  | 'taskTimeoutMs'
  | 'ensureStatusReport'
>

export type GitHubCommitsOutcome =
  /** GitHub's commits are in the clone, or there are none to bring in. */
  | { kind: 'in-step' }
  /** Looked at again next cycle. Nothing else in this cycle may move the branch. */
  | { kind: 'wait' }
  /** Left as it is until a person acts on GitHub. `reason` says what to do. */
  | { kind: 'blocked'; reason: string }

export interface GitHubCommitsArgs {
  git: SimpleGit
  branchPath: string
  branchDir: string
  branchRef: string
  metaFile: BranchMetadataFile
  /** GitHub's tip for the branch from this cycle's fetch, when GitHub has it. */
  gitHubTip: string | undefined
  /** Whether the working tree holds saves, which only a fast-forward can pass. */
  dirty: boolean
  gatewayPolicy: BranchPolicyDescription | undefined
  /** Whether a lock the caller holds was lost; checked before each step that moves a ref. */
  lockLost: () => boolean
}

/** A branch this deployment put on GitHub. Any other GitHub branch of that name is not its own. */
function isPublished({ branch }: BranchMetadataFile): boolean {
  return (
    branch.lastGitHubTip !== undefined ||
    branch.pushedToGitHubAt !== undefined ||
    branch.pullRequestNumber !== undefined
  )
}

/** Bring GitHub's commits into the clone. Throws what git throws; the caller records it. */
export async function bringInGitHubCommits(
  ctx: GitHubCommitsContext,
  args: GitHubCommitsArgs,
): Promise<GitHubCommitsOutcome> {
  const { git, branchRef, metaFile, gitHubTip, dirty, gatewayPolicy } = args
  // A branch.json naming another ref is that branch's, which shares this directory's name.
  if (metaFile.branch.name !== branchRef || !isPublished(metaFile)) return { kind: 'in-step' }

  const published = await readPublishedSha(ctx, branchRef)
  const tip = gitHubTip ?? published
  if (tip === null) return { kind: 'in-step' }
  let head = (await git.revparse(['HEAD'])).trim()
  if (tip !== head || (published !== null && published !== head)) {
    // Holding base keeps content the serving editor has no schema for out of every clone, and a
    // merge of base on GitHub would carry it in here.
    if (ctx.ensureStatusReport().baseHold) return { kind: 'wait' }
  }

  // A crash after a merge reached remote.git leaves the clone behind it, like any fast-forward
  // reconcile made. Taken first, so the merge below always builds on what remote.git holds.
  if (published !== null && published !== head) {
    await fetchFromRemoteGit(git, ctx.remoteGitPath, `refs/heads/${branchRef}`)
    const { onlyA } = await commitsApart(git, head, published)
    if (onlyA === 0) {
      if (!(await fastForward(ctx, args, head, published))) return { kind: 'wait' }
      head = published
    }
  }

  if (tip !== head) {
    if (tip !== published) {
      await fetchFromRemoteGit(git, ctx.remoteGitPath, `${GITHUB_TRACKING_REF_PREFIX}${branchRef}`)
    }
    const { onlyA, onlyB } = await commitsApart(git, head, tip)
    if (onlyB > 0 && onlyA === 0) {
      if (!(await fastForward(ctx, args, head, tip))) return { kind: 'wait' }
      head = tip
    } else if (onlyB > 0) {
      // The worker's own rewrite with its push still on the way: GitHub stands at the commit it
      // replaced, and history-rewrite.ts completes that hop.
      if (metaFile.branch.historyRewrittenFrom === tip) return { kind: 'in-step' }
      if (dirty) return { kind: 'wait' }
      const lastSeen = metaFile.branch.lastGitHubTip
      if (lastSeen !== undefined && !(await contains(git, tip, lastSeen))) {
        return { kind: 'blocked', reason: rewrittenOnGitHub(branchRef, lastSeen) }
      }
      return mergeGitHubTip(ctx, args, head, tip)
    }
  }

  await recordGitHubTip(ctx, args, tip)

  // A merge or a submit that reached remote.git with no GitHub push queued, as after a crash
  // between the two. A rebase now would strand the push, which leases on a commit GitHub never
  // held, so it waits for the push. A push that failed for good stays as it is: its failure is on
  // the branch, and a new attempt would fail the same way every cycle.
  if (
    gitHubTip !== undefined &&
    published !== null &&
    published !== tip &&
    metaFile.branch.syncStatus !== 'sync-failed' &&
    (!gatewayPolicy || publishesBranch(gatewayPolicy, branchRef)) &&
    (await contains(git, published, tip))
  ) {
    await enqueueGitHubPush(ctx, branchRef, gatewayPolicy)
    return { kind: 'wait' }
  }
  return { kind: 'in-step' }
}

/**
 * The clone fast-forwarded to `to`. With saves in the tree, git refuses when they touch a file
 * the commits change, which leaves the tree as it was: resolves false, and the commits wait for
 * the submit that commits those saves.
 */
async function fastForward(
  ctx: GitHubCommitsContext,
  args: GitHubCommitsArgs,
  from: string,
  to: string,
): Promise<boolean> {
  const { git, branchPath, branchDir, dirty, lockLost } = args
  await assertNoIncomingSubmodules(git, branchPath, from, to)
  if (lockLost()) return false
  const carriesOwnCommits = await bringsNonBaseCommits(ctx, args, from, to)
  try {
    await git.raw(['merge', '--ff-only', '--end-of-options', to])
  } catch (err) {
    if (!dirty) throw err
    workerLog(`  ${branchDir}: saved edits overlap commits from GitHub, which wait for a submit`)
    return false
  }
  await invalidateBranchContentCaches(branchPath)
  workerLog(`  ${branchDir}: brought in commits from GitHub (now at ${to.slice(0, 7)})`)
  if (carriesOwnCommits) await returnToReview(ctx, args)
  return true
}

/**
 * The clone's work and GitHub's merged, published to `remote.git`, queued for GitHub, and the
 * clone moved to it, in that order: each step leaves what the next cycle picks up, and only the
 * last touches the working tree. Ends the branch's cycle: a rebase now would replace a merge
 * GitHub has not received.
 */
async function mergeGitHubTip(
  ctx: GitHubCommitsContext,
  args: GitHubCommitsArgs,
  head: string,
  tip: string,
): Promise<GitHubCommitsOutcome> {
  const { git, branchPath, branchDir, branchRef, gatewayPolicy, lockLost } = args
  const carriesOwnCommits = await bringsNonBaseCommits(ctx, args, head, tip)
  const { sha, conflicted } = await buildMergeCommit(git, branchPath, {
    head,
    other: tip,
    message: `Merge commits from GitHub into ${branchRef}`,
    timeoutMs: ctx.taskTimeoutMs,
  })
  await assertNoIncomingSubmodules(git, branchPath, head, sha)
  if (lockLost()) return { kind: 'wait' }

  if (conflicted.length > 0) await recordKeptVersions(ctx, args, conflicted)
  if (!(await publishPlainToLocalRemote(ctx, branchPath, branchRef, sha))) return { kind: 'wait' }
  await enqueueGitHubPush(ctx, branchRef, gatewayPolicy)
  await git.raw(['merge', '--ff-only', '--end-of-options', sha])
  await invalidateBranchContentCaches(branchPath)
  await recordGitHubTip(ctx, args, tip)
  if (carriesOwnCommits) await returnToReview(ctx, args)
  workerLog(
    conflicted.length > 0
      ? `  ${branchDir}: merged commits from GitHub (kept this branch's version of ${conflicted.length} file(s))`
      : `  ${branchDir}: merged commits from GitHub`,
  )
  return { kind: 'wait' }
}

/** Whether `commit` contains `ancestor`. A commit this clone does not hold counts as no. */
async function contains(git: SimpleGit, commit: string, ancestor: string): Promise<boolean> {
  try {
    return (await commitsApart(git, ancestor, commit)).onlyA === 0
  } catch {
    return false
  }
}

function rewrittenOnGitHub(branchRef: string, lastSeen: string): string {
  return (
    `GitHub's ${branchRef} no longer contains ${lastSeen}, the last commit this deployment saw ` +
    `there: it was force-pushed or rewritten. Nothing was merged, so the rewrite stands, and ` +
    `this branch's changes cannot reach GitHub. To continue, a developer merges that commit ` +
    `back into the branch on GitHub.`
  )
}

/**
 * Whether `from..to` holds a commit that is neither a merge nor already on the base branch: work,
 * rather than the base catching up, which leaves the pull request's diff as it was reviewed. Asked
 * only of an approved branch, the one status it changes anything for.
 */
async function bringsNonBaseCommits(
  ctx: GitHubCommitsContext,
  args: GitHubCommitsArgs,
  from: string,
  to: string,
): Promise<boolean> {
  const { git, metaFile } = args
  if (metaFile.branch.status !== 'approved') return false
  await fetchFromRemoteGit(git, ctx.remoteGitPath, ctx.baseBranch)
  const base = (await git.revparse(['FETCH_HEAD'])).trim()
  const count = await git.raw(['rev-list', '--count', '--no-merges', `${from}..${to}`, `^${base}`])
  return count.trim() !== '0'
}

/**
 * An approval covers what was reviewed, so commits that change it send the branch back to review
 * and clear the verdict from the PR body. Best-effort, like every metadata write of the sync loop:
 * a failure costs the note, never the commits.
 */
async function returnToReview(
  ctx: GitHubCommitsContext,
  { branchPath, branchDir, branchRef, metaFile }: GitHubCommitsArgs,
): Promise<void> {
  try {
    const saved = await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).saveIf(
      { branch: { status: 'submitted', review: undefined } },
      (current) => current?.branch.name === branchRef && current.branch.status === 'approved',
    )
    if (saved === null) return
    workerLog(`  ${branchDir}: back in review, as commits from GitHub changed what was approved`)
    await enqueuePrBodySync(ctx, branchRef, metaFile)
  } catch (err) {
    workerLogWarn(`  ${branchDir}: could not return it to review: ${getErrorMessage(err)}`)
  }
}

/** Record the paths whose GitHub change a merge left out, for the editor and the PR body. */
async function recordKeptVersions(
  ctx: GitHubCommitsContext,
  { branchPath, branchRef, metaFile }: GitHubCommitsArgs,
  conflicted: readonly string[],
): Promise<void> {
  const ids = conflictFilesToContentIds(conflicted, ctx.contentRoot)
  await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).update((existing) =>
    existing?.branch.name === branchRef
      ? {
          branch: {
            ...recordConflicts(existing.branch.conflictFiles, ids),
            keptOverGitHub: [
              ...new Set([...(existing.branch.keptOverGitHub ?? []), ...conflicted]),
            ],
          },
        }
      : null,
  )
  await enqueuePrBodySync(ctx, branchRef, metaFile)
}

async function enqueuePrBodySync(
  ctx: Pick<GitHubCommitsContext, 'taskDir'>,
  branchRef: string,
  { branch }: BranchMetadataFile,
): Promise<void> {
  if (branch.pullRequestNumber === undefined) return
  await enqueueTask(ctx.taskDir, {
    action: SYNC_PR_COMMENTS_ACTION,
    payload: {
      branch: branchRef,
      pullRequestNumber: branch.pullRequestNumber,
      ...(branch.editorUrl ? { editorUrl: branch.editorUrl } : {}),
    },
  })
}

/** Skipped when already recorded: every save regenerates the branch registry. */
async function recordGitHubTip(
  ctx: GitHubCommitsContext,
  { branchPath, branchRef, metaFile, gitHubTip }: GitHubCommitsArgs,
  tip: string,
): Promise<void> {
  if (gitHubTip !== tip || metaFile.branch.lastGitHubTip === tip) return
  await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).saveIf(
    { branch: { lastGitHubTip: tip } },
    (current) => current?.branch.name === branchRef,
  )
}
