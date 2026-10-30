import type { SimpleGit } from 'simple-git'

import {
  BranchMetadataFileManager,
  getBranchMetadataFileManager,
  type BranchMetadataFile,
} from '../branch-metadata'
import { invalidateBranchContentCaches } from '../content-index-generation'
import { GITHUB_TRACKING_REF_PREFIX } from '../git-manager'
import { SYNC_PR_COMMENTS_ACTION } from '../pr-comments'
import { enqueueTask } from '../task-queue/cms-task-queue'
import { getErrorMessage } from '../utils/error'
import { escapeForLog } from '../utils/escape-text'
import { isCanopyInternalPath } from '../utils/git'
import { publishesBranch, type BranchPolicyDescription } from './branch-policy'
import {
  buildMergeCommit,
  commitsApart,
  conflictFilesToContentIds,
  isCleanMergeOf,
  publishPlainToLocalRemote,
  recordConflicts,
} from './branch-merge'
import {
  MAX_REPORTED_PATHS,
  RETIRED_SCHEMA_CACHE_PATH,
  TRACKED_CANOPY_STATE_FIX,
} from './canopy-state'
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
 * Runs once per cycle for every branch this deployment has published, in every status but
 * archived, under the provisioning and content-write locks the caller holds, ahead of the rebase. It never forces
 * anything: a clone behind GitHub fast-forwards, and a clone with commits GitHub lacks gets a real
 * merge (branch-merge.ts), which keeps every commit on both sides.
 *
 * Two commits are compared. `remote.git`'s head is what the clone must contain for its next push,
 * and it stays behind GitHub only while a head is diverged; GitHub's tip, from this cycle's fetch,
 * is the one a diverged head is reconciled against.
 *
 * A merge commit in a branch's history is why the rebase loop merges base into it rather than
 * rebasing (rebase.ts): `git rebase` drops merge commits, and with them whatever they settled.
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

/** GitHub's branches as a sync cycle's fetch reported them, and when that fetch began. */
export interface GitHubSnapshot {
  tips: ReadonlyMap<string, string>
  fetchedAt: number
}

export type GitHubCommitsOutcome =
  /** GitHub's commits are in the clone, or there are none to bring in. */
  | { kind: 'in-step' }
  /** Looked at again next cycle. Nothing else in this cycle may move the branch. */
  | { kind: 'wait' }
  /** A merge landed. A rebase now would replace a merge GitHub has not received. */
  | { kind: 'merged' }
  /** Left as it is until a person acts. `reason` says what to do. */
  | { kind: 'blocked'; reason: string }

export interface GitHubCommitsArgs {
  git: SimpleGit
  branchPath: string
  branchDir: string
  branchRef: string
  metaFile: BranchMetadataFile
  gitHub: GitHubSnapshot | undefined
  /** Whether the working tree holds saves, which only a fast-forward can pass. */
  dirty: boolean
  gatewayPolicy: BranchPolicyDescription | undefined
  /** Whether a lock the caller holds was lost; checked before each step that moves a ref. */
  lockLost: () => boolean
}

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const MAX_LISTED_PATH_LENGTH = 200

/** A branch this deployment put on GitHub. Any other GitHub branch of that name is not its own. */
function isPublished({ branch }: BranchMetadataFile): boolean {
  return branch.pushedToGitHubAt !== undefined || branch.pullRequestNumber !== undefined
}

/** Bring GitHub's commits into the clone. Throws what git throws; the caller records it. */
export async function bringInGitHubCommits(
  ctx: GitHubCommitsContext,
  args: GitHubCommitsArgs,
): Promise<GitHubCommitsOutcome> {
  const { git, branchRef, metaFile, dirty, gatewayPolicy } = args
  const { branch } = metaFile
  // A branch.json naming another ref is that branch's, which shares this directory's name.
  if (branch.name !== branchRef || !isPublished(metaFile)) return { kind: 'in-step' }

  const gitHubTip = args.gitHub?.tips.get(branchRef)
  // No GitHub branch leaves nothing a push could restore.
  if (args.gitHub !== undefined && gitHubTip === undefined && branch.rewrittenOnGitHub) {
    await clearRewritten(ctx, args)
  }
  const published = await readPublishedSha(ctx, branchRef)
  const tip = gitHubTip ?? published
  if (tip === null) return { kind: 'in-step' }
  let head = (await git.revparse(['HEAD'])).trim()
  if (tip === head && (published === null || published === head)) {
    await recordGitHubTip(ctx, args, tip)
    return { kind: 'in-step' }
  }

  // Holding base keeps content the serving editor has no schema for out of every clone, and a
  // merge of base on GitHub would carry it in here.
  if (ctx.ensureStatusReport().baseHold) return { kind: 'wait' }

  if (published !== null && published !== head) {
    await fetchFromRemoteGit(git, ctx.remoteGitPath, `refs/heads/${branchRef}`)
  }
  if (tip !== head && tip !== published) {
    await fetchFromRemoteGit(git, ctx.remoteGitPath, `${GITHUB_TRACKING_REF_PREFIX}${branchRef}`)
  }

  // First, before any step reads this tip as commits to take in or a push to make: both would
  // restore what someone removed.
  let rewriteResolved = false
  if (args.gitHub !== undefined && gitHubTip !== undefined) {
    // Unreadable means the tip's objects did not reach this clone, which says nothing about GitHub.
    if (!(await hasCommit(git, tip))) return { kind: 'wait' }
    const lastSeen = await rewrittenFrom(args, tip, head)
    if (lastSeen !== null) {
      return (await pushedSinceFetch(args, args.gitHub.fetchedAt))
        ? { kind: 'wait' }
        : blockAsRewritten(ctx, args, lastSeen)
    }
    if (branch.rewrittenOnGitHub !== undefined) {
      await clearRewritten(ctx, args)
      rewriteResolved = true
    }
  }

  // A crash after a merge reached remote.git leaves the clone behind it, like any fast-forward
  // reconcile made. Taken first, so a merge below builds on remote.git's head whenever it can.
  if (published !== null && published !== head) {
    if ((await commitsApart(git, head, published)).onlyA === 0) {
      const stopped = await fastForward(ctx, args, head, published)
      if (stopped) return stopped
      head = published
    }
  }

  if (tip !== head) {
    const { onlyA, onlyB } = await commitsApart(git, head, tip)
    if (onlyB > 0 && onlyA === 0) {
      const stopped = await fastForward(ctx, args, head, tip)
      if (stopped) return stopped
      head = tip
    } else if (onlyB > 0) {
      // The worker's own rewrite with its push still on the way: GitHub stands at the commit it
      // replaced, and history-rewrite.ts completes that hop.
      if (branch.historyRewrittenFrom === tip) {
        if (rewriteResolved) await enqueueGitHubPush(ctx, branchRef, gatewayPolicy)
        return { kind: 'in-step' }
      }
      if (dirty) return { kind: 'wait' }
      // Nothing it made could reach GitHub, and each base move would make another.
      if (gatewayPolicy && !publishesBranch(gatewayPolicy, branchRef)) return { kind: 'in-step' }
      return mergeIntoBranch(ctx, args, {
        head,
        other: tip,
        message: `Merge commits from GitHub into ${branchRef}`,
        fromGitHub: true,
      })
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
    (branch.syncStatus !== 'sync-failed' || rewriteResolved) &&
    (!gatewayPolicy || publishesBranch(gatewayPolicy, branchRef)) &&
    (await contains(git, published, tip))
  ) {
    await enqueueGitHubPush(ctx, branchRef, gatewayPolicy)
    return { kind: 'wait' }
  }
  return { kind: 'in-step' }
}

/**
 * Whether the task loop pushed this branch after the cycle's fetch began, which makes the cycle's
 * tip old news rather than a rewrite. Read fresh: the caller's metadata is from the cycle's start.
 */
async function pushedSinceFetch(
  { branchPath }: GitHubCommitsArgs,
  fetchedAt: number,
): Promise<boolean> {
  const pushedAt = (await BranchMetadataFileManager.loadOnly(branchPath))?.branch.pushedToGitHubAt
  return pushedAt !== undefined && Date.parse(pushedAt) >= fetchedAt
}

/**
 * The commit a rewrite on GitHub removed, or null. Any commit GitHub is known to hold counts: the
 * last tip seen, and the commit a pending rewrite of the worker's own replaced, since GitHub stays
 * there until that push lands. A tip that contains the clone loses nothing the clone holds.
 */
async function rewrittenFrom(
  { git, metaFile }: GitHubCommitsArgs,
  tip: string,
  head: string,
): Promise<string | null> {
  const { lastGitHubTip, historyRewrittenFrom } = metaFile.branch
  // The marker first: what is named here must be a commit GitHub really held, and a rewrite's
  // stamp may not have reached it yet.
  const known = [historyRewrittenFrom, lastGitHubTip].filter(
    (sha): sha is string => sha !== undefined && COMMIT_ID.test(sha),
  )
  if (known.length === 0 || (await contains(git, tip, head))) return null
  for (const sha of known) if (await contains(git, tip, sha)) return null
  return known[0]
}

/** Record the rewrite, which refuses pushes (task-runner.ts) for as long as it stands. */
async function blockAsRewritten(
  ctx: GitHubCommitsContext,
  { branchPath, branchRef, metaFile }: GitHubCommitsArgs,
  lastSeen: string,
): Promise<GitHubCommitsOutcome> {
  if (metaFile.branch.rewrittenOnGitHub !== lastSeen) {
    await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).saveIf(
      { branch: { rewrittenOnGitHub: lastSeen } },
      (current) => current?.branch.name === branchRef,
    )
  }
  return {
    kind: 'blocked',
    reason:
      `GitHub's ${branchRef} no longer contains ${lastSeen}, the last commit this deployment saw ` +
      `there: it was force-pushed or rewritten. Nothing was merged or pushed, so the rewrite ` +
      `stands, and this branch's changes cannot reach GitHub. To continue, a developer merges ` +
      `that commit back into the branch on GitHub.`,
  }
}

async function clearRewritten(
  ctx: GitHubCommitsContext,
  { branchPath, branchRef }: GitHubCommitsArgs,
): Promise<void> {
  await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).saveIf(
    { branch: { rewrittenOnGitHub: undefined } },
    (current) => current?.branch.name === branchRef,
  )
}

/** A short, one-line list of paths from a commit, safe in a log line and on branch metadata. */
function listPaths(paths: readonly string[]): string {
  return paths
    .slice(0, MAX_REPORTED_PATHS)
    .map((file) => escapeForLog(file).slice(0, MAX_LISTED_PATH_LENGTH))
    .join(', ')
}

/**
 * What stops `to` entering this clone, or null. `.git/info/exclude` hides canopycms's own state, and
 * git overwrites an ignored file without asking, so a commit that changes it would replace the live
 * branch.json and comments. A deletion counts: taken in, it would delete the live file, and
 * untracking it first only defers that to the next rebase, which replays the commit.
 */
async function refuseIncoming(
  { git, branchPath }: GitHubCommitsArgs,
  from: string,
  to: string,
): Promise<GitHubCommitsOutcome | null> {
  await assertNoIncomingSubmodules(git, branchPath, from, to)
  const fields = (
    await git.raw([
      'diff-tree',
      '-r',
      '-z',
      '--name-status',
      '--no-renames',
      '--end-of-options',
      from,
      to,
    ])
  ).split('\0')
  const deleted: string[] = []
  const changed: string[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const file = fields[i + 1]
    // Nothing reads the retired cache, so its deletion, which an adopter's fix makes, is harmless.
    if (!isCanopyInternalPath(file)) continue
    if (fields[i] !== 'D') changed.push(file)
    else if (file !== RETIRED_SCHEMA_CACHE_PATH) deleted.push(file)
  }
  if (changed.length > 0) {
    return {
      kind: 'blocked',
      reason:
        `Commits for this branch change canopycms's own state, which must not be committed ` +
        `(${listPaths(changed)}). Nothing was brought in. To fix, ${TRACKED_CANOPY_STATE_FIX}.`,
    }
  }
  if (deleted.length > 0) {
    return {
      kind: 'blocked',
      reason:
        `Commits for this branch stop tracking canopycms state this clone still tracks ` +
        `(${listPaths(deleted)}). Nothing was brought in; the clone needs manual repair.`,
    }
  }
  return null
}

/**
 * Move the clone to `to`, or say why it did not. Saves that touch a file the commits change make
 * git refuse before it writes anything, and those commits wait for the submit that commits them.
 * Any other failure throws: the message is git's, in the C locale `sharedRepoGit` pins.
 */
async function fastForward(
  ctx: GitHubCommitsContext,
  args: GitHubCommitsArgs,
  from: string,
  to: string,
): Promise<GitHubCommitsOutcome | null> {
  const { git, branchPath, branchDir, lockLost } = args
  const refused = await refuseIncoming(args, from, to)
  if (refused) return refused
  if (lockLost()) return { kind: 'wait' }
  if (await changesWhatWasReviewed(ctx, args, from, to)) await returnToReview(ctx, args)
  try {
    await git.raw(['merge', '--ff-only', '--end-of-options', to])
  } catch (err) {
    if (!/would be overwritten/.test(getErrorMessage(err))) throw err
    workerLog(`  ${branchDir}: saved edits overlap commits from GitHub, which wait for a submit`)
    return { kind: 'wait' }
  }
  await invalidateBranchContentCaches(branchPath)
  workerLog(`  ${branchDir}: brought in commits from GitHub (now at ${to.slice(0, 7)})`)
  return null
}

/**
 * `other` merged into the branch: built, published to `remote.git`, queued for GitHub, and the
 * clone moved to it, in that order, so each step leaves what the next cycle picks up and only the
 * last touches the working tree. `fromGitHub` says `other` is GitHub's tip rather than the base.
 */
export async function mergeIntoBranch(
  ctx: GitHubCommitsContext,
  args: GitHubCommitsArgs,
  merge: { head: string; other: string; message: string; fromGitHub: boolean },
): Promise<GitHubCommitsOutcome> {
  const { git, branchPath, branchDir, branchRef, gatewayPolicy, lockLost } = args
  const { head, other, message, fromGitHub } = merge
  const built = await buildMergeCommit(git, branchPath, {
    head,
    other,
    message,
    timeoutMs: ctx.taskTimeoutMs,
  })
  if (built.kind === 'unsettled') {
    return {
      kind: 'blocked',
      reason:
        `Git cannot merge ${other} into ${branchRef} by rule: ${built.conflicts.join(', ')}` +
        `${built.paths.length > 0 ? ` (${listPaths(built.paths)})` : ''}. Nothing was changed. ` +
        `To continue, a developer merges them on GitHub.`,
    }
  }
  const { sha, conflicted } = built
  const refused = await refuseIncoming(args, head, sha)
  if (refused) return refused
  if (lockLost()) return { kind: 'wait' }
  if (fromGitHub && (await changesWhatWasReviewed(ctx, args, head, sha))) {
    await returnToReview(ctx, args)
  }

  const published = await readPublishedSha(ctx, branchRef)
  const unpublishable =
    `This deployment's repository holds commits for ${branchRef} that neither this clone nor ` +
    `GitHub has, so a merge of the two cannot be published. Nothing was changed. Compare the ` +
    `copies with a developer before submitting again.`
  if (published !== null && !(await contains(git, sha, published))) {
    return { kind: 'blocked', reason: unpublishable }
  }
  // Recorded before the merge is visible anywhere: the next cycle only fast-forwards to it, and
  // the conflicts cannot be read back from the merge.
  if (conflicted.length > 0) await recordKeptVersions(ctx, args, conflicted, fromGitHub)
  if (published !== null) {
    if (!(await publishPlainToLocalRemote(ctx, branchPath, branchRef, sha))) {
      return { kind: 'blocked', reason: unpublishable }
    }
    await enqueueGitHubPush(ctx, branchRef, gatewayPolicy)
  }
  if (conflicted.length > 0 && fromGitHub) {
    await enqueueReviewBlockSync(ctx, branchRef, args.metaFile)
  }
  await git.raw(['merge', '--ff-only', '--end-of-options', sha])
  await invalidateBranchContentCaches(branchPath)
  if (fromGitHub) await recordGitHubTip(ctx, args, other)
  workerLog(
    conflicted.length > 0
      ? `  ${branchDir}: merged ${other.slice(0, 7)} (kept this branch's version of ${conflicted.length} file(s))`
      : `  ${branchDir}: merged ${other.slice(0, 7)}`,
  )
  return { kind: 'merged' }
}

async function hasCommit(git: SimpleGit, sha: string): Promise<boolean> {
  // `--quiet` exits 1 with no output for a missing object, which simple-git resolves.
  const found = await git
    .raw(['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}^{commit}`])
    .catch(() => '')
  return found.trim() !== ''
}

/** Whether `commit` contains `ancestor`. A commit this clone does not hold counts as no. */
async function contains(git: SimpleGit, commit: string, ancestor: string): Promise<boolean> {
  try {
    return (await commitsApart(git, ancestor, commit)).onlyA === 0
  } catch {
    return false
  }
}

/**
 * Whether moving an approved branch from `from` to `to` changes what was approved: yes unless `to`
 * is exactly `from` with the base up to where `to` has it, which leaves the pull request's diff as
 * it was reviewed. A hand-made change inside a merge commit therefore counts. Read fresh, so an
 * approval given since the cycle's start counts too.
 */
async function changesWhatWasReviewed(
  ctx: GitHubCommitsContext,
  { git, branchPath }: GitHubCommitsArgs,
  from: string,
  to: string,
): Promise<boolean> {
  const fresh = (await BranchMetadataFileManager.loadOnly(branchPath))?.branch
  if (fresh?.status !== 'approved') return false
  await fetchFromRemoteGit(git, ctx.remoteGitPath, fresh.baseBranch ?? ctx.baseBranch)
  const base = (await git.revparse(['FETCH_HEAD'])).trim()
  const forkPoint = (await git.raw(['merge-base', '--end-of-options', to, base])).trim()
  return forkPoint === '' || !(await isCleanMergeOf(git, to, from, forkPoint))
}

/**
 * Send an approved branch back to review and clear the verdict from the PR body. Before the clone
 * moves, and a failed save throws, so a crash or a failure leaves the commits for the next cycle
 * to judge again rather than an approval standing over them.
 */
export async function returnToReview(
  ctx: GitHubCommitsContext,
  { branchPath, branchDir, branchRef, metaFile }: GitHubCommitsArgs,
): Promise<void> {
  const saved = await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).saveIf(
    { branch: { status: 'submitted', review: undefined } },
    (current) => current?.branch.name === branchRef && current.branch.status === 'approved',
  )
  if (saved === null) return
  workerLog(`  ${branchDir}: back in review, as commits from GitHub changed what was approved`)
  await enqueueReviewBlockSync(ctx, branchRef, metaFile)
}

/** Record what a merge kept, for the editor and, for GitHub's commits, the PR body. */
async function recordKeptVersions(
  ctx: GitHubCommitsContext,
  { branchPath, branchRef }: GitHubCommitsArgs,
  conflicted: readonly string[],
  fromGitHub: boolean,
): Promise<void> {
  const ids = conflictFilesToContentIds(conflicted, ctx.contentRoot)
  await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).update((existing) =>
    existing?.branch.name === branchRef
      ? {
          branch: {
            ...recordConflicts(existing.branch.conflictFiles, ids),
            ...(fromGitHub
              ? {
                  keptOverGitHub: [
                    ...new Set([...(existing.branch.keptOverGitHub ?? []), ...conflicted]),
                  ],
                }
              : {}),
          },
        }
      : null,
  )
}

/**
 * Re-render the PR body's review block alone: the worker has no `config.editorUrl`, so a full
 * sync from here would strip the comment summary's links. Best-effort: a failure leaves the block
 * until the branch's next sync.
 */
async function enqueueReviewBlockSync(
  ctx: Pick<GitHubCommitsContext, 'taskDir'>,
  branchRef: string,
  { branch }: BranchMetadataFile,
): Promise<void> {
  if (branch.pullRequestNumber === undefined) return
  try {
    await enqueueTask(ctx.taskDir, {
      action: SYNC_PR_COMMENTS_ACTION,
      payload: {
        branch: branchRef,
        pullRequestNumber: branch.pullRequestNumber,
        reviewBlockOnly: true,
      },
    })
  } catch (err) {
    workerLogWarn(`  Failed to queue a PR body update for ${branchRef}: ${getErrorMessage(err)}`)
  }
}

/** Skipped when nothing changes: every save regenerates the branch registry. */
async function recordGitHubTip(
  ctx: GitHubCommitsContext,
  { branchPath, branchRef, metaFile, gitHub }: GitHubCommitsArgs,
  tip: string,
): Promise<void> {
  const { lastGitHubTip, rewrittenOnGitHub } = metaFile.branch
  if (gitHub?.tips.get(branchRef) !== tip) return
  if (lastGitHubTip === tip && rewrittenOnGitHub === undefined) return
  await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).saveIf(
    { branch: { lastGitHubTip: tip, rewrittenOnGitHub: undefined } },
    (current) => current?.branch.name === branchRef,
  )
}
