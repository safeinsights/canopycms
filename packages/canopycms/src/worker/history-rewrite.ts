import path from 'node:path'
import { simpleGit } from 'simple-git'
import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { gitChildEnv } from '../git-manager'
import { sanitizeBranchName } from '../paths/branch-name'
import { getErrorMessage, redactCredentials } from '../utils/error'
import { isStaleLeaseRejection } from '../utils/git'
import { enqueueTask, listTasks } from './task-queue'
import { workerLog, workerLogWarn } from './log'
import type { WorkerContext } from './worker-context'

/**
 * [SYNC-H1] The history-rewrite kernel: what happens when the rebase loop
 * rewrites history that was ALREADY published to `remote.git` (and from there
 * to GitHub).
 *
 * Extracted from cms-worker.ts because it is the one thing all three of the
 * worker's big clusters touch, and for opposite-looking reasons:
 *
 * - rebase.ts ARMS a rewrite (mark -> publish -> queue) and completes an
 *   interrupted one via `reconcilePendingRewrite`;
 * - task-runner.ts CONSUMES the marker when `pushBranchToGitHub` leases its
 *   push, and CLEARS it once GitHub confirms;
 * - git-sync.ts READS it in `reconcileTrackedBranches`, to tell this worker's
 *   own in-flight rewrite apart from a genuine cross-deployment collision.
 *
 * Leaving these on the class would have made every cluster's module import
 * every other one. They share no state beyond four resolved paths, so they
 * belong here.
 *
 * THE INVARIANT, since it is spread across those three callers: every force
 * push leases on a SPECIFIC commit this worker knows its own rebase replaced
 * -- the marker, or the pre-rebase tip -- never on "whatever remote.git holds
 * right now". A lease on the current tip is satisfied by a reviewer's direct
 * push to the PR branch and would delete it, silently, from remote.git and
 * then from GitHub.
 */
export type HistoryRewriteContext = Pick<
  WorkerContext,
  'remoteGitPath' | 'contentBranchesPath' | 'taskDir' | 'taskTimeoutMs'
>

/**
 * What `remote.git` currently holds for `branchRef`, or null when this
 * branch was never published there (never submitted) or the ref is
 * unreadable.
 *
 * Uses the same explicit `--git-dir` shape as verifyBaseBranchExists()
 * in cms-worker.ts: reading a bare repo that way does not depend on
 * `safe.bareRepository` being permissive, which is why prod code takes
 * this route rather than the config override the test-only `openBareRepo`
 * helper uses.
 */
export async function readPublishedSha(
  ctx: Pick<HistoryRewriteContext, 'remoteGitPath'>,
  branchRef: string,
): Promise<string | null> {
  try {
    const out = await simpleGit().raw([
      '--git-dir',
      ctx.remoteGitPath,
      'rev-parse',
      '--verify',
      `refs/heads/${branchRef}`,
    ])
    const sha = out.trim()
    return sha.length > 0 ? sha : null
  } catch {
    // Absent from remote.git: this branch was never submitted, so none of
    // its history was ever published. Not an error.
    return null
  }
}

/**
 * Record that this worker rewrote `expectedSha` out of a branch's already
 * published history (see BranchMetadata.historyRewrittenFrom).
 *
 * Set-once: if a marker is already present it is LEFT ALONE. Across two
 * rebases before any GitHub push lands, GitHub still holds the commit the
 * FIRST rebase replaced, so advancing the marker would aim the lease at a
 * commit GitHub never had and permanently wedge the branch.
 *
 * Re-reads metadata rather than trusting the caller's loop-top snapshot:
 * the task loop runs concurrently with syncGit() (see scheduleLoop) and may
 * have cleared the marker while this branch was rebasing.
 */
export async function markHistoryRewritten(
  ctx: Pick<HistoryRewriteContext, 'contentBranchesPath'>,
  branchPath: string,
  branchDir: string,
  expectedSha: string,
): Promise<void> {
  const current = await BranchMetadataFileManager.loadOnly(branchPath)
  if (typeof current?.branch.historyRewrittenFrom === 'string') return
  const meta = getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath)
  await meta.save({ branch: { name: branchDir, historyRewrittenFrom: expectedSha } })
}

/**
 * Clear the marker once GitHub is confirmed to hold the rewritten history.
 *
 * Best-effort only in the sense that a failure here destroys nothing: the
 * lease still refuses anything unexpected, and the plain-push fallback only
 * ever fast-forwards. It is NOT harmless. A marker that outlives its
 * episode can wedge the NEXT one -- if the base advances before the stale
 * marker is revisited, the queued push leases a commit GitHub has already
 * moved off, falls back to a plain push of a rebased (non-ancestor)
 * history, and fails permanently with a "something else moved it on
 * GitHub" diagnosis that is false: we did.
 *
 * Tracked, with the concurrent-clear race that can drop a marker
 * mid-arming, in
 * .claude/future-tasks/worker-history-rewrite-marker-races.md.
 */
export async function clearHistoryRewrittenMarker(
  ctx: Pick<HistoryRewriteContext, 'contentBranchesPath'>,
  branchPath: string,
  branchDir: string,
): Promise<void> {
  try {
    const meta = getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath)
    // Explicit undefined clears the key -- save()'s merge only overwrites
    // keys present in the update (same pattern as rebaseFailure).
    await meta.save({ branch: { name: branchDir, historyRewrittenFrom: undefined } })
  } catch (err) {
    workerLogWarn(
      `  Failed to clear history-rewrite marker for ${branchDir}: ${getErrorMessage(err)}`,
    )
  }
}

/**
 * Publish a branch clone's rebased history into `remote.git`, replacing
 * EXACTLY `expectedSha` and nothing else.
 *
 * The lease is the entire safety argument. `--force-with-lease=<ref>:<sha>`
 * refuses unless `remote.git` still stands at `<sha>`, so this can only
 * ever undo the commit our own rebase rewrote away. Callers must never pass
 * "whatever remote.git currently holds" -- see the arming guard in
 * rebase.ts's carryForwardRewrittenHistory for the interleaving where that
 * would silently delete a reviewer's direct push.
 *
 * Returns whether the push landed. A refused lease means a concurrent
 * Lambda push moved the ref; that is logged and retried by the self-heal
 * pass on a later cycle, never thrown.
 */
export async function forcePublishToLocalRemote(
  ctx: Pick<HistoryRewriteContext, 'taskTimeoutMs'>,
  branchPath: string,
  branchRef: string,
  expectedSha: string,
): Promise<boolean> {
  // A dedicated instance rather than the caller's: `.env()` replaces the
  // whole child environment, and the rebase loop's instance must keep its
  // ambient one. gitChildEnv (not gitNetworkChildEnv) because this push
  // targets the local bare repo -- and the locale pin is what keeps
  // isStaleLeaseRejection below from silently becoming a no-op.
  const pushGit = simpleGit({ baseDir: branchPath, timeout: { block: ctx.taskTimeoutMs } })
  pushGit.env(gitChildEnv({}))
  try {
    await pushGit.raw([
      'push',
      `--force-with-lease=${branchRef}:${expectedSha}`,
      // Real flags must precede --end-of-options; everything after it is
      // positional (see GitManager.push() for the same guard).
      '--end-of-options',
      'origin',
      `${branchRef}:${branchRef}`,
    ])
    workerLog(`  Published rebased ${branchRef} into remote.git`)
    return true
  } catch (err) {
    const message = redactCredentials(getErrorMessage(err))
    workerLogWarn(
      isStaleLeaseRejection(message)
        ? `  Did not publish rebased ${branchRef} into remote.git: it moved since this cycle read it (concurrent submit?) -- retrying next cycle`
        : `  Failed to publish rebased ${branchRef} into remote.git: ${message}`,
    )
    return false
  }
}

/**
 * Queue the GitHub hop for a branch whose rewritten history now sits in
 * `remote.git`, so an open PR's head follows the rebase within a cycle
 * instead of waiting for the editor's next submit.
 *
 * Deliberately NOT skipped when a marker is already set: inferring "a task
 * must already be queued" from the marker starves this hop whenever a task
 * was lost, failed permanently, or was never written. Duplicate push tasks
 * are bounded by base-branch advances and are idempotent (a repeat push is
 * a no-op once GitHub holds the tip).
 */
export async function enqueueGitHubPush(
  ctx: Pick<HistoryRewriteContext, 'taskDir'>,
  branchRef: string,
): Promise<void> {
  try {
    // Dedupe against tasks actually in flight rather than against the
    // marker: a branch whose GitHub push keeps failing would otherwise
    // gain one task per sync cycle forever.
    for (const status of ['pending', 'processing'] as const) {
      const inFlight = await listTasks(ctx.taskDir, status)
      if (inFlight.some((t) => t.action === 'push-branch' && t.payload.branch === branchRef)) {
        return
      }
    }
    await enqueueTask(ctx.taskDir, { action: 'push-branch', payload: { branch: branchRef } })
    workerLog(`  Queued GitHub push for ${branchRef}`)
  } catch (err) {
    workerLogWarn(`  Failed to queue GitHub push for ${branchRef}: ${getErrorMessage(err)}`)
  }
}

/**
 * Complete a rewrite this worker started but did not finish: get the
 * rebased history into `remote.git` and queued for GitHub.
 *
 * Runs from the rebase loop for any branch carrying a marker, whether or
 * not it is behind base this cycle, so an interrupted publish converges
 * without waiting for the next base-branch advance.
 *
 * Always leases on the MARKER, never on remote.git's current tip -- the
 * marker is the one commit we know our own rebase replaced.
 */
export async function reconcilePendingRewrite(
  ctx: HistoryRewriteContext,
  options: {
    branchPath: string
    branchDir: string
    branchRef: string
    headSha: string
    marker: string
  },
): Promise<void> {
  const { branchPath, branchDir, branchRef, headSha, marker } = options
  const publishedSha = await readPublishedSha(ctx, branchRef)

  if (publishedSha === null) {
    workerLogWarn(
      `  ${branchDir}: a rewritten history is recorded but ${branchRef} is gone from remote.git -- nothing to publish`,
    )
    return
  }
  if (publishedSha === headSha) {
    // remote.git already carries the rewrite; only the GitHub hop is left
    // (a crash between the push and the queue, or a task that was lost).
    await enqueueGitHubPush(ctx, branchRef)
    return
  }
  if (publishedSha === marker) {
    // The publish into remote.git never landed -- a crash right after the
    // marker was written, or a lease refused by a concurrent submit.
    if (await forcePublishToLocalRemote(ctx, branchPath, branchRef, marker)) {
      await enqueueGitHubPush(ctx, branchRef)
    }
    return
  }
  // Neither this branch's rebased tip nor the commit its rewrite replaced:
  // something else moved remote.git. Never force over that.
  workerLogWarn(
    `  ${branchDir}: remote.git is at ${publishedSha} for ${branchRef}, which is neither the ` +
      `rebased tip nor the commit the rewrite replaced -- left untouched`,
  )
}

/**
 * Whether this branch carries a pending history rewrite -- the rebase loop
 * rewrote already-published history and the GitHub push has not landed yet
 * (see BranchMetadata.historyRewrittenFrom).
 *
 * `branchName` is a git ref name; branch workspaces are directories named
 * with the sanitized form, hence the conversion. Best-effort: a settings
 * branch (no workspace at all), a missing directory or an unreadable
 * branch.json all mean "no known rewrite", which is the conservative
 * answer -- it keeps the branch in the louder `diverged` bucket.
 */
export async function hasPendingHistoryRewrite(
  ctx: Pick<HistoryRewriteContext, 'contentBranchesPath'>,
  branchName: string,
): Promise<boolean> {
  try {
    const branchPath = path.join(ctx.contentBranchesPath, sanitizeBranchName(branchName))
    const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
    return typeof metaFile?.branch.historyRewrittenFrom === 'string'
  } catch {
    return false
  }
}
