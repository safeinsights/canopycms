import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import {
  BranchMetadataFileManager,
  buildMergedBranchUpdate,
  getBranchMetadataFileManager,
  type BranchMetadataFile,
} from '../branch-metadata'
import { extractIdFromFilename } from '../content-id-index'
import { invalidateBranchContentCaches } from '../content-index-generation'
import { normalizeFilesystemPath } from '../paths/normalize'
import { ROOT_COLLECTION_ID, type ContentId } from '../paths/types'
import type { PullRequestState } from '../types'
import { tryAcquireContentWriteLock } from '../utils/content-write-lock'
import { getErrorMessage, isNodeError, redactCredentials } from '../utils/error'
import { isRebaseInProgress } from '../utils/git'
import {
  enqueueGitHubPush,
  forcePublishToLocalRemote,
  markHistoryRewritten,
  readPublishedSha,
  reconcilePendingRewrite,
} from './history-rewrite'
import { workerLog, workerLogWarn } from './log'
import type { WorkerContext } from './worker-context'

/**
 * The rebase loop: the largest and most safety-critical of the four call trees
 * that used to share cms-worker.ts, and the deepest leaf of the git-sync
 * cluster. `syncGit` (git-sync.ts) calls `runRebaseCycle` once per cycle.
 *
 * Every branch workspace that is behind the base branch is rebased onto it,
 * keeping the BRANCH's version of any conflicting file. Three things make this
 * the part of the worker most likely to misbehave under real EFS and spot
 * conditions, and all three are documented at the point they happen rather
 * than here:
 *
 * - it holds the [SYNC-C1] cross-host content-write lock for the whole rebase,
 *   so an editor's save cannot be destroyed mid-replay;
 * - it recovers a rebase INTERRUPTED by a crash, OOM or spot interruption,
 *   which is lossy in a specific, logged way;
 * - it carries a rewritten history forward into remote.git and GitHub under a
 *   lease keyed to the exact commit it replaced ([SYNC-H1], history-rewrite.ts).
 *
 * `pollMergeState` lives here rather than in git-sync.ts because the rebase
 * loop is its only caller: submitted/approved branches are skipped for rebasing
 * but still need their PR's resolution polled, and this loop is the only thing
 * that walks every branch workspace.
 */
export type RebaseContext = Pick<
  WorkerContext,
  | 'githubOwner'
  | 'githubRepo'
  | 'baseBranch'
  | 'sanitizedBaseBranch'
  | 'contentBranchesPath'
  | 'contentRoot'
  | 'remoteGitPath'
  | 'taskDir'
  | 'taskTimeoutMs'
  | 'octokit'
  | 'afterConflictDetectedForTesting'
  | 'afterRebaseCompletedForTesting'
>

/**
 * Per-cycle outcome of `rebaseActiveBranches()` (PR-W1). Folded by `syncGit()`
 * into the worker's self-reported status (`WorkerStatusReport.lastGitSync`,
 * see worker-status.ts) alongside a `durationMs` measured around the whole
 * sync cycle.
 */
export interface RebaseSummary {
  /**
   * Branches that were behind and completed a rebase onto the base branch
   * (successfully, whether or not conflicts were resolved via --theirs).
   * Branches that were already up to date are NOT listed here.
   */
  rebased: string[]
  /** Branches skipped this cycle because their working tree had uncommitted changes. */
  skippedDirty: string[]
  /**
   * [SYNC-C1] Branches skipped this cycle for a content-write-lock reason,
   * either of which is a RETRY rather than a failure:
   *
   * - a content write already held the branch's cross-host content-write lock
   *   (utils/content-write-lock.ts) -- the worker yields on contention, since
   *   the editor on the other side is a person waiting on a save; or
   * - the lock was LOST mid-rebase (compromised), so the worker stopped before
   *   the next destructive git step. Only when the rebase had not completed:
   *   a completed rebase must still run its completion path, or it strands the
   *   [SYNC-H1] marker on a branch nothing will revisit.
   */
  skippedLocked: string[]
  /** Branches whose rebase attempt failed (fetch error, unexpected rebase error, or MAX_REBASE_ROUNDS exceeded). */
  failed: { branch: string; error: string }[]
}

/**
 * Poll GitHub for a submitted/approved branch's PR resolution.
 *
 * submitted/approved branches sit outside the rebase loop and get no
 * other signal that their PR resolved on GitHub -- nothing pushes a
 * merge/close webhook back into the branch workspace. merged ->
 * auto-archive via buildMergedBranchUpdate (shared with the manual
 * markAsMerged API so both paths produce identical archived-branch
 * metadata). closed-without-merge -> record pullRequestState only; an
 * admin decides the workflow transition from there. Best-effort: any
 * failure here is logged and swallowed, retried next sync cycle.
 */
export async function pollMergeState(
  ctx: RebaseContext,
  branchDir: string,
  branchPath: string,
  metaFile: BranchMetadataFile | null,
): Promise<void> {
  const prNumber = metaFile?.branch.pullRequestNumber
  if (!prNumber) return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ctx.taskTimeoutMs)
  try {
    const { data } = await ctx.octokit().pulls.get({
      owner: ctx.githubOwner,
      repo: ctx.githubRepo,
      pull_number: prNumber,
      request: { signal: controller.signal },
    })

    if (data.merged) {
      const meta = getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath)
      // Use GitHub's actual merge time when available; buildMergedBranchUpdate
      // falls back to "now" (its default `now` param) when merged_at is absent.
      await meta.save({
        branch: buildMergedBranchUpdate(
          branchDir,
          data.merged_at ? new Date(data.merged_at) : undefined,
        ),
      })
      workerLog(`  PR #${prNumber} for ${branchDir} is merged -> archived`)
      return
    }

    const newState: PullRequestState = data.state === 'closed' ? 'closed' : 'open'
    // Re-load fresh (not the loop-top `metaFile` snapshot passed in) -- a
    // concurrent Lambda write (e.g. an editor re-submitting) may have
    // landed since that snapshot was taken.
    const currentMeta = await BranchMetadataFileManager.loadOnly(branchPath)
    if (currentMeta?.branch.pullRequestState === newState) return

    const meta = getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath)
    await meta.save({ branch: { name: branchDir, pullRequestState: newState } })
    workerLog(`  PR #${prNumber} for ${branchDir}: pullRequestState -> ${newState}`)
  } catch (err) {
    // Non-fatal: transient GitHub/network errors are retried next cycle.
    workerLogWarn(`  Failed to poll PR #${prNumber} for ${branchDir}: ${getErrorMessage(err)}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Persist a per-branch rebase failure to branch.json (PR-W2), bounded to
 * roughly one save per failing branch per hour: a branch stuck failing
 * every cycle must not turn into unbounded save-per-cycle x N-failing-
 * branches write amplification -- save() eager-regenerates the branch
 * registry (branch-metadata.ts's invalidateRegistry(), O(branch count) EFS
 * reads), the same concern the `alreadyClean` no-op guard above exists
 * for.
 *
 * Best-effort and non-fatal like every other metadata write in this
 * loop's error paths: a corrupt branch.json, a lock-contention error, or
 * any other save failure here must never abort the per-branch iteration.
 * This matters doubly at the two call sites -- one is inside the outer
 * per-branch catch, with no further catch of its own around this call --
 * so the whole method is wrapped, not just the load.
 */
export async function recordRebaseFailure(
  ctx: RebaseContext,
  branchPath: string,
  branchDir: string,
  message: string,
): Promise<void> {
  const RECORD_REFRESH_MS = 60 * 60 * 1000 // 1 hour

  // [REDACT] Defense-in-depth redaction: rebaseFailure.message is
  // persisted to branch.json and served to the browser via the
  // branch-health admin endpoint. Both call sites in rebaseActiveBranches
  // already redact before passing in (the failed.push sites below),
  // redactCredentials is idempotent, so redacting again here is free and
  // keeps this method safe on its own.
  const redactedMessage = redactCredentials(message)

  try {
    const existing = await BranchMetadataFileManager.loadOnly(branchPath)
    const prior = existing?.branch.rebaseFailure
    const sameMessage = prior?.message === redactedMessage

    const now = new Date()
    if (sameMessage) {
      const lastAtMs = Date.parse(prior.lastAt)
      if (!Number.isNaN(lastAtMs) && now.getTime() - lastAtMs < RECORD_REFRESH_MS) {
        // Same failure, refreshed within the last hour -- skip the save.
        return
      }
    }

    const nowIso = now.toISOString()
    const firstAt = sameMessage ? prior.firstAt : nowIso

    const meta = getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath)
    await meta.save({
      branch: {
        name: branchDir,
        rebaseFailure: { message: redactedMessage, firstAt, lastAt: nowIso },
      },
    })
  } catch (err) {
    // Includes BranchMetadataCorruptError from the load above (a save()
    // against the same corrupt file would just throw again) as well as
    // any other load/save failure -- recording is best-effort
    // observability, never allowed to abort the branch loop.
    workerLogWarn(`  Failed to record rebase failure for ${branchDir}: ${getErrorMessage(err)}`)
  }
}

/** Safety limit against a rebase that never converges. */
const MAX_REBASE_ROUNDS = 50

/** What {@link runRebaseRounds} observed. */
interface RebaseRoundsResult {
  /** Whether `git rebase` reached a finished state. */
  completed: boolean
  /**
   * Every conflicted path this loop resolved, across all rounds, in encounter
   * order and with duplicates. Mostly `checkout --theirs`, but MODIFY/DELETE
   * conflicts have no "their version" and are resolved by `git rm`/`git add`
   * instead -- those land here too.
   */
  conflictedFiles: string[]
  /**
   * Set ONLY on the "unexpected error" and "conflict resolution failed" exits.
   * MAX_REBASE_ROUNDS exhaustion is a distinct exit with no message of its own,
   * and the caller's warning text must not conflate the two.
   */
  failureReason?: string
}

/**
 * Drive `git rebase` to a finished state, resolving each conflict in favour of
 * the BRANCH's version, and report what happened.
 *
 * ABORT OWNERSHIP is split, and stating it as "the caller owns the abort"
 * would be wrong in a way that invites deleting a live abort as a duplicate:
 *
 * - The **unexpected-error** exit aborts HERE, itself, before breaking. The
 *   caller's `!completed` abort is then a caught no-op for that path.
 * - The **conflict-resolution-failure**, **MAX_REBASE_ROUNDS** and
 *   **lock-compromised** exits leave the rebase IN PROGRESS on purpose, and
 *   depend on the caller's `!completed` abort. Do not remove it.
 *
 * It can also THROW, from two places, and that is likewise covered rather than
 * prevented: `branchGit.status()` is the first statement of the round catch, so
 * a vanished `.git` or an EFS error escapes, as can the test hook beside it.
 * Such a throw unwinds to `rebaseOneBranch`'s outer catch, and the last-resort
 * abort in its `finally` is what stops the clone being left mid-rebase. That
 * `finally` is the backstop for exactly this, and is not dead code.
 *
 * What this function DOES guarantee is narrower: no per-file resolution failure
 * escapes it. `checkout --theirs` on a MODIFY/DELETE conflict used to throw
 * straight out of the round loop, skipping both abort sites and wedging the
 * clone forever; those now set `failureReason` and break instead.
 *
 * `isLockCompromised` is re-read every round rather than passed as a value:
 * [SYNC-C1] the content-write lock can be lost BETWEEN rounds, and
 * `--continue`/`--skip` are as destructive as the initial rebase.
 */
async function runRebaseRounds(
  ctx: Pick<RebaseContext, 'afterConflictDetectedForTesting'>,
  branchGit: SimpleGit,
  branchDir: string,
  fetchedBaseTip: string,
  isLockCompromised: () => boolean,
): Promise<RebaseRoundsResult> {
  // Resolve-and-continue loop: keep branch version for conflicting files, then continue
  // Non-conflicting files get main's changes; conflicting files keep branch version.
  const conflictedFiles: string[] = []
  let nextAction: 'start' | 'continue' | 'skip' = 'start'
  let completed = false
  // PR-W1: captured only on the "unexpected error" exit below, for the
  // failed-summary entry pushed at the `if (!completed)` check.
  let failureReason: string | undefined

  for (let round = 0; round < MAX_REBASE_ROUNDS && !completed; round++) {
    // Re-checked every round: the compromise can land between rounds,
    // and `--continue`/`--skip` are as destructive as the initial
    // rebase. Handled after the loop so it cannot be mistaken for the
    // `!completed` rebase-FAILURE path below.
    if (isLockCompromised()) break
    try {
      if (nextAction === 'start') {
        // The pinned base tip fetched above (single-branch clones have
        // no origin/<base> remote-tracking ref for other branches).
        await branchGit.rebase([fetchedBaseTip])
      } else if (nextAction === 'continue') {
        await branchGit.rebase(['--continue'])
      } else {
        await branchGit.rebase(['--skip'])
      }
      completed = true
    } catch (rebaseErr) {
      nextAction = 'continue'
      const st = await branchGit.status()

      if (st.conflicted.length > 0) {
        await ctx.afterConflictDetectedForTesting()
        // During rebase, --theirs = the branch being replayed (editor's work).
        // (git rebase reverses ours/theirs: "ours" is the rebase target, "theirs" is the branch.)
        //
        // MODIFY/DELETE conflicts have no "their version" to check out
        // and must be resolved by staging a delete or an add instead.
        // `git checkout --theirs` on one exits non-zero ("path ... does
        // not have their version") and simple-git throws -- and because
        // this loop body IS the round loop's catch, that throw escapes
        // the round loop entirely, skipping BOTH `rebase --abort` sites
        // below and leaving the clone wedged mid-rebase forever. The
        // index/working-tree code pair identifies which side deleted
        // (verified against real git, not inferred):
        //
        //   U/D  "deleted by them"  -- the BRANCH deleted it, base
        //        modified it. Git leaves base's version in the tree.
        //        Keep-branch-version means honouring the delete: git rm.
        //   D/U  "deleted by us"    -- base deleted it, the BRANCH
        //        modified it. Git leaves the branch's version in the
        //        tree. Keep-branch-version means keeping it: git add.
        //
        // Any per-file resolution that STILL fails routes into the
        // `!completed` path below (which aborts and records) instead of
        // escaping -- deliberately NOT a rethrow, since a throw from
        // here is exactly the bug being fixed.
        const conflictKind = new Map(st.files.map((f) => [f.path, `${f.index}${f.working_dir}`]))
        let resolutionFailure: string | undefined
        for (const file of st.conflicted) {
          const kind = conflictKind.get(file)
          try {
            if (kind === 'UD') {
              await branchGit.raw(['rm', '-f', '--', file])
            } else if (kind === 'DU') {
              await branchGit.add(file)
            } else {
              await branchGit.raw(['checkout', '--theirs', file])
              await branchGit.add(file)
            }
          } catch (resolveErr: unknown) {
            resolutionFailure =
              `failed to resolve conflicted file '${file}' (status ${kind ?? '??'}): ` +
              getErrorMessage(resolveErr)
            break
          }
          conflictedFiles.push(file)
        }
        if (resolutionFailure !== undefined) {
          // Same exit shape as the "unexpected error" branch below: set
          // failureReason and break, letting the `!completed` block do
          // the single `rebase --abort` and record the failure once.
          failureReason = resolutionFailure
          break
        }
        // nextAction stays 'continue'
      } else {
        const msg = rebaseErr instanceof Error ? rebaseErr.message : ''
        if (
          msg.toLowerCase().includes('nothing to commit') ||
          msg.toLowerCase().includes('apply --skip')
        ) {
          // Empty commit after --theirs resolution — skip it
          nextAction = 'skip'
        } else {
          // Unexpected error — abort and leave branch behind.
          // We intentionally don't update conflictStatus/conflictFiles here:
          // the rebase didn't complete so we can't determine the true conflict
          // state. Previous metadata (possibly stale) is preserved until the
          // next successful rebase cycle corrects it.
          workerLogWarn(`  Unexpected rebase error in ${branchDir}: ${msg || 'Unknown error'}`)
          failureReason = msg || 'Unknown error'
          await branchGit.rebase(['--abort']).catch(() => {})
          break
        }
      }
    }
  }

  return { completed, conflictedFiles, failureReason }
}

/**
 * Map the file paths a rebase resolved --theirs onto the ContentIds the editor
 * shows as conflicted, deduplicated.
 *
 * IDs rather than paths because they are immutable: a later slug rename must
 * not orphan a conflict marker. Paths that carry no recoverable ID are dropped
 * rather than guessed at.
 *
 * Pure -- the one piece of this loop that can be tested without a git repo.
 */
export function conflictFilesToContentIds(
  conflictedFiles: readonly string[],
  contentRoot: string,
): ContentId[] {
  // Convert file paths to ContentIds — immutable, survives slug renames.
  // Entry files have IDs in their filename (e.g., "post.slug.a1b2c3d4e5f6.mdx").
  // .collection.json files have no ID themselves (extractIdFromFilename returns null
  // for dot-prefixed files), so we extract the ID from the parent directory instead.
  // The root content directory (e.g., "content/", or "cms/content/" for a
  // multi-segment contentRoot) has no embedded ID, so we use ROOT_COLLECTION_ID
  // as a sentinel — but only for the configured contentRoot.
  //
  // Two different notions of "parent" are needed below, and conflating them
  // reproduces the exact bug this comparison guards against (see
  // schema-store.ts's contentRootName doc comment for the same shape elsewhere):
  //  - `parentDir` (a basename) recovers a SUB-collection's own embedded ID
  //    (e.g. "posts.cNbR5xFm2Kpd" -> "cNbR5xFm2Kpd") — correct as a basename,
  //    since a collection directory carries its ID in its own name, one path
  //    segment.
  //  - `parentPath` (the full relative parent path, normalized) is what must be
  //    compared against `contentRoot`, because `contentRoot` is documented
  //    (config/helpers.ts) as allowed to span multiple segments (e.g.
  //    "cms/content"). Comparing a basename ("content") against that full value
  //    is always false, which silently drops the root collection's conflict.
  //    Git reports POSIX-style paths and the configured value may be authored
  //    with either separator, so both sides go through normalizeFilesystemPath
  //    before comparing.
  const normalizedContentRoot = normalizeFilesystemPath(contentRoot)
  const conflictIds = [...new Set(conflictedFiles)]
    .map((f) => {
      const fileId = extractIdFromFilename(path.basename(f))
      if (fileId) return fileId
      const parentDir = path.basename(path.dirname(f))
      const dirId = extractIdFromFilename(parentDir)
      if (dirId) return dirId
      // Only assign ROOT_COLLECTION_ID when the file's parent directory IS the
      // configured content root. Other unrecognized paths are filtered out.
      const parentPath = normalizeFilesystemPath(path.dirname(f))
      if (path.basename(f) === '.collection.json' && parentPath === normalizedContentRoot) {
        return ROOT_COLLECTION_ID
      }
      return null
    })
    .filter((id): id is ContentId => id !== null)
  return [...new Set(conflictIds)]
}

/**
 * [SYNC-H1] Carry a just-rebased history forward into `remote.git`, and queue
 * the GitHub hop.
 *
 * Only runs when the branch's pre-rebase history had ALREADY been published
 * (`publishedSha !== null`); otherwise nothing downstream knows about the
 * commits the rebase replaced and there is nothing to reconcile. Without this,
 * the editor's next submit is simply rejected non-fast-forward forever.
 *
 * `preRebaseHead` and `publishedSha` must both be read BEFORE the rebase --
 * the clone's pre-rebase tip is exactly what the rebase destroys.
 */
async function carryForwardRewrittenHistory(
  ctx: RebaseContext,
  args: {
    branchPath: string
    branchDir: string
    branchRef: string
    publishedSha: string | null
    preRebaseHead: string
  },
): Promise<void> {
  const { branchPath, branchDir, branchRef, publishedSha, preRebaseHead } = args
  // [SYNC-H1] The rebase just rewrote this clone's history. If that
  // history was already published, nothing else will ever reconcile
  // remote.git (and GitHub) with it -- the editor's next submit would
  // simply be rejected non-fast-forward. Carry the rewrite forward.
  if (publishedSha !== null) {
    if (publishedSha === preRebaseHead) {
      // ARMING GUARD. remote.git holds EXACTLY what this clone just
      // rebased away and nothing more, so a lease keyed to it can only
      // undo our own rewrite.
      //
      // The inequality case below is not defensive padding: branch
      // clones never fetch their own branch (GitManager's clone is
      // --single-branch and checkoutBranch only checks out an existing
      // local branch), while reconcileTrackedBranches fast-forwards
      // remote.git to GitHub's tip. So after a reviewer pushes a fixup
      // straight to the PR branch, remote.git legitimately holds a
      // commit this clone has never seen. Leasing on "whatever
      // remote.git currently holds" would be SATISFIED there and would
      // delete that fixup from remote.git and then from GitHub,
      // silently. Keying the lease to the pre-rebase tip turns that
      // case into the visible divergence it should be.
      //
      // Order matters: mark, then push, then queue. A crash after any
      // step leaves the marker set with the work unfinished, which
      // reconcilePendingRewrite() completes on a later cycle. Pushing
      // first would leave remote.git rewritten, GitHub stale and
      // nothing recorded -- unrecoverable, and landing on exactly the
      // false "another deployment" diagnosis this change removes.
      await markHistoryRewritten(ctx, branchPath, branchDir, publishedSha)
      if (await forcePublishToLocalRemote(ctx, branchPath, branchRef, publishedSha)) {
        await enqueueGitHubPush(ctx, branchRef)
      }
    } else {
      const divergence =
        `rebased locally, but remote.git holds ${publishedSha} for ${branchRef}, which this ` +
        `clone never had (a direct push to the branch?). Left untouched -- reconcile it ` +
        `before submitting again.`
      workerLogWarn(`  ${branchDir}: ${divergence}`)
      await recordRebaseFailure(ctx, branchPath, branchDir, divergence)
    }
  }
}

/**
 * What one branch contributed to the cycle summary -- the return type that
 * replaced `continue` when the per-branch body moved into
 * {@link rebaseOneBranch}.
 *
 * The original loop expressed this by pushing to one of four arrays in scope
 * and then `continue`-ing; there were nine such exits and each pushed to a
 * different array (or to none), which is exactly the sort of thing that is
 * easy to get wrong when the body is 640 lines long. Making it a return value
 * means the compiler checks that every path produces one.
 */
export type BranchRebaseOutcome =
  /** Nothing to do: a skipped status, or already up to date. Not reported. */
  | { kind: 'none' }
  /** Was behind and completed a rebase, with or without conflict resolution. */
  | { kind: 'rebased' }
  /** Working tree had uncommitted changes. Retried next cycle. */
  | { kind: 'skippedDirty' }
  /** [SYNC-C1] Content-write lock busy or lost mid-rebase. Retried next cycle. */
  | { kind: 'skippedLocked' }
  | {
      kind: 'failed'
      error: string
      /**
       * True when the rebase itself COMPLETED and the branch was already
       * counted as rebased before the failure. Only reachable from the
       * [SYNC-H1] carry-forward block, which is the sole code that runs after
       * that point and can still throw (via markHistoryRewritten's metadata
       * save).
       *
       * Not a tidying-up detail: the original loop pushed to `rebased` and
       * THEN to `failed` in that interleaving, so the branch appeared in both
       * buckets -- and it genuinely is both, because its history moved and
       * publishing the move failed. Collapsing it to `failed` alone would drop
       * a real rebase from worker-status.json.
       */
      rebased?: boolean
    }

/**
 * Rebase every branch workspace that is behind the base branch, one cycle.
 *
 * The per-branch work is {@link rebaseOneBranch}; what stays here is the walk
 * over `content-branches/`, the structural pre-filter (entries that are not
 * branch workspaces at all, plus the base branch's own clone), and folding
 * each branch's outcome into the summary.
 *
 * Deliberately sequential rather than concurrent: each branch's rebase holds
 * that branch's cross-host content-write lock and runs a series of git
 * subprocesses against a shared filesystem.
 */
export async function runRebaseCycle(ctx: RebaseContext): Promise<RebaseSummary> {
  // PR-W1: collected across the loop below and returned as a summary
  // (folded into worker-status.json by syncGit()). Purely additive
  // bookkeeping -- doesn't change any control flow or existing logging.
  const rebased: string[] = []
  const skippedDirty: string[] = []
  const skippedLocked: string[] = []
  const failed: { branch: string; error: string }[] = []

  let branchDirs: string[]
  try {
    branchDirs = await fs.readdir(ctx.contentBranchesPath)
  } catch {
    return { rebased, skippedDirty, skippedLocked, failed }
  }

  for (const branchDir of branchDirs) {
    // Known structural entries under content-branches/, not branch
    // workspaces: branches.json (registry snapshot) and dot-prefixed
    // entries (.canopy-meta/, transient lock dirs). Skip them silently so
    // the no-.git skip logs below don't fire for them every cycle.
    // Everything else still logs loudly on skip.
    if (branchDir.startsWith('.') || branchDir === 'branches.json') {
      continue
    }

    const branchPath = path.join(ctx.contentBranchesPath, branchDir)
    const gitDir = path.join(branchPath, '.git')

    try {
      const stat = await fs.stat(gitDir)
      if (!stat.isDirectory()) {
        workerLog(`  Skipping ${branchDir}: .git is not a directory`)
        continue
      }
    } catch {
      workerLog(`  Skipping ${branchDir}: no .git directory (not a branch workspace)`)
      continue
    }

    // The base branch's own clone is refreshed ff-only by
    // refreshBaseBranchWorkspace() earlier in syncGit(). Routing it
    // through this conflict-resolution rebase loop could rewrite its
    // history (the --theirs loop below) and stamp meaningless conflict
    // metadata on it. Compare sanitized-vs-sanitized: branchDir is a
    // filesystem name (already sanitized), ctx.baseBranch is raw.
    if (branchDir === ctx.sanitizedBaseBranch) {
      workerLog(`  Skipping ${branchDir}: base branch (refreshed separately)`)
      continue
    }
    const outcome = await rebaseOneBranch(ctx, branchDir, branchPath)
    if (outcome.kind === 'rebased') rebased.push(branchDir)
    else if (outcome.kind === 'skippedDirty') skippedDirty.push(branchDir)
    else if (outcome.kind === 'skippedLocked') skippedLocked.push(branchDir)
    else if (outcome.kind === 'failed') {
      // A branch can legitimately land in BOTH buckets -- see the `rebased`
      // rider on BranchRebaseOutcome.
      if (outcome.rebased) rebased.push(branchDir)
      failed.push({ branch: branchDir, error: outcome.error })
    }
  }

  return { rebased, skippedDirty, skippedLocked, failed }
}

/**
 * Rebase ONE branch workspace onto the base branch, keeping the branch's
 * version of every conflicting file.
 *
 * `branchDir` is the sanitized directory name and `branchPath` its absolute
 * path; the caller has already established that this is a real branch
 * workspace and not the base branch's own clone.
 *
 * Never throws: every failure is caught, recorded on branch metadata and
 * returned as `{ kind: 'failed' }`, so one unreadable branch cannot halt the
 * rest of the cycle ([SYNC-M2]).
 */
async function rebaseOneBranch(
  ctx: RebaseContext,
  branchDir: string,
  branchPath: string,
): Promise<BranchRebaseOutcome> {
  // Set where the original loop pushed to `rebased[]`, and read only by the
  // catch below. See the `rebased` rider on BranchRebaseOutcome.
  let didRebase = false

  try {
    // Load metadata before any git ops to check branch status
    const metaFile = await BranchMetadataFileManager.loadOnly(branchPath)
    const branchStatus = metaFile?.branch.status

    // Skip branches that shouldn't be mutated:
    // - submitted/approved: in review, don't rewrite history under an
    //   active PR -- but do poll GitHub for the PR's resolution, since
    //   nothing else tells the worker a merge/close happened.
    // - archived: already merged, no reason to rebase and no PR left to
    //   poll (avoid the wasted API call).
    if (branchStatus === 'submitted' || branchStatus === 'approved') {
      workerLog(`  Skipping ${branchDir} (${branchStatus})`)
      await pollMergeState(ctx, branchDir, branchPath, metaFile)
      return { kind: 'none' }
    }
    if (branchStatus === 'archived') {
      workerLog(`  Skipping ${branchDir} (${branchStatus})`)
      return { kind: 'none' }
    }

    const branchGit = simpleGit({
      baseDir: branchPath,
      // Keep git non-interactive during rebase/merge so it never blocks on an editor.
      // simple-git >=3.32 blocks setting core.editor unless explicitly opted in; the
      // value here is a hardcoded literal ("true", the shell no-op), not user input,
      // so enabling allowUnsafeEditor carries no injection risk.
      config: ['core.editor=true'],
      unsafe: { allowUnsafeEditor: true },
    })

    // [SYNC-C1] Take the branch's cross-host content-write lock BEFORE the
    // dirty check, and hold it for the whole rebase.
    //
    // The dirty check alone is check-then-act. The old comment here claimed
    // the residual window was safe ("the rebase will fail and the catch
    // block will abort safely"), which only holds for a save landing before
    // `git rebase` STARTS. After that -- a window spanning fetch, replay and
    // N conflict rounds of awaited git subprocesses on EFS -- a save is
    // destroyed two ways: `checkout --theirs` below overwrites the
    // just-saved file with the branch's committed version and the rebase
    // then SUCCEEDS (nothing logs a failure at all), and `rebase --abort`
    // hard-resets the tree. The editor already got its 200 either way.
    //
    // Zero-retry acquisition, deliberately: on contention this branch is
    // skipped and retried on the next sync cycle (~5 min), which is the
    // same principle as the skip-dirty-branches behavior below. Writers get
    // the patient side of the asymmetry -- see utils/content-write-lock.ts.
    //
    // The heartbeat that keeps this lock fresh (proper-lockfile refreshes
    // every `stale`/2 = 15s) is a timer on this event loop; every git step
    // below is an awaited subprocess, never a synchronous block, so the
    // refresh keeps firing for the whole hold.
    let releaseContentLock: (() => Promise<void>) | undefined
    // [SYNC-C1] If the lock is lost mid-hold, a writer may now be live
    // against this same tree. Every git step below is destructive, so
    // record it and bail before the next one rather than replaying over
    // an editor's concurrent save.
    let contentLockCompromised = false
    try {
      releaseContentLock = await tryAcquireContentWriteLock(branchPath, (lockErr) => {
        contentLockCompromised = true
        workerLogWarn(
          `  Content-write lock compromised mid-rebase for ${branchDir}: ${getErrorMessage(lockErr)}`,
        )
      })
    } catch (lockErr: unknown) {
      if (isNodeError(lockErr) && lockErr.code === 'ELOCKED') {
        workerLog(`  Skipping ${branchDir}: content write in progress (retrying next cycle)`)
        return { kind: 'skippedLocked' }
      }
      // Anything else (ENOENT on a branch dir deleted mid-cycle, EACCES,
      // ...) is a real failure: let the outer catch record it.
      throw lockErr
    }

    try {
      // Recover an INTERRUPTED rebase before anything else looks at this
      // tree. A clone left with .git/rebase-merge (or rebase-apply) reports
      // uncommitted changes, so without this the dirty check below would
      // classify it `skippedDirty` on every cycle FOREVER while
      // branch-health scanned it as healthy -- and editors would meanwhile
      // read, and be able to save over, conflict-marker content.
      //
      // An in-progress rebase is always this worker's own abandoned work:
      // it is the only thing that ever rebases these clones, and it got
      // here via a crash, an OOM, a spot interruption, or the ASG rolling
      // the instance (which happens on EVERY `cdk deploy`, while `stop()`
      // drains for at most taskTimeoutMs).
      //
      // NOT LOSSLESS, and it is important not to claim otherwise. `git
      // rebase --abort` hard-resets tracked files to the pre-rebase head.
      // While the worker was DOWN nothing held the [SYNC-C1] content-write
      // lock, so an editor could have saved into this wedged clone and
      // received a 200; that save is a working-tree modification, and the
      // abort reverts it. (New, untracked entry files survive; edits to
      // existing ones do not.) Taking the lock here stops any FURTHER save
      // racing the abort, but cannot recover one that already landed.
      //
      // Aborting anyway is still the right call: the alternative is a
      // branch wedged forever whose tree serves conflict-marker content to
      // editors. What must not happen is doing it SILENTLY -- so anything
      // modified beyond the rebase's own conflict state is logged by path
      // first, which is the only record an operator would have.
      if (await isRebaseInProgress(branchPath)) {
        const preAbort = await branchGit.status().catch(() => null)
        // Keyed on the WORKING-TREE column only. The two porcelain columns
        // mean different things here, and conflating them produces a false
        // data-loss report on essentially every conflict-wedged recovery
        // (verified against real git, mid-rebase):
        //
        //   `M ` index=M, wd=' '  -- the interrupted replay's own cleanly
        //                            merged files, already STAGED. These
        //                            are committed history and survive the
        //                            abort untouched. Not collateral.
        //   ` M` index=' ', wd=M  -- a working-tree modification nothing
        //                            staged: an editor's save landing while
        //                            the worker was down. The abort
        //                            discards exactly these.
        //   `??`                  -- untracked; the abort leaves them.
        //
        // KNOWN GAP, stated rather than hidden: a save onto one of the
        // rebase's own conflicted paths (the "saved over conflict-marker
        // content" case) is excluded below, because the file reads `UU`
        // whether or not an editor touched it -- status alone cannot tell
        // the two apart. Those discards go unlogged.
        const collateral = (preAbort?.files ?? [])
          .filter((f) => !preAbort?.conflicted.includes(f.path))
          .filter((f) => f.working_dir !== ' ' && f.working_dir !== '?')
          .map((f) => f.path)
        if (collateral.length > 0) {
          workerLogWarn(
            `  ${branchDir}: aborting the interrupted rebase will DISCARD working-tree changes to ` +
              `${collateral.length} file(s) saved while the worker was down: ${collateral.join(', ')}`,
          )
        }
        workerLogWarn(
          `  ${branchDir}: found an interrupted rebase (this worker's own abandoned work) -- aborting it to recover the branch`,
        )
        try {
          await branchGit.rebase(['--abort'])
        } catch (abortErr: unknown) {
          // Leave it for the next cycle rather than pressing on: every step
          // below assumes a clean tree.
          const reason = redactCredentials(
            `could not abort interrupted rebase: ${getErrorMessage(abortErr)}`,
          )
          workerLogWarn(`  Skipping ${branchDir}: ${reason}`)
          // Record on branch metadata too, like the other two failure exits
          // (`!completed` and the outer catch). Without this a persistently
          // un-abortable wedge appeared in worker-status.json but never set
          // a `syncFailureReason`, so the admin branch panel showed nothing
          // -- and this is precisely the state that needs an operator,
          // since it is the one the next cycle cannot fix by itself.
          await recordRebaseFailure(ctx, branchPath, branchDir, reason)
          return { kind: 'failed', error: reason }
        }
      }

      // Skip dirty branches — editor has unsaved changes that can't be rebased.
      // Now inside the lock, so no write can land between this check and the
      // rebase below.
      const dirtyCheck = await branchGit.status()
      if (dirtyCheck.files.length > 0) {
        workerLog(`  Skipping ${branchDir}: has uncommitted changes`)
        return { kind: 'skippedDirty' }
      }

      // The clone's own ref name: branchDir is the sanitized DIRECTORY
      // name and need not match it. A literal 'HEAD' means a detached
      // clone (e.g. a crashed rebase left one behind) -- nothing below can
      // safely name a ref then, so every publish path stays disarmed,
      // which is the safe direction.
      const branchRef = (await branchGit.revparse(['--abbrev-ref', 'HEAD'])).trim()
      const canPublish = branchRef.length > 0 && branchRef !== 'HEAD'

      // [SYNC-H1] Self-heal: finish an interrupted publish even when this
      // branch is not behind base. Every crash window in the arming
      // sequence below leaves the marker set with the work unfinished, and
      // this is what completes it -- without it, one lost lease race would
      // strand the branch until the base branch happened to advance again.
      // Gated on the loop-top snapshot, so unmarked branches (nearly all
      // of them, every cycle) cost nothing extra.
      if (canPublish && metaFile?.branch.historyRewrittenFrom) {
        await reconcilePendingRewrite(ctx, {
          branchPath,
          branchDir,
          branchRef,
          headSha: (await branchGit.revparse(['HEAD'])).trim(),
          marker: metaFile.branch.historyRewrittenFrom,
        })
      }

      await branchGit.fetch('origin', ctx.baseBranch)

      // Use rev-list instead of status.behind — status.behind only works when the
      // branch has an upstream tracking branch configured, which isn't guaranteed
      // (checkoutBranch fallback paths create branches without --track).
      // The just-fetched tip, not origin/<base>: branch clones are
      // --single-branch, so no remote-tracking ref exists for a base branch
      // other than the one they were cloned from (see the base-refresh
      // comment above). Pinned to a SHA immediately — FETCH_HEAD is one
      // shared mutable file per repo, repointed by any concurrent fetch.
      const fetchedBaseTip = (await branchGit.revparse(['FETCH_HEAD'])).trim()
      const behindCount = parseInt(
        (await branchGit.raw(['rev-list', '--count', `HEAD..${fetchedBaseTip}`])).trim(),
        10,
      )
      const meta = getBranchMetadataFileManager(branchPath, ctx.contentBranchesPath)

      if (behindCount === 0) {
        // Already in sync. This is the overwhelmingly common outcome per
        // branch per cycle (most branches are caught up most of the
        // time), so skip the save entirely when metadata already reflects
        // a clean state -- every save() now eager-regenerates the branch
        // registry (branch-metadata.ts's invalidateRegistry(), O(branch
        // count) fs reads on EFS), so an unconditional save here turns
        // every rebase cycle into O(N^2) registry work across N branches
        // for what is otherwise a true no-op. Re-load fresh (not the
        // `metaFile` snapshot from before the fetch/rev-list above) so a
        // concurrent editor-driven metadata change during that window
        // isn't clobbered by a stale skip decision.
        const currentMeta = await BranchMetadataFileManager.loadOnly(branchPath)
        const conflictStatus = currentMeta?.branch.conflictStatus
        const conflictFiles = currentMeta?.branch.conflictFiles
        const conflictAlreadyClean =
          (conflictStatus === undefined || conflictStatus === 'clean') &&
          (conflictFiles === undefined || conflictFiles.length === 0)
        // PR-W2: a lingering rebaseFailure must also be cleared once the
        // branch catches up clean -- otherwise it sticks as a stale
        // warning forever (nothing else touches this branch once it's
        // caught up, so no other save site would ever clear it).
        const alreadyClean = conflictAlreadyClean && currentMeta?.branch.rebaseFailure === undefined
        if (alreadyClean) {
          return { kind: 'none' }
        }
        await meta.save({
          branch: {
            name: branchDir,
            conflictStatus: 'clean',
            conflictFiles: [],
            rebaseFailure: undefined,
          },
        })
        return { kind: 'none' }
      }

      workerLog(`Rebasing ${branchDir} (${behindCount} commits behind)...`)

      // Read BOTH sides before rewriting anything: the arming guard after
      // the rebase compares what remote.git published against what this
      // clone is about to rebase away. Reading them afterwards would be
      // useless -- the clone's pre-rebase tip is exactly what disappears.
      const preRebaseHead = (await branchGit.revparse(['HEAD'])).trim()
      const publishedSha = canPublish ? await readPublishedSha(ctx, branchRef) : null

      const { completed, conflictedFiles, failureReason } = await runRebaseRounds(
        ctx,
        branchGit,
        branchDir,
        fetchedBaseTip,
        () => contentLockCompromised,
      )

      // Outside the round loop's try/catch, so a throwing test hook can
      // never be misread as a rebase error.
      if (completed) await ctx.afterRebaseCompletedForTesting()

      // [SYNC-C1] A lost lock is a RETRY, not a rebase failure: nothing is
      // wrong with the branch, we simply can no longer prove we were the
      // only writer. Handled ahead of the `!completed` block so it never
      // records a user-visible rebaseFailure or lands in `failed[]`.
      //
      // ONLY when the rebase did not complete. Bailing out of a COMPLETED
      // rebase would be worse than useless: the history is already
      // rewritten (so `--abort` is a no-op), and skipping the completion
      // path below strands three things the next cycle will never redo,
      // because a caught-up branch short-circuits at the `behindCount === 0`
      // check above -- the [SYNC-H1] `markHistoryRewritten` marker (without
      // which the editor's next submit is rejected non-fast-forward and
      // mis-diagnosed as another deployment), the content-cache
      // invalidation for a tree that DID change, and the conflictStatus
      // save. That converts a transient lock compromise into a permanently
      // wedged published branch.
      //
      // Nor does bailing protect a racing save: a rebase replays COMMITTED
      // history, while a concurrent save is uncommitted working-tree state,
      // and that writer is already told to retry via
      // ContentWriteLockBusyError. So when the rebase completed, log the
      // lost exclusivity loudly and finish the job.
      if (contentLockCompromised && !completed) {
        workerLogWarn(
          `  Skipping ${branchDir}: content-write lock was compromised mid-rebase (retrying next cycle)`,
        )
        // No-op when no rebase is in progress; failure is expected there.
        await branchGit.rebase(['--abort']).catch(() => {})
        return { kind: 'skippedLocked' }
      }
      if (contentLockCompromised) {
        workerLogWarn(
          `  Content-write lock for ${branchDir} was compromised, but its rebase had already completed -- finishing the sync (history is rewritten; skipping now would strand the history-rewrite marker and wedge the branch)`,
        )
      }

      if (!completed) {
        // PR-W2 (M1 rider): failureReason is only set on the "unexpected
        // error" break above -- MAX_REBASE_ROUNDS exhaustion is a distinct exit
        // path with no error message of its own, so the warn text must
        // not conflate the two.
        workerLogWarn(
          failureReason !== undefined
            ? `  Rebase of ${branchDir} aborted due to unexpected error: ${failureReason}`
            : `  Rebase of ${branchDir} did not complete within ${MAX_REBASE_ROUNDS} rounds, aborting`,
        )
        await branchGit.rebase(['--abort']).catch(() => {})
        const rebaseFailureMessage =
          failureReason ?? `did not complete within ${MAX_REBASE_ROUNDS} rounds`
        // [REDACT] failed[] folds into worker-status.json's
        // lastGitSync.failed, served to the browser -- failureReason can
        // be an arbitrary git error message that embeds the bot token.
        const redactedRebaseFailureMessage = redactCredentials(rebaseFailureMessage)
        // PR-W2: record once here for the "!completed" exit -- the
        // unexpected-error break above is NOT disjoint from this block (it
        // always falls through here), so recording at the break itself
        // would double-record. The outer catch below is the only other
        // record site (a distinct, non-overlapping failure class: errors
        // outside this round loop, e.g. fetch/rev-list failures).
        await recordRebaseFailure(ctx, branchPath, branchDir, redactedRebaseFailureMessage)
        return { kind: 'failed', error: redactedRebaseFailureMessage }
      }

      // The rebase rewrote the branch clone's working tree — mark ContentStore
      // ID indexes rooted here stale so lookups rebuild from disk, in this
      // process and (via the on-disk generation marker) in the Lambda
      // containers sharing this filesystem.
      await invalidateBranchContentCaches(branchPath)

      const conflictIdsDeduped = conflictFilesToContentIds(conflictedFiles, ctx.contentRoot)

      const hadConflicts = conflictIdsDeduped.length > 0
      workerLog(
        hadConflicts
          ? `  Rebased ${branchDir} (kept branch version for ${conflictIdsDeduped.length} conflicting file(s))`
          : `  Rebased ${branchDir} successfully`,
      )
      await meta.save({
        branch: {
          name: branchDir,
          conflictStatus: hadConflicts ? 'conflicts-detected' : 'clean',
          conflictFiles: conflictIdsDeduped,
          // PR-W2: the cycle completed successfully -- clear any prior
          // failure record regardless of conflict outcome.
          rebaseFailure: undefined,
        },
      })
      // PR-W1: the branch was behind and the rebase completed (with or
      // without --theirs conflict resolution) -- it moved, so it belongs
      // in the summary. Branches already up to date `continue`d above and
      // are deliberately not listed here.
      didRebase = true

      await carryForwardRewrittenHistory(ctx, {
        branchPath,
        branchDir,
        branchRef,
        publishedSha,
        preRebaseHead,
      })

      return { kind: 'rebased' }
    } finally {
      // Last-resort guarantee that NO exit path leaves this clone
      // mid-rebase -- including an unexpected throw from any git step
      // above, which lands in the outer catch and previously only logged.
      //
      // It must live HERE rather than in that outer catch: the catch runs
      // AFTER this finally has released the content-write lock, so aborting
      // there would hard-reset a working tree an editor's save could
      // already be racing -- precisely the [SYNC-C1] hazard the lock
      // exists to prevent. Inside the finally the lock is still held --
      // EXCEPT on the narrow path where it was compromised mid-hold, in
      // which case a newly-admitted writer may already be live and this
      // abort carries the same exposure as the compromise path's own abort
      // above. Not special-cased: leaving a clone wedged mid-rebase is the
      // worse outcome, and the writer in that window is already being told
      // to retry.
      //
      // Guarded on actual rebase state so the happy path and the `continue`
      // exits cost one stat and do nothing.
      try {
        if (await isRebaseInProgress(branchPath)) {
          workerLogWarn(
            `  ${branchDir}: rebase still in progress on exit -- aborting so the clone is not left wedged`,
          )
          await branchGit.rebase(['--abort'])
        }
      } catch (abortErr: unknown) {
        // Best effort: the next cycle's recovery check retries this.
        workerLogWarn(
          `  Failed to abort in-progress rebase for ${branchDir}: ${getErrorMessage(abortErr)}`,
        )
      }

      // [SYNC-C1] Released on EVERY exit -- the `continue`s above, a throw
      // into the outer catch, and the happy path alike. A stranded lock
      // would wedge every write to this branch until it went stale.
      await releaseContentLock?.().catch((releaseErr: unknown) => {
        workerLogWarn(
          `  Failed to release content-write lock for ${branchDir}: ${getErrorMessage(releaseErr)}`,
        )
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    workerLogWarn(`  Failed to sync ${branchDir}: ${message}`)
    // [REDACT] Same rationale as the `if (!completed)` push site above --
    // this catches fetch/rev-list/unexpected errors, whose message can
    // embed the bot token.
    const redactedMessage = redactCredentials(message)
    // PR-W2: second (and only other) record site -- see the comment at
    // the `if (!completed)` block above for why these two sites are
    // disjoint.
    await recordRebaseFailure(ctx, branchPath, branchDir, redactedMessage)
    return { kind: 'failed', error: redactedMessage, rebased: didRebase }
  }
}
