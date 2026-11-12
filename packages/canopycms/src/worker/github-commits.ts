import type { SimpleGit } from 'simple-git'

import {
  BranchMetadataFileManager,
  awaitsSubmitRetry,
  getBranchMetadataFileManager,
  type BranchMetadataFile,
} from '../branch-metadata'
import { CommentStore } from '../comment-store'
import { invalidateBranchContentCaches } from '../content-index-generation'
import { GITHUB_TRACKING_REF_PREFIX } from '../git-manager'
import {
  MergeConflictStore,
  MergeConflictsFileMalformedError,
  conflictFilesOf,
  withFoundConflicts,
  withRemappedItemKeys,
  withoutMergesGone,
  type MergeConflictEntry,
  type MergeConflictState,
} from '../merge-conflicts'
import { SYNC_PR_COMMENTS_ACTION } from '../pr-comments'
import { enqueueTask } from '../task-queue/cms-task-queue'
import type { BranchMetadata } from '../types'
import { getErrorMessage } from '../utils/error'
import { escapeForLog } from '../utils/escape-text'
import { isCanopyInternalPath } from '../utils/git'
import { publishesBranch, type BranchPolicyDescription } from './branch-policy'
import {
  commitMerge,
  commitsApart,
  isCleanMergeOf,
  planMerge,
  publishPlainToLocalRemote,
  type BuiltMerge,
} from './branch-merge'
import {
  MAX_REPORTED_PATHS,
  RETIRED_SCHEMA_CACHE_PATH,
  TRACKED_CANOPY_STATE_FIX,
} from './canopy-state'
import { enqueueGitHubPush, readPublishedSha, recordSeenOnGitHub } from './history-rewrite'
import { workerLog, workerLogWarn } from './log'
import { assertNoIncomingSubmodules, fetchFromRemoteGit } from './shared-repo-git'
import type { WorkerContext } from './worker-context'

/**
 * Commits that reach a branch on GitHub without passing through its clone: Update branch, a
 * maintainer's fix, or a push this worker made. `reconcileTrackedBranches` fast-forwards
 * `remote.git` to them, but branch clones never fetch their own branch, so without this step the
 * clone's next rebase or commit diverges from `remote.git` and every submit after that is refused.
 *
 * Brings them in once per cycle for every branch this deployment has published, in every status
 * but archived, under the provisioning and content-write locks the caller holds, ahead of the rebase.
 * It never forces anything: a clone behind GitHub fast-forwards, and a clone with commits GitHub
 * lacks gets a real merge (branch-merge.ts), which keeps every commit on both sides.
 *
 * Two commits are compared. `remote.git`'s head is what the clone must contain for its next push,
 * and it stays behind GitHub only while a head is diverged; GitHub's tip, from this cycle's fetch,
 * is the one a diverged head is reconciled against.
 *
 * A merge commit in a branch's history, or a commit touching canopycms state, is why the rebase
 * loop merges base into it rather than rebasing (rebase.ts): `git rebase` drops merge commits, and
 * with them whatever they settled, and replays commits over the live files.
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
  /**
   * `remote.git` holds commits GitHub lacks, whose push failed for good. A rebase would replace
   * commits GitHub never received, so the base comes in by a merge, which keeps them.
   */
  | { kind: 'unpushed' }
  /**
   * A merge landed. A rebase now would replace a merge GitHub has not received. `keptEntries`
   * counts the entries with a conflict it left for a person.
   */
  | { kind: 'merged'; keptEntries: number }
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

export const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const MAX_LISTED_PATH_LENGTH = 200

/** Why a push was refused while a rewrite stands (task-runner.ts); editors read it as a failed sync. */
export const REWRITTEN_PUSH_REFUSAL =
  "This branch was changed on GitHub in a way CanopyCMS can't combine with the work here, so nothing was pushed. Nothing is lost."

/** Why a push was refused before any sync had seen the rewrite (task-runner.ts). */
export const SEEN_COMMIT_GONE_PUSH_REFUSAL =
  'A commit this branch had on GitHub is no longer there, so nothing was pushed. Nothing is lost.'

/**
 * What clears a rewrite: the flag, and the refusal's text, which would go on saying the work can't
 * be combined. The failed sync it left goes too, unless {@link awaitsSubmitRetry}.
 */
export function rewriteCleared(branch: BranchMetadata): Partial<BranchMetadata> {
  const reason = branch.syncFailureReason
  if (
    !reason?.includes(REWRITTEN_PUSH_REFUSAL) &&
    !reason?.includes(SEEN_COMMIT_GONE_PUSH_REFUSAL)
  ) {
    return { rewrittenOnGitHub: undefined }
  }
  return awaitsSubmitRetry(branch)
    ? { rewrittenOnGitHub: undefined, syncFailureReason: undefined }
    : { rewrittenOnGitHub: undefined, syncStatus: 'synced', syncFailureReason: undefined }
}

/** A branch this deployment put on GitHub. Any other GitHub branch of that name is not its own. */
export function isPublished({ branch }: BranchMetadataFile): boolean {
  return branch.pushedToGitHubAt !== undefined || branch.pullRequestNumber !== undefined
}

/**
 * Fast-forward the clone to the merge this worker was landing, when `remote.git` holds it on top of
 * the clone, as a crash or a lost lock between publishing it and moving the clone leaves it,
 * whether or not the branch is on GitHub. Resolves why it stopped, or null when there was nothing
 * to catch up with or it caught up.
 */
export async function catchUpWithPublished(
  ctx: GitHubCommitsContext,
  args: GitHubCommitsArgs,
): Promise<GitHubCommitsOutcome | null> {
  const { git, branchPath, branchRef } = args
  const published = await readPublishedSha(ctx, branchRef)
  if (published === null) return null
  // Only the merge this worker stamped as landing: `remote.git` can also hold a same-named branch,
  // or a reviewer's commit, that it never wrote, which other steps judge.
  const landing = await new MergeConflictStore(branchPath).read().then(
    (record) => record?.landing?.mergeSha,
    () => undefined,
  )
  if (landing !== published) return null
  const head = (await git.revparse(['HEAD'])).trim()
  if (published === head) return null
  if (!(await holdsCommit(git, published))) {
    await fetchFromRemoteGit(git, ctx.remoteGitPath, `refs/heads/${branchRef}`)
  }
  const parents = (
    await git.raw(['rev-list', '--parents', '-n', '1', '--end-of-options', published])
  )
    .trim()
    .split(' ')
  if (parents.length !== 3 || parents[1] !== head) return null
  return fastForward(ctx, args, head, published)
}

/** Bring GitHub's commits into the clone. Throws what git throws; the caller records it. */
export async function bringInGitHubCommits(
  ctx: GitHubCommitsContext,
  args: GitHubCommitsArgs,
): Promise<GitHubCommitsOutcome> {
  const { git, branchRef, metaFile, dirty, gatewayPolicy } = args
  const { branch } = metaFile
  // A branch.json naming another ref is that branch's, which shares this directory's name.
  if (branch.name !== branchRef) return { kind: 'in-step' }

  const gitHubTip = args.gitHub?.tips.get(branchRef)
  // No GitHub branch leaves nothing a push could restore. Ahead of `isPublished`: withdrawing drops
  // a closed PR's number, which can be all that marked the branch published.
  if (args.gitHub !== undefined && gitHubTip === undefined && branch.rewrittenOnGitHub) {
    await clearRewritten(ctx, args)
  }
  if (!isPublished(metaFile)) return { kind: 'in-step' }
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
    if (!(await holdsCommit(git, tip))) return { kind: 'wait' }
    const lastSeen = await rewrittenFrom(args, tip, head, published)
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
  // reconcile made, and the check above has ruled out a head GitHub dropped. Taken first, so a merge
  // below builds on remote.git's head whenever it can.
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
      // Reconcile didn't take this tip in. The clone stays level with `remote.git`, or the next
      // force-push would find a commit in the clone that neither the record nor `remote.git` names.
      if (gitHubTip !== undefined && published !== null && published !== tip) {
        return { kind: 'wait' }
      }
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
  // held, and read as a rewrite on GitHub once it failed. So the branch waits for the push, or takes
  // the base by a merge when the push failed for good, which isn't queued again unless a cleared
  // rewrite was all that stopped it: a new attempt would fail the same way every cycle.
  if (
    gitHubTip !== undefined &&
    published !== null &&
    published !== tip &&
    (!gatewayPolicy || publishesBranch(gatewayPolicy, branchRef)) &&
    (await contains(git, published, tip))
  ) {
    if (branch.syncStatus === 'sync-failed' && !rewriteResolved) return { kind: 'unpushed' }
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
 * The commit a rewrite on GitHub removed, or null. A commit removed on GitHub stays removed: its
 * clone and `remote.git` may still hold it, and nothing here may put it back. Any commit GitHub is
 * known to hold counts: the last tip seen, and the commit a pending rewrite of the worker's own
 * replaced, since GitHub stays there until that push lands. A tip holding everything the clone and
 * `remote.git` hold has nothing to restore, whatever the record says. A commit in neither was
 * never taken in, so `remote.git`'s head has to be part of that test: the clone can lag it for a
 * cycle, and the fast-forward below would then bring back what GitHub dropped.
 */
async function rewrittenFrom(
  { git, metaFile }: GitHubCommitsArgs,
  tip: string,
  head: string,
  published: string | null,
): Promise<string | null> {
  const { lastGitHubTip, historyRewrittenFrom } = metaFile.branch
  // A branch with no record yet: a `remote.git` head the clone lags, diverged from GitHub, is a
  // commit reconcile took in before a force-push, barring a crash mid-merge on that first cycle.
  const unrecorded =
    lastGitHubTip === undefined &&
    published !== null &&
    published !== head &&
    (await contains(git, published, head)) &&
    !(await contains(git, published, tip))
      ? published
      : undefined
  // The marker first: what is named here must be a commit GitHub really held, and a rewrite's
  // stamp may not have reached it yet.
  const known = [historyRewrittenFrom, lastGitHubTip ?? unrecorded].filter(
    (sha): sha is string => sha !== undefined && COMMIT_ID.test(sha),
  )
  if (known.length === 0) return null
  if (
    (await contains(git, tip, head)) &&
    (published === null || (await contains(git, tip, published)))
  ) {
    return null
  }
  for (const sha of known) if (await contains(git, tip, sha)) return null
  // Git says a commit is missing when a pack it lives in can't be read, so only a full read of the
  // tip's history makes "not contained" an answer.
  const walked = await git.raw(['rev-list', '--count', '--end-of-options', tip])
  if (walked.trim() === '') throw new Error(`No answer reading the history of ${tip}`)
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
  await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).update((current) =>
    current?.branch.name === branchRef ? { branch: rewriteCleared(current.branch) } : null,
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
 * untracking it first leaves the branch holding a commit that does.
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
        `Commits coming into this branch change canopycms's own state, which must not be committed ` +
        `(${listPaths(changed)}). Nothing was brought in. To fix, ${TRACKED_CANOPY_STATE_FIX}.`,
    }
  }
  if (deleted.length > 0) {
    return {
      kind: 'blocked',
      reason:
        `Commits coming into this branch stop tracking canopycms state this clone still tracks ` +
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
    await moveClone(git, branchPath, to)
  } catch (err) {
    if (!/would be overwritten/.test(getErrorMessage(err))) throw err
    workerLog(`  ${branchDir}: local changes overlap commits from GitHub, which wait for a submit`)
    return { kind: 'wait' }
  }
  workerLog(`  ${branchDir}: brought in commits from GitHub (now at ${to.slice(0, 7)})`)
  // A merge this worker was landing, which the clone now holds, has landed.
  const landing = await new MergeConflictStore(branchPath).read().then(
    (record) => record?.landing?.mergeSha,
    () => undefined,
  )
  if (landing !== undefined && (await contains(git, to, landing))) {
    await landed(ctx, args, landing).catch((err: unknown) =>
      workerLogWarn(
        `  ${branchDir}: what a merge kept is noted on the next cycle: ${getErrorMessage(err)}`,
      ),
    )
  }
  return null
}

/**
 * Fast-forward the clone to `to`. The caches' markers move after it, as for any bulk mutation, and
 * before it too: nothing repairs a marker lost after the move, as the next cycle sees a clone in
 * step, and the earlier bump leaves only a read racing the move able to stamp the old tree.
 */
async function moveClone(git: SimpleGit, branchPath: string, to: string): Promise<void> {
  await invalidateBranchContentCaches(branchPath)
  await git.raw(['merge', '--ff-only', '--end-of-options', to])
  await invalidateBranchContentCaches(branchPath)
}

/**
 * `other` merged into the branch: built, recorded, published to `remote.git`, queued for GitHub,
 * and the clone moved to it, in that order, so each step leaves what the next cycle picks up and
 * only the last touches the working tree. `fromGitHub` says `other` is GitHub's tip rather than the
 * base. `inReview` takes only a merge with nothing for a person to choose; any other leaves the
 * branch as it is and records nothing, and GitHub's own conflict notice stands on the pull request. A lock lost before the clone moves leaves it where it was: `wait`.
 */
export async function mergeIntoBranch(
  ctx: GitHubCommitsContext,
  args: GitHubCommitsArgs,
  merge: {
    head: string
    other: string
    message: string
    fromGitHub: boolean
    inReview?: boolean
  },
): Promise<GitHubCommitsOutcome> {
  const { git, branchPath, branchDir, branchRef, gatewayPolicy, lockLost } = args
  const { head, other, message, fromGitHub, inReview } = merge
  const plan = await planMerge(git, branchPath, {
    head,
    other,
    contentRoot: ctx.contentRoot,
    timeoutMs: ctx.taskTimeoutMs,
  })
  // Nobody is at the editor of a branch in review to choose: a value or file kept over the other
  // side's change would stand unseen in the pull request. Held before any commit is written, as a
  // branch can stay held for days.
  if (
    inReview &&
    (plan.kind === 'unsettled' || plan.conflicts.length > 0 || plan.keptPaths.length > 0)
  ) {
    workerLog(`  ${branchDir}: conflicts with ${other.slice(0, 7)}, so it stays as it is`)
    return { kind: 'wait' }
  }
  if (plan.kind === 'unsettled') {
    return {
      kind: 'blocked',
      reason:
        `Git cannot merge ${other} into ${branchRef} by rule: ${plan.conflicts.join(', ')}` +
        `${plan.paths.length > 0 ? ` (${listPaths(plan.paths)})` : ''}. Nothing was changed. ` +
        `To continue, a developer merges them by hand.`,
    }
  }
  const built = await commitMerge(git, plan, { head, other, message })
  const { sha, conflicts } = built
  const refused = await refuseIncoming(args, head, sha)
  if (refused) return refused
  if (lockLost()) return { kind: 'wait' }
  // A field merge of the base settles what git could not, which no reviewer has seen either.
  // Approving waits for the content-write lock the caller holds, so none lands after this check.
  if (await changesWhatWasReviewed(ctx, args, head, sha)) await returnToReview(ctx, args)

  const published = await readPublishedSha(ctx, branchRef)
  const unpublishable =
    `This deployment's repository holds commits for ${branchRef} that neither this clone nor ` +
    `GitHub has, so a merge of the two cannot be published. Nothing was changed. Compare the ` +
    `copies with a developer before submitting again.`
  if (published !== null && !(await contains(git, sha, published))) {
    return { kind: 'blocked', reason: unpublishable }
  }
  // Recorded before the merge is visible anywhere: the next cycle only fast-forwards to it, and
  // the conflicts cannot be read back from the merge. A merge that never lands leaves records the
  // next cycle's reconcile turns back.
  await recordMerge(ctx, args, built, { head, fromGitHub })
  if (lockLost()) return { kind: 'wait' }
  // Before `remote.git` holds it, as reconcile does: a crash past this point leaves GitHub's commit
  // in `remote.git`, and a removal then has to read as one (`rewrittenFrom`).
  if (fromGitHub) await recordSeenOnGitHub(ctx, branchRef, other)
  if (published !== null) {
    if (!(await publishPlainToLocalRemote(ctx, branchPath, branchRef, sha))) {
      return { kind: 'blocked', reason: unpublishable }
    }
    await enqueueGitHubPush(ctx, branchRef, gatewayPolicy)
  }
  // Published and not yet in the clone: the next cycle brings it in, by `bringInGitHubCommits` or
  // `catchUpWithPublished`.
  if (lockLost()) return { kind: 'wait' }
  await moveClone(git, branchPath, sha)
  // Landed: a failure here leaves the remaps and the stamp for the next cycle's reconcile.
  await landed(ctx, args, sha).catch((err: unknown) =>
    workerLogWarn(
      `  ${branchDir}: what this merge kept is noted on the next cycle: ${getErrorMessage(err)}`,
    ),
  )
  if (fromGitHub) await recordGitHubTip(ctx, args, other)
  const keptEntries = new Set(conflicts.map(({ contentId }) => contentId)).size
  workerLog(
    keptEntries > 0
      ? `  ${branchDir}: merged ${other.slice(0, 7)} (${keptEntries} entr${keptEntries === 1 ? 'y' : 'ies'} with values for a person to choose: ${listPaths(conflicts.map(({ path }) => path))})`
      : `  ${branchDir}: merged ${other.slice(0, 7)}`,
  )
  return { kind: 'merged', keptEntries }
}

/**
 * Whether this clone holds `sha`, on git's word for it. A killed `git` answers nothing at all,
 * which simple-git resolves empty, and that throws. Git says the same of a commit in a pack it
 * can't read, so a caller that acts on "no" reads the history too, as `rewrittenFrom` does.
 */
async function holdsCommit(git: SimpleGit, sha: string): Promise<boolean> {
  let found: string
  try {
    found = await git.raw(['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`])
  } catch (err) {
    if (/Needed a single revision/.test(getErrorMessage(err))) return false
    throw err
  }
  if (found.trim() === '') throw new Error(`No answer looking for ${sha}`)
  return true
}

/**
 * Whether `commit` contains `ancestor`. A commit this clone does not hold counts as no. Any other
 * failure throws, since it says nothing about either commit, and the caller's catch retries next
 * cycle: read as no, it would report a rewrite that never happened.
 */
export async function contains(git: SimpleGit, commit: string, ancestor: string): Promise<boolean> {
  if (!(await holdsCommit(git, commit)) || !(await holdsCommit(git, ancestor))) return false
  return (await commitsApart(git, ancestor, commit)).onlyA === 0
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
 * Send an approved branch back to review and clear the verdict from the PR body. Called before the
 * clone moves, where a failed save throws, so a crash or a failure leaves the commits for the next
 * cycle to judge again rather than an approval standing over them.
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
  workerLog(`  ${branchDir}: back in review, as what was approved changed`)
  await enqueueReviewBlockSync(ctx, branchRef, metaFile)
}

/**
 * Record what a merge left for a person in merge-conflicts.json, with the item keys it changed for
 * the branch's comment threads to take once it lands and the merge as `landing`, and the content
 * IDs it names in `branch.json` `conflictFiles`. The record is first settled against `head`, which
 * the merge builds on, so a record of a merge that never landed can't carry into this one. Before
 * the merge is visible: one that never lands leaves records the next
 * {@link reconcileMergeConflicts} turns back.
 */
async function recordMerge(
  ctx: GitHubCommitsContext,
  args: GitHubCommitsArgs,
  built: BuiltMerge,
  merge: { head: string; fromGitHub: boolean },
): Promise<void> {
  const { git, branchPath, branchRef } = args
  const { sha, conflicts, keptPaths, keyRemaps, paths } = built
  const inHead = await settleRecord(git, branchPath, merge.head)
  const state = await new MergeConflictStore(branchPath).update((current) => ({
    entries: withFoundConflicts(
      withRemappedItemKeys(
        current ? withoutMergesGone(current.entries, inHead) : {},
        keyRemaps,
        sha,
      ),
      conflicts,
      sha,
      paths,
    ),
    remaps: [
      ...(current?.remaps ?? []),
      ...keyRemaps.map(({ entryPath, remaps }) => ({ mergeSha: sha, entryPath, remaps })),
    ],
    landing: {
      mergeSha: sha,
      ...(merge.fromGitHub && keptPaths.length > 0 && { keptOverGitHub: keptPaths }),
    },
  }))
  if (state === null) return
  await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).update((existing) =>
    existing?.branch.name === branchRef ? { branch: conflictFilesOf(state.entries) } : null,
  )
}

/**
 * After the clone moved to `sha`, the merge being landed: the remaps of every merge it holds apply,
 * in the order recorded, the paths it kept over GitHub's commits go in `keptOverGitHub` for the PR
 * body, and it is no longer landing. A remap that fails waits for the next cycle, and keeps nothing
 * else from being noted.
 */
async function landed(
  ctx: GitHubCommitsContext,
  {
    git,
    branchPath,
    branchRef,
    branchDir,
    metaFile,
  }: Pick<GitHubCommitsArgs, 'git' | 'branchPath' | 'branchRef' | 'branchDir' | 'metaFile'>,
  sha: string,
): Promise<void> {
  const store = new MergeConflictStore(branchPath)
  const current = await store.read()
  if (current === null) return
  const [inSha] = await mergesHeld(git, current, [sha])
  await applyRemaps(branchPath, (mergeSha) => inSha.has(mergeSha)).catch((err: unknown) =>
    workerLogWarn(
      `  ${branchDir}: comment threads keep their item keys for now: ${getErrorMessage(err)}`,
    ),
  )
  const landing = current.landing
  if (landing?.mergeSha !== sha) return
  const kept = landing.keptOverGitHub ?? []
  if (kept.length > 0) {
    await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).update((existing) =>
      existing?.branch.name === branchRef
        ? {
            branch: {
              keptOverGitHub: [...new Set([...(existing.branch.keptOverGitHub ?? []), ...kept])],
            },
          }
        : null,
    )
    await enqueueReviewBlockSync(ctx, branchRef, metaFile)
  }
  await store.update((now) => {
    if (now?.landing?.mergeSha !== sha) return null
    const { landing: _done, ...rest } = now
    return rest
  })
}

/** Every merge a record names, its earlier versions' included. */
function mergesNamedBy(entry: MergeConflictEntry): string[] {
  return [
    entry.mergeSha,
    ...(entry.fields ?? []).map((f) => f.mergeSha),
    ...(entry.previous ? mergesNamedBy(entry.previous) : []),
  ]
}

/** The merges merge-conflicts.json names, and which of them each of `tips` holds. */
async function mergesHeld(
  git: SimpleGit,
  state: MergeConflictState,
  tips: readonly string[],
): Promise<Array<Set<string>>> {
  const shas = new Set([
    ...Object.values(state.entries).flatMap(mergesNamedBy),
    ...(state.remaps ?? []).map(({ mergeSha }) => mergeSha),
    ...(state.landing ? [state.landing.mergeSha] : []),
  ])
  const held = tips.map(() => new Set<string>())
  for (const sha of shas) {
    for (const [n, tip] of tips.entries()) {
      if (await contains(git, tip, sha)) held[n].add(sha)
    }
  }
  return held
}

/**
 * The record as `head` has it: comment threads take the item keys of merges `head` holds, other
 * merges' remaps go, and records changed by merges it lacks give back the ones they replaced.
 * Resolves whether `head` holds a merge the record named then; a merge recorded since counts as
 * held, as nothing settled it.
 */
async function settleRecord(
  git: SimpleGit,
  branchPath: string,
  head: string,
): Promise<(mergeSha: string) => boolean> {
  const store = new MergeConflictStore(branchPath)
  const current = await store.read()
  if (current === null) return () => true
  const [held] = await mergesHeld(git, current, [head])
  const known = new Set([
    ...Object.values(current.entries).flatMap(mergesNamedBy),
    ...(current.remaps ?? []).map(({ mergeSha }) => mergeSha),
  ])
  const inHead = (sha: string) => held.has(sha) || !known.has(sha)
  // The threads can wait: the remaps stay for the next cycle.
  await applyRemaps(branchPath, inHead, (sha) => !inHead(sha)).catch((err: unknown) =>
    workerLogWarn(`  comment threads keep their item keys for now: ${getErrorMessage(err)}`),
  )
  return inHead
}

/**
 * Point the branch's comment threads at the item keys the merges in `landed` gave their items, in
 * the order they were recorded, then drop those remaps from the record, and those `gone` names
 * unapplied.
 */
async function applyRemaps(
  branchPath: string,
  landed: (mergeSha: string) => boolean,
  gone: (mergeSha: string) => boolean = () => false,
): Promise<void> {
  const store = new MergeConflictStore(branchPath)
  const pending = (await store.read())?.remaps ?? []
  const due = pending.filter(({ mergeSha }) => landed(mergeSha))
  if (due.length === 0 && !pending.some(({ mergeSha }) => gone(mergeSha))) return
  const comments = new CommentStore(branchPath)
  for (const { entryPath, remaps } of due) await comments.remapItemKeys(entryPath, remaps)
  await store.update(
    (current) =>
      current && {
        ...current,
        remaps: (current.remaps ?? []).filter(
          ({ mergeSha }) => !landed(mergeSha) && !gone(mergeSha),
        ),
      },
  )
}

/** `branch.json` `conflictFiles` as `entries` has them, written only when the two differ. */
async function followRecord(
  ctx: GitHubCommitsContext,
  branchPath: string,
  branchDir: string,
  branchRef: string | null,
  entries: Readonly<Record<string, MergeConflictEntry>>,
): Promise<void> {
  const { conflictFiles, conflictStatus } = conflictFilesOf(entries)
  const same = (ids: readonly string[] | undefined) =>
    JSON.stringify([...(ids ?? [])].sort()) === JSON.stringify(conflictFiles)
  // Read first: the locked update costs every branch a lock each cycle, and nearly all agree.
  const read = (await BranchMetadataFileManager.loadOnly(branchPath))?.branch
  if (read === undefined || (branchRef !== null && read.name !== branchRef)) return
  if (same(read.conflictFiles)) return
  const saved = await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).update(
    (existing) =>
      existing !== null &&
      (branchRef === null || existing.branch.name === branchRef) &&
      !same(existing.branch.conflictFiles)
        ? { branch: { conflictFiles, conflictStatus } }
        : null,
    { keepUpdatedAt: true },
  )
  if (saved) workerLog(`  ${branchDir}: ${conflictFiles.length} entries with conflicts on record`)
}

/**
 * Bring merge-conflicts.json in line with the branch's history: a record changed by a merge the
 * branch never got gives back the one it replaced (`withoutMergesGone`), and `branch.json`
 * `conflictFiles` follows the record when the two differ. A merge counts as held while the clone or
 * `remote.git` holds it, since a clone behind its published merge catches up with it; comment
 * threads take a merge's item keys only once the clone holds it. While either can't be read in the
 * clone, nothing is judged. A record that does not parse is moved aside, so the branch's merges
 * carry on with a new one. Each cycle, before the branch takes anything in. A clone with no record
 * has no conflict open, so `conflictFiles` written before the record existed clears. Never throws.
 */
export async function reconcileMergeConflicts(
  ctx: GitHubCommitsContext,
  {
    git,
    branchPath,
    branchDir,
    branchRef,
  }: Pick<GitHubCommitsArgs, 'git' | 'branchPath' | 'branchDir'> & { branchRef: string | null },
): Promise<void> {
  try {
    const store = new MergeConflictStore(branchPath)
    let current
    try {
      current = await store.read()
    } catch (err) {
      if (!(err instanceof MergeConflictsFileMalformedError)) throw err
      const aside = await store.quarantine()
      if (aside !== null) {
        workerLogWarn(`  ${branchDir}: its conflict record does not parse; copied it to ${aside}`)
      }
      // The held record, or one another writer left in its place.
      current = await store.read()
    }
    if (current === null) {
      await followRecord(ctx, branchPath, branchDir, branchRef, {})
      return
    }
    const published = branchRef === null ? null : await readPublishedSha(ctx, branchRef)
    if (published !== null && !(await holdsCommit(git, published))) {
      await fetchFromRemoteGit(git, ctx.remoteGitPath, `refs/heads/${branchRef}`)
    }
    const tips = ['HEAD', ...(published === null ? [] : [published])]
    for (const tip of tips) if (!(await holdsCommit(git, tip))) return
    const [inHead, inPublished = new Set<string>()] = await mergesHeld(git, current, tips)
    const held = (sha: string) => inHead.has(sha) || inPublished.has(sha)
    const entries =
      (
        await store.update((now) => {
          if (now === null) return null
          const kept = withoutMergesGone(now.entries, held)
          const { landing, ...rest } = now
          // A clone catches up only with a merge `remote.git` holds; one it holds lands below.
          // Without `remote.git`'s head to read, a published merge can't be told from a lost one.
          const stays = landing !== undefined && (branchRef === null || held(landing.mergeSha))
          if (JSON.stringify(kept) === JSON.stringify(now.entries) && (stays || !landing)) {
            return null
          }
          return { ...rest, entries: kept, ...(stays && { landing }) }
        })
      )?.entries ?? current.entries
    await followRecord(ctx, branchPath, branchDir, branchRef, entries)
    await applyRemaps(
      branchPath,
      (sha) => inHead.has(sha),
      (sha) => !held(sha),
    )
    if (current.landing && inHead.has(current.landing.mergeSha) && branchRef !== null) {
      const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
      if (metaFile) {
        await landed(
          ctx,
          { git, branchPath, branchRef, branchDir, metaFile },
          current.landing.mergeSha,
        )
      }
    }
  } catch (err) {
    workerLogWarn(
      `  ${branchDir}: could not reconcile its conflict record: ${getErrorMessage(err)}`,
    )
  }
}

/**
 * Re-render the PR body's review block alone: the worker has no `config.editorUrl`, so a full
 * sync from here would strip the comment summary's links. Best-effort: a failure leaves the block
 * until the branch's next sync.
 */
export async function enqueueReviewBlockSync(
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

/**
 * Skipped when nothing changes: every save regenerates the branch registry. Bookkeeping, so it
 * leaves `updatedAt`, which the card shows as an edit.
 */
async function recordGitHubTip(
  ctx: GitHubCommitsContext,
  { branchPath, branchRef, metaFile, gitHub }: GitHubCommitsArgs,
  tip: string,
): Promise<void> {
  const { lastGitHubTip, rewrittenOnGitHub } = metaFile.branch
  if (gitHub?.tips.get(branchRef) !== tip) return
  if (lastGitHubTip === tip && rewrittenOnGitHub === undefined) return
  await getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath).update(
    (current) => {
      if (current?.branch.name !== branchRef) return null
      // A stamp newer than this cycle's fetch is a push that landed since, which GitHub holds.
      const seen = current.branch.lastGitHubTip === lastGitHubTip ? { lastGitHubTip: tip } : {}
      return { branch: { ...seen, ...rewriteCleared(current.branch) } }
    },
    { keepUpdatedAt: true },
  )
}
