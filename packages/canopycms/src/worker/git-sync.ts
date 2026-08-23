import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { invalidateBranchContentCaches } from '../content-index-generation'
import { GITHUB_TRACKING_REF_PREFIX, gitNetworkChildEnv } from '../git-manager'
import { RESERVED_SETTINGS_BRANCH_PREFIX } from '../paths/branch-name'
import { getErrorMessage, isNodeError, redactCredentials } from '../utils/error'
import { isNonFastForwardRejection } from '../utils/git'
import { hasPendingHistoryRewrite } from './history-rewrite'
import { runRebaseCycle, type RebaseContext } from './rebase'
import { cleanupOldTasks } from './task-queue'
import { writeWorkerStatus } from './worker-status'
import { workerLog, workerLogError, workerLogWarn } from './log'
import type { WorkerContext } from './worker-context'

/**
 * The git-sync cluster: everything reachable from `CmsWorker.syncGit()`, the
 * slower of the worker's two poll loops (default 5 minutes, against the task
 * queue's 5 seconds).
 *
 * One cycle, in order: fetch every GitHub branch into the tracking namespace,
 * bring `refs/heads/*` toward it non-destructively (`reconcileTrackedBranches`),
 * push this deployment's own settings branch, fast-forward the base branch's
 * workspace, rebase every branch that is behind it (rebase.ts), then sweep old
 * tasks and expired trashed branch directories.
 *
 * The ordering is deliberate but only ONE step still depends on it -- see
 * syncGit's own comments. What matters more is that the whole cycle is wrapped
 * so both outcomes record a worker-status.json snapshot, since an operator's
 * only view of this loop is the admin panel.
 */
export type GitSyncContext = Pick<
  WorkerContext,
  | 'baseBranch'
  | 'sanitizedBaseBranch'
  | 'contentBranchesPath'
  | 'remoteGitPath'
  | 'taskDir'
  | 'taskTimeoutMs'
  | 'log'
  | 'buildGitHubUrl'
  | 'ensureSettingsBranch'
  | 'ensureStatusReport'
  | 'isRunning'
> &
  // syncGit hands its own context straight to runRebaseCycle, so the rebase
  // loop's own requirements are part of this cluster's surface.
  RebaseContext

/**
 * [C1] Retention window for `.trash-*` branch directories left behind by the
 * admin purge action (api/admin-branch-health.ts). Matches
 * cleanupOldTasks's default task retention for consistency.
 */
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60_000

/** Matches `.trash-{dirName}-{STAMP}` names, capturing the trailing stamp. */
const TRASH_DIR_STAMP_RE = /-(\d{8}T\d{6}Z)$/

/**
 * Parse a purge-generated `YYYYMMDDTHHMMSSZ` stamp into a Date, or null if
 * malformed. Age comes ONLY from this name-embedded stamp, never the dir's
 * own mtime -- `fs.rename` preserves the original directory's mtime, so an
 * mtime-based retention check would delete a months-stale orphan's trash on
 * the very first cleanup pass after purge.
 */
function parseTrashStamp(stamp: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Per-cycle outcome of `reconcileTrackedBranches()` -- the non-destructive
 * replacement for the old `+refs/heads/*:refs/heads/*` fetch refspec (see
 * `GITHUB_TRACKING_REF_PREFIX`'s doc comment for the bug this fixes). Folded
 * by `syncGit()` into the worker's self-reported status
 * (`WorkerStatusReport.lastGitSync.tracked`, see worker-status.ts).
 */
export interface TrackedBranchSummary {
  /** GitHub branches with no corresponding local `refs/heads/<name>` yet -- created at GitHub's tip. */
  created: string[]
  /** Local heads that were strict ancestors of GitHub's tip -- fast-forwarded to it. */
  fastForwarded: string[]
  /**
   * Local heads AHEAD of GitHub's tip -- unpushed editor/settings work.
   * Deliberately left untouched; this is exactly what the old refspec used
   * to force-rewind or (with --prune) delete outright.
   */
  ahead: string[]
  /**
   * Local heads that diverged from GitHub's tip (neither side is an
   * ancestor of the other) -- left untouched and logged. A real collision
   * (e.g. another deployment moved the same branch name); the next push
   * attempt will be rejected non-fast-forward, which is the correct,
   * visible outcome.
   */
  diverged: string[]
  /**
   * Local heads that diverged from GitHub's tip because THIS worker's rebase
   * loop rewrote them and published the rewrite into `remote.git`, with the
   * GitHub push still outstanding (`BranchMetadata.historyRewrittenFrom` is
   * set). Structurally identical to `diverged` at the ref level, but a known,
   * self-resolving state rather than a cross-deployment collision -- kept in
   * its own bucket so the collision warning stays meaningful.
   */
  rewritten: string[]
}

/**
 * Push THIS deployment's own settings branch (`ensureSettingsBranch()`) from
 * remote.git to GitHub. Non-fatal: a no-op push for an up-to-date branch
 * just succeeds quietly.
 *
 * Deliberately narrowed to one branch — this used to push EVERY local
 * branch matching `canopycms-settings-*`. With the tracking-namespace fetch
 * fix (GITHUB_TRACKING_REF_PREFIX), `reconcileTrackedBranches` creates local
 * heads for branches that exist on GitHub, so ANOTHER deployment's settings
 * branch (sharing this same GitHub repo) can legitimately show up as a
 * local head here too. Pushing it would be this deployment shipping
 * settings state it doesn't own.
 */
export async function pushSettingsBranches(
  ctx: GitSyncContext,
  git: ReturnType<typeof simpleGit>,
  trackedNames: ReadonlySet<string>,
): Promise<void> {
  try {
    // Resolved once here rather than at each use below: ensureSettingsBranch()
    // is idempotent, but a local reads better and keeps the eight references
    // in this method obviously talking about one value.
    const settingsBranch = ctx.ensureSettingsBranch()
    const branches = await git.branch()
    const settingsBranches = branches.all.filter((b) =>
      b.startsWith(RESERVED_SETTINGS_BRANCH_PREFIX),
    )
    const foreign = settingsBranches.filter((b) => b !== settingsBranch)
    if (foreign.length > 0) {
      // Signal, not an error: this is exactly the "two deployments, one repo"
      // condition this workstream exists to make visible. Never push these.
      workerLogWarn(
        `Found settings branch(es) not owned by this deployment (${settingsBranch}): ` +
          `${foreign.join(', ')}. Another CanopyCMS deployment may share this GitHub repo. Not pushing them.`,
      )
    }

    // Check the full branch list, not the `canopycms-settings-*` subset: an
    // adopter-supplied `settingsBranch` override need not carry that prefix.
    const ownBranchMissing = !branches.all.includes(settingsBranch)

    // [SYNC-M3] A settings branch present in remote.git but absent from
    // GitHub's tracking refs was pushed here LOCALLY -- only this
    // deployment's own API can write to remote.git -- and has never
    // reached GitHub. That is the discriminating signature: in the
    // SUPPORTED two-deployments-one-repo case the foreign branch arrives
    // through the GitHub fetch and therefore always has a tracking ref, so
    // the warn above cannot tell the two apart on its own and a
    // "owned-branch-absent" test alone would fire on every deployment that
    // simply has not had a settings edit yet.
    //
    // With this deployment's own branch also missing, the API and this
    // worker have resolved different deploymentNames, and every settings
    // change the API commits is stranded in remote.git forever.
    const strandedLocal = foreign.filter((b) => !trackedNames.has(b))
    if (strandedLocal.length > 0) {
      workerLogWarn(
        ownBranchMissing
          ? `Settings branch mismatch: this worker owns "${settingsBranch}", which does not ` +
              `exist in remote.git, while ${strandedLocal.join(', ')} exist(s) here and has never ` +
              `been pushed to GitHub. The API and this worker disagree about deploymentName, so ` +
              `settings changes are NOT reaching GitHub. Set CANOPYCMS_DEPLOYMENT_NAME (or ` +
              `settingsBranch) on this worker to match what the API resolves.`
          : `Settings branch(es) ${strandedLocal.join(', ')} exist in remote.git but not on ` +
              `GitHub, and are not owned by this deployment (${settingsBranch}) -- nothing ` +
              `will ever push them onward. Check that deploymentName matches across this ` +
              `deployment's API and worker.`,
      )
    }

    if (ownBranchMissing) {
      // Not created locally yet — nothing to push.
      return
    }

    try {
      await git.push(ctx.buildGitHubUrl(), settingsBranch)
      workerLog(`Pushed settings branch ${settingsBranch} to GitHub`)
    } catch (err) {
      // Non-fatal: branch may already be up-to-date. This call site has no
      // task to throw a PermanentTaskError into (unlike pushBranchToGitHub)
      // and is deliberately not restructured to add one -- but a
      // non-fast-forward rejection here is the highest-signal instance of
      // this whole failure class: it means another CanopyCMS deployment's
      // worker already pushed ITS OWN state to its own settings branch on
      // GitHub (an actual settings-branch name collision, not just the
      // "foreign branch found locally" case warned about above), so make
      // that explicit instead of a generic "push failed" line.
      const message = getErrorMessage(err)
      if (isNonFastForwardRejection(message)) {
        workerLogWarn(
          `Settings push for ${settingsBranch} was rejected (non-fast-forward): another ` +
            `CanopyCMS deployment appears to own this settings branch on GitHub. Settings from ` +
            `that deployment will NOT be overwritten; this deployment's local settings changes ` +
            `were not pushed. Rename this deployment's settings branch (config.settingsBranch or ` +
            `deploymentName) to resolve the collision.`,
        )
      } else {
        workerLogWarn(`Settings push for ${settingsBranch}:`, message)
      }
    }
  } catch (err) {
    workerLogWarn(
      'Failed to list branches for settings push:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Bring `refs/heads/*` in `remote.git` toward what was just fetched into
 * `GITHUB_TRACKING_REF_PREFIX` -- WITHOUT ever force-rewinding or deleting
 * a local head. This is the non-destructive replacement for what the old
 * `+refs/heads/*:refs/heads/*` fetch refspec used to do implicitly (and
 * destructively) as part of the fetch itself; see
 * `GITHUB_TRACKING_REF_PREFIX`'s doc comment for the two failure modes
 * that refspec caused.
 *
 * Per tracked branch:
 * - no local `refs/heads/<name>` yet -> create it at the tracked commit
 *   (a branch created on GitHub, or by another deployment sharing this
 *   GitHub repo, becomes visible locally).
 * - local is a strict ancestor of tracked (behind) -> fast-forward it.
 * - local === tracked -> nothing to do.
 * - tracked is a strict ancestor of local (ahead) -> LEAVE IT ALONE. This
 *   is unpushed editor/settings work; the queued push task (or
 *   pushSettingsBranches) ships it. This is exactly the branch state the
 *   old refspec used to destroy.
 * - neither is an ancestor of the other (diverged) -> LEAVE IT ALONE and
 *   count/log it. A real collision (e.g. another deployment moved the
 *   same branch name on GitHub); the next push attempt will be rejected
 *   non-fast-forward, which is the correct, visible outcome -- this
 *   method must never silently pick a winner. The one expected, benign
 *   form of this -- our own rebase loop having published a rewrite into
 *   remote.git with the GitHub push still queued -- is split out into the
 *   `rewritten` bucket so the collision warning stays meaningful.
 *
 * Never deletes a local head: a branch removed on GitHub simply stops
 * being tracked here; the local ref persists until removed through its
 * own explicit path (the sync loop must not be one of them).
 *
 * `remote.git` is bare, so there is no worktree to invalidate by moving
 * these refs -- unlike a non-bare repo, updating the ref that happens to
 * be "checked out" is a non-issue here.
 *
 * Concurrency: `remote.git` is bare and on EFS, and the Lambda pushes into
 * it concurrently (`GitManager.push()`'s `target:target` refspec) while
 * this runs. Every `update-ref` below passes the expected old value (the
 * all-zeros OID for "must not exist yet" on creation, the previously-read
 * SHA for the fast-forward case) so a concurrent Lambda write landing in
 * the gap between the read and the write loses the ref update instead of
 * being silently clobbered -- the branch is simply revisited next cycle.
 */
export async function reconcileTrackedBranches(
  ctx: GitSyncContext,
  git: ReturnType<typeof simpleGit>,
): Promise<{ summary: TrackedBranchSummary; trackedNames: Set<string> }> {
  const GIT_ZERO_OID = '0000000000000000000000000000000000000000'
  const created: string[] = []
  const fastForwarded: string[] = []
  const ahead: string[] = []
  const diverged: string[] = []
  const rewritten: string[] = []

  // One invocation enumerates both namespaces: refs/heads/<name> (what the
  // Lambda pushes into and branch clones read from) and
  // GITHUB_TRACKING_REF_PREFIX<name> (GitHub's tip, just fetched above).
  const raw = await git.raw([
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/heads/',
    GITHUB_TRACKING_REF_PREFIX,
  ])

  const heads = new Map<string, string>()
  const tracked = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [refname, sha] = trimmed.split(' ')
    if (refname.startsWith('refs/heads/')) {
      heads.set(refname.slice('refs/heads/'.length), sha)
    } else if (refname.startsWith(GITHUB_TRACKING_REF_PREFIX)) {
      tracked.set(refname.slice(GITHUB_TRACKING_REF_PREFIX.length), sha)
    }
  }

  for (const [name, trackedSha] of tracked) {
    const localSha = heads.get(name)
    const localRef = `refs/heads/${name}`

    if (!localSha) {
      try {
        // Zero old-value asserts the ref does not already exist -- guards
        // against a concurrent Lambda push creating this exact branch
        // name between the for-each-ref read above and this update.
        await git.raw(['update-ref', localRef, trackedSha, GIT_ZERO_OID])
        created.push(name)
      } catch (err) {
        workerLogWarn(
          `  Tracked-branch reconcile: failed to create local ref for ${name} (concurrent update?): ${getErrorMessage(err)}`,
        )
      }
      continue
    }

    if (localSha === trackedSha) continue // nothing to do

    // [SYNC-M2] Everything below is per-branch best-effort. The rev-list
    // used to sit between the two guarded update-ref calls with no guard
    // of its own, so a single ref pointing at a missing or partially
    // written object -- plausible on EFS with the Lambda writing
    // concurrently -- threw out of this loop, out of syncGit()'s try, and
    // skipped pushSettingsBranches(), refreshBaseBranchWorkspace() and
    // rebaseActiveBranches() entirely. Nothing self-healed, so it recurred
    // every cycle. One unreadable ref must cost its own branch, not the
    // whole sync cycle.
    try {
      // Count commits unique to each side in one call: left = commits local
      // has that tracked doesn't (ahead), right = commits tracked has that
      // local doesn't (behind). Exits 0 regardless of ancestry direction,
      // unlike `merge-base --is-ancestor` (which simple-git would throw on
      // a non-zero exit for the common "not an ancestor" case).
      const counts = (
        await git.raw(['rev-list', '--left-right', '--count', `${localSha}...${trackedSha}`])
      ).trim()
      const [leftStr, rightStr] = counts.split(/\s+/)
      const localAheadCount = parseInt(leftStr, 10)
      const localBehindCount = parseInt(rightStr, 10)

      if (!Number.isInteger(localAheadCount) || !Number.isInteger(localBehindCount)) {
        // Unparseable output means we could not read this branch, NOT that
        // it diverged: falling through to the `diverged` bucket below would
        // warn operators about a cross-deployment collision that never
        // happened (parseInt yields NaN, and NaN fails both comparisons).
        workerLogWarn(
          `  Tracked-branch reconcile: skipping ${name}: unparseable rev-list output ${JSON.stringify(counts)}`,
        )
        continue
      }

      if (localAheadCount === 0 && localBehindCount > 0) {
        try {
          await git.raw(['update-ref', localRef, trackedSha, localSha])
          fastForwarded.push(name)
        } catch (err) {
          // Concurrent Lambda push moved the ref since the read above --
          // the guard did its job; this branch is simply revisited next cycle.
          workerLogWarn(
            `  Tracked-branch reconcile: failed to fast-forward ${name} (concurrent update?): ${getErrorMessage(err)}`,
          )
        }
      } else if (localBehindCount === 0 && localAheadCount > 0) {
        // Unpushed local work -- exactly what the old destructive refspec
        // used to force-rewind or delete. Leave it.
        ahead.push(name)
      } else if (await hasPendingHistoryRewrite(ctx, name)) {
        // [SYNC-H1] Our own rebase published a rewrite into remote.git and
        // the GitHub push has not landed yet. Ref-level this is identical
        // to a collision, but it is expected and self-resolving, so it must
        // not fire the collision warning below.
        rewritten.push(name)
      } else {
        // Neither side is an ancestor of the other. Leave both alone.
        diverged.push(name)
      }
    } catch (err) {
      workerLogWarn(
        `  Tracked-branch reconcile: skipping ${name} (unreadable ref or object?): ${getErrorMessage(err)}`,
      )
      continue
    }
  }

  if (diverged.length > 0) {
    workerLogWarn(
      `  Tracked-branch reconcile: ${diverged.length} branch(es) diverged from GitHub and were left untouched: ${diverged.join(', ')}`,
    )
  }
  if (rewritten.length > 0) {
    workerLog(
      `  Tracked-branch reconcile: ${rewritten.length} branch(es) rebased locally with the GitHub push still pending: ${rewritten.join(', ')}`,
    )
  }

  // trackedNames is returned alongside the summary (rather than folded into
  // it) because it is a working set for pushSettingsBranches' stranded-
  // branch check, not part of the worker-status snapshot -- it lists every
  // branch on GitHub and would bloat worker-status.json for no reader.
  return {
    summary: { created, fastForwarded, ahead, diverged, rewritten },
    trackedNames: new Set(tracked.keys()),
  }
}

export async function syncGit(ctx: GitSyncContext): Promise<void> {
  if (!ctx.isRunning()) return

  workerLog('Syncing git...')
  const cycleStartedAt = Date.now()
  const git = simpleGit({
    baseDir: ctx.remoteGitPath,
    // DEP-H1: a hung fetch/push would stall the sync loop forever
    // (scheduleLoop only reschedules after completion). The block timeout
    // is inactivity-based, so a slow-but-flowing transfer is unaffected.
    timeout: { block: ctx.taskTimeoutMs },
  })
  // This instance also drives pushSettingsBranches(git) below, whose
  // classification of a rejected settings-branch push (see that method)
  // needs the same stable-English guarantee as pushBranchToGitHub. Network
  // env for the same reason: the fetch and push here reach GitHub.
  git.env(gitNetworkChildEnv())

  // PR-W1: the whole cycle is wrapped so both outcomes -- success and
  // hard failure (e.g. the fetch throwing against a poisoned remote.git)
  // -- record a worker-status.json snapshot. The status write itself is
  // always best-effort (.catch below): it must never turn an otherwise
  // successful cycle into a failure, and must never mask the real error
  // on a failed one. On failure we rethrow so scheduleLoop's existing
  // per-cycle catch stays the loud path.
  try {
    // Fetch all branches from GitHub using direct URL (no named remote),
    // into the GITHUB_TRACKING_REF_PREFIX remote-tracking namespace rather
    // than refs/heads/* directly -- see that constant's doc comment for
    // the destructive-fetch bug this avoids. We use raw git commands since
    // simple-git's fetch() with a URL doesn't support --prune directly.
    await git.raw([
      'fetch',
      ctx.buildGitHubUrl(),
      '--prune',
      `+refs/heads/*:${GITHUB_TRACKING_REF_PREFIX}*`,
    ])
    workerLog('Fetched from GitHub')

    // Bring refs/heads/* toward what was just fetched, WITHOUT ever
    // force-rewinding or deleting a local head -- see
    // reconcileTrackedBranches()'s doc comment.
    const { summary: trackedSummary, trackedNames } = await reconcileTrackedBranches(ctx, git)

    // Push settings branches to GitHub (belt-and-suspenders for task queue).
    // Ensures settings reach GitHub even if a task queue entry is lost.
    // Ordering relative to the fetch/reconcile above is no longer a
    // correctness dependency now that the fetch can't clobber refs/heads/*
    // -- this could run before or after them just as safely.
    await pushSettingsBranches(ctx, git, trackedNames)

    await refreshBaseBranchWorkspace(ctx)

    const rebaseSummary = await runRebaseCycle(ctx)

    // Periodically clean up old completed/failed tasks
    await cleanupOldTasks(ctx.taskDir, undefined, ctx.log)

    // [C1] Sweep branch directories the admin purge action trashed more
    // than TRASH_RETENTION_MS ago. Worker-only by design: purge itself
    // never deletes anything (reversible), and this cycle is the sole
    // place actual removal happens.
    const trashRemoved = await cleanupTrashedBranchDirs(ctx)
    if (trashRemoved > 0) {
      workerLog(`Removed ${trashRemoved} expired trashed branch dir(s)`)
    }

    const report = ctx.ensureStatusReport()
    report.lastGitSyncAt = new Date().toISOString()
    delete report.lastGitSyncError
    report.lastGitSync = {
      durationMs: Date.now() - cycleStartedAt,
      rebased: rebaseSummary.rebased,
      skippedDirty: rebaseSummary.skippedDirty,
      skippedLocked: rebaseSummary.skippedLocked,
      failed: rebaseSummary.failed,
      tracked: trackedSummary,
    }
    await writeWorkerStatus(ctx.taskDir, report).catch((writeErr) =>
      workerLogError('Failed to write worker status:', getErrorMessage(writeErr)),
    )
  } catch (err) {
    const report = ctx.ensureStatusReport()
    // [REDACT] Persisted to worker-status.json and served to the browser
    // by the admin panel -- a fetch/push failure's message can embed the
    // bot token via buildGitHubUrl().
    report.lastGitSyncError = {
      message: redactCredentials(getErrorMessage(err)),
      at: new Date().toISOString(),
    }
    await writeWorkerStatus(ctx.taskDir, report).catch((writeErr) =>
      workerLogError('Failed to write worker status:', getErrorMessage(writeErr)),
    )
    throw err
  }
}

/**
 * [C1] Remove `.trash-*` branch directories (created by the admin purge
 * action, api/admin-branch-health.ts) whose name-embedded stamp is older
 * than {@link TRASH_RETENTION_MS}. Names that don't match the expected
 * `.trash-{dirName}-{STAMP}` shape, or whose stamp fails to parse, are
 * left alone (logged once per cycle, not per file, to avoid flooding logs
 * if something odd accumulates) -- purge is the only writer of this
 * naming scheme, so an unparseable name is unexpected and worth a human
 * looking rather than a silent skip.
 */
export async function cleanupTrashedBranchDirs(
  ctx: Pick<GitSyncContext, 'contentBranchesPath'>,
): Promise<number> {
  let entries: string[]
  try {
    entries = await fs.readdir(ctx.contentBranchesPath)
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return 0
    throw err
  }

  const now = Date.now()
  let removed = 0
  let loggedUnparseable = false

  for (const name of entries) {
    if (!name.startsWith('.trash-')) continue

    const stampMatch = TRASH_DIR_STAMP_RE.exec(name)
    const stampDate = stampMatch ? parseTrashStamp(stampMatch[1]) : null
    if (!stampDate) {
      if (!loggedUnparseable) {
        workerLog(`CanopyCMS: Skipping trash dir with unparseable stamp: ${name}`)
        loggedUnparseable = true
      }
      continue
    }

    if (now - stampDate.getTime() < TRASH_RETENTION_MS) continue

    try {
      await fs.rm(path.join(ctx.contentBranchesPath, name), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      })
      removed++
    } catch (err: unknown) {
      workerLogError(
        `CanopyCMS: Failed to remove trashed branch dir ${name}:`,
        getErrorMessage(err),
      )
    }
  }

  return removed
}

/**
 * Fast-forward the base branch's own working-tree clone
 * (content-branches/<baseBranch>) to match origin/<baseBranch>.
 *
 * Previously this clone was refreshed only incidentally, by the generic
 * rebase loop below (rebaseActiveBranches): for a branch with status
 * 'editing', rebasing onto origin/<baseBranch> degenerates to a
 * fast-forward when the clone IS the base branch. But that loop's skip
 * paths -- a dirty tree, a missing .git -- are silent, which is the
 * suspected live failure mode: a wedged base clone with no diagnosable
 * signal in the logs. This dedicated step makes the refresh explicit,
 * ff-only, and loud, so a stuck base view (an editor forking a new branch
 * "from base" that's actually a stale snapshot) is diagnosable from logs.
 * This runs every sync cycle so the drift window is bounded by
 * gitSyncInterval.
 *
 * ff-only on purpose: this clone must stay a linear mirror of
 * origin/<baseBranch>, so a merge that isn't a fast-forward (diverged
 * local history) is treated as a should-never-happen condition and left
 * untouched rather than force-resolved.
 */
export async function refreshBaseBranchWorkspace(ctx: GitSyncContext): Promise<void> {
  // Sanitized name for the workspace directory (a base branch containing
  // e.g. '/' would otherwise stat a wrong nested path here forever).
  const basePath = path.join(ctx.contentBranchesPath, ctx.sanitizedBaseBranch)
  const gitDir = path.join(basePath, '.git')

  try {
    let gitDirStat
    try {
      gitDirStat = await fs.stat(gitDir)
    } catch {
      gitDirStat = null
    }
    if (!gitDirStat || !gitDirStat.isDirectory()) {
      workerLog(`Base branch workspace (${ctx.baseBranch}): not yet provisioned, skipping refresh`)
      return
    }

    const baseGit = simpleGit({
      baseDir: basePath,
      // Keep git non-interactive during the merge so it never blocks on an
      // editor. simple-git >=3.32 blocks setting core.editor unless
      // explicitly opted in; the value here is a hardcoded literal
      // ("true", the shell no-op), not user input, so enabling
      // allowUnsafeEditor carries no injection risk (same as the rebase
      // loop's git config below).
      config: ['core.editor=true'],
      unsafe: { allowUnsafeEditor: true },
      // DEP-H1: a hung fetch/merge against this EFS-backed clone would
      // stall the sync loop forever (scheduleLoop only reschedules after
      // completion). The block timeout is inactivity-based, so a
      // slow-but-flowing transfer is unaffected -- same as syncGit()'s
      // remote handle.
      timeout: { block: ctx.taskTimeoutMs },
    })

    // Nothing makes this clone read-only. A direct edit here (or a stray
    // process) wedges every editor's view of the base branch until an
    // operator intervenes, so a dirty tree is loud, not a quiet skip.
    // Only TRACKED changes block the refresh: a stray untracked file (e.g.
    // runtime metadata missing from .git/info/exclude) must not wedge the
    // fast-forward forever — if an untracked file would collide with
    // incoming content, the --ff-only merge below refuses on its own and
    // that failure is already logged loudly.
    const status = await baseGit.status()
    const trackedDirty = status.files.filter((f) => f.index !== '?' || f.working_dir !== '?')
    if (trackedDirty.length > 0) {
      workerLogError(
        `Base branch workspace (${ctx.baseBranch}) has uncommitted changes -- skipping refresh. Dirty files: ${trackedDirty.map((f) => f.path).join(', ')}`,
      )
      return
    }

    // Raw (unsanitized) name from here on: these are git ref operations
    // against origin/<baseBranch>, not filesystem paths, so they must use
    // the same name GitHub knows the branch by.
    await baseGit.fetch('origin', ctx.baseBranch)

    // Use rev-list instead of status.behind for the same reason as the
    // rebase loop below: status.behind only works with an upstream
    // tracking branch configured, which isn't guaranteed here.
    // Compare against the just-fetched tip rather than origin/<base>:
    // workspaces are cloned --single-branch (git-manager.ts), so their
    // fetch refspec only materializes a remote-tracking ref for the branch
    // they were cloned from — for any other base branch, origin/<base>
    // simply never exists and rev-list dies with "ambiguous argument".
    // Pin FETCH_HEAD to a SHA immediately: FETCH_HEAD is one shared mutable
    // file per repo, silently repointed by ANY other fetch in this clone.
    const fetchedTip = (await baseGit.revparse(['FETCH_HEAD'])).trim()
    const behindCount = parseInt(
      (await baseGit.raw(['rev-list', '--count', `HEAD..${fetchedTip}`])).trim(),
      10,
    )

    if (behindCount > 0) {
      try {
        await baseGit.merge(['--ff-only', fetchedTip])
      } catch (err) {
        workerLogError(
          `Base branch workspace (${ctx.baseBranch}) failed to fast-forward (diverged local history?): ${getErrorMessage(err)}`,
        )
        return
      }
      await invalidateBranchContentCaches(basePath)
    }

    // Hygiene: conflictStatus/conflictFiles are meaningless for the base
    // branch's own metadata and may be left over from before the base was
    // excluded from rebaseActiveBranches()'s conflict-resolution loop.
    // Reuse the already-clean no-op-save guard from that loop: save()
    // eager-regenerates the branch registry (O(branch count) EFS reads),
    // so skip it when there's nothing to clear.
    const currentMeta = await BranchMetadataFileManager.loadOnly(basePath)
    const conflictStatus = currentMeta?.branch.conflictStatus
    const conflictFiles = currentMeta?.branch.conflictFiles
    const alreadyClean =
      (conflictStatus === undefined || conflictStatus === 'clean') &&
      (conflictFiles === undefined || conflictFiles.length === 0)
    if (!alreadyClean) {
      const meta = getBranchMetadataFileManager(basePath, ctx.contentBranchesPath)
      await meta.save({
        branch: { name: ctx.baseBranch, conflictStatus: 'clean', conflictFiles: [] },
      })
    }

    // One concise per-cycle line -- the diagnostic for the next live deploy.
    workerLog(
      behindCount > 0
        ? `Base branch workspace (${ctx.baseBranch}): fast-forwarded ${behindCount} commit(s)`
        : `Base branch workspace (${ctx.baseBranch}): up to date`,
    )
  } catch (err) {
    workerLogError(
      `Base branch workspace (${ctx.baseBranch}) refresh failed: ${getErrorMessage(err)}`,
    )
  }
}
