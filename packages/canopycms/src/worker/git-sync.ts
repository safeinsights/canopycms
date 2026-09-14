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
 * One ordering is load-bearing and nothing enforces it: `runRebaseCycle` MUST
 * follow `reconcileTrackedBranches`. Branch clones fetch the base tip from
 * `remote.git` (`origin`), and `reconcileTrackedBranches` is what advances
 * `remote.git`'s `refs/heads/*` toward what the fetch above put in the tracking
 * namespace; reorder them and every branch rebases onto the PREVIOUS cycle's
 * base tip -- not corrupting, but silently a cycle behind.
 * (`pushSettingsBranches` consuming `trackedNames` is a DATA dependency its
 * signature already enforces; `refreshBaseBranchWorkspace` and the two sweeps
 * are order-independent.)
 *
 * The whole cycle is wrapped so both outcomes record a worker-status.json
 * snapshot, since an operator's only view of this loop is the admin panel.
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
 * Per-cycle outcome of `reconcileTrackedBranches()`, folded by `syncGit()` into
 * the worker's self-reported status (`WorkerStatusReport.lastGitSync.tracked`,
 * see worker-status.ts).
 */
export interface TrackedBranchSummary {
  /** GitHub branches with no corresponding local `refs/heads/<name>` yet -- created at GitHub's tip. */
  created: string[]
  /** Local heads that were strict ancestors of GitHub's tip -- fast-forwarded to it. */
  fastForwarded: string[]
  /** Local heads AHEAD of GitHub's tip -- unpushed editor/settings work, left untouched. */
  ahead: string[]
  /**
   * Local heads that diverged from GitHub's tip (neither side is an ancestor of
   * the other) -- left untouched and logged. A real collision (e.g. another
   * deployment moved the same branch name); the next push attempt is rejected
   * non-fast-forward, which is the correct, visible outcome.
   */
  diverged: string[]
  /**
   * Local heads that diverged because THIS worker's rebase loop rewrote them
   * and published the rewrite into `remote.git`, with the GitHub push still
   * outstanding (`BranchMetadata.historyRewrittenFrom` is set). Identical to
   * `diverged` at the ref level, but known and self-resolving -- its own bucket
   * so the collision warning stays meaningful.
   */
  rewritten: string[]
}

/**
 * Push THIS deployment's own settings branch (`ensureSettingsBranch()`) from
 * remote.git to GitHub. Non-fatal: a no-op push for an up-to-date branch just
 * succeeds quietly.
 *
 * Narrowed to that ONE branch, never every local `canopycms-settings-*`:
 * `reconcileTrackedBranches` creates local heads for branches that exist on
 * GitHub, so ANOTHER deployment's settings branch (sharing this GitHub repo)
 * can legitimately show up as a local head here. Pushing it would be this
 * deployment shipping settings state it does not own.
 */
export async function pushSettingsBranches(
  ctx: GitSyncContext,
  git: ReturnType<typeof simpleGit>,
  trackedNames: ReadonlySet<string>,
): Promise<void> {
  try {
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

    // [SYNC-M3] A settings branch in remote.git but absent from GitHub's
    // tracking refs was pushed here LOCALLY (only this deployment's own API
    // writes to remote.git) and has never reached GitHub. That absence is the
    // discriminating signature: in the SUPPORTED two-deployments-one-repo case
    // the foreign branch arrives through the GitHub fetch and so always has a
    // tracking ref, while an "owned-branch-absent" test alone would fire on
    // every deployment that has simply had no settings edit yet.
    //
    // With this deployment's own branch also missing, the API and this worker
    // have resolved different deploymentNames, and every settings change the
    // API commits is stranded in remote.git forever.
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
      // Resolved in place, not hoisted: this is the only push in the function,
      // so there is no second call to keep consistent, and hoisting would move
      // the resolution out to syncGit and change this signature -- which
      // cms-worker.test.ts pins by calling the method through the instance.
      await git.push(await ctx.buildGitHubUrl(), settingsBranch)
      workerLog(`Pushed settings branch ${settingsBranch} to GitHub`)
    } catch (err) {
      // Non-fatal: the branch may already be up to date, and this call site has
      // no task to throw a PermanentTaskError into (unlike pushBranchToGitHub).
      // A non-fast-forward rejection here still gets its own wording: it means
      // another deployment's worker already pushed ITS OWN state to this
      // settings-branch name on GitHub -- an actual collision, not just the
      // "foreign branch found locally" case warned about above.
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
 * `GITHUB_TRACKING_REF_PREFIX` -- WITHOUT ever force-rewinding or deleting a
 * local head (see that constant's doc comment for the two failure modes a
 * `+refs/heads/*:refs/heads/*` fetch refspec causes).
 *
 * Per tracked branch: no local `refs/heads/<name>` -> create it at the tracked
 * commit; local behind -> fast-forward; equal -> nothing to do; local AHEAD ->
 * LEAVE IT ALONE, since that is unpushed editor/settings work the queued push
 * task (or pushSettingsBranches) ships; diverged -> LEAVE IT ALONE, count and
 * log it. Divergence is a real collision (another deployment moved the same
 * branch name on GitHub) and the next push is rejected non-fast-forward, the
 * correct visible outcome -- this must never silently pick a winner. The one
 * benign form, our own rebase loop having published a rewrite with the GitHub
 * push still queued, is split into `rewritten` so that warning stays meaningful.
 *
 * Never deletes a local head: a branch removed on GitHub simply stops being
 * tracked here; the local ref persists until removed through its own explicit
 * path, which the sync loop must not be.
 *
 * Concurrency: `remote.git` is bare and on EFS, and the Lambda pushes into it
 * while this runs. Every `update-ref` below passes the expected old value (the
 * all-zeros OID for "must not exist yet" on creation, the just-read SHA for a
 * fast-forward), so a concurrent Lambda write landing between the read and the
 * write loses the ref update instead of silently clobbering it -- that branch
 * is simply revisited next cycle.
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
  // GITHUB_TRACKING_REF_PREFIX<name> (GitHub's tip).
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
        // The zero old-value asserts the ref does not already exist, guarding
        // against a concurrent Lambda push creating this exact branch name
        // between the for-each-ref read above and this update.
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

    // [SYNC-M2] Everything below is per-branch best-effort: one unreadable ref
    // must cost its own branch, not the whole sync cycle. A ref pointing at a
    // missing or partially written object is plausible on EFS with the Lambda
    // writing concurrently, and an unguarded throw here escapes syncGit()'s try
    // -- skipping pushSettingsBranches(), refreshBaseBranchWorkspace() and the
    // rebase cycle, with nothing to self-heal it on the next pass.
    try {
      // Commits unique to each side in one call: left = local's (ahead), right
      // = tracked's (behind). Exits 0 regardless of ancestry direction, unlike
      // `merge-base --is-ancestor`, whose non-zero exit for the common "not an
      // ancestor" case simple-git would throw on.
      const counts = (
        await git.raw(['rev-list', '--left-right', '--count', `${localSha}...${trackedSha}`])
      ).trim()
      const [leftStr, rightStr] = counts.split(/\s+/)
      const localAheadCount = parseInt(leftStr, 10)
      const localBehindCount = parseInt(rightStr, 10)

      if (!Number.isInteger(localAheadCount) || !Number.isInteger(localBehindCount)) {
        // Unparseable output means this branch could not be read, NOT that it
        // diverged: falling through to the `diverged` bucket (parseInt yields
        // NaN, which fails both comparisons) would warn operators about a
        // cross-deployment collision that never happened.
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
        // Unpushed local work. Leave it.
        ahead.push(name)
      } else if (await hasPendingHistoryRewrite(ctx, name)) {
        // [SYNC-H1] Our own rebase published a rewrite into remote.git and the
        // GitHub push has not landed yet. Ref-level this is identical to a
        // collision, but expected and self-resolving, so it must not fire the
        // collision warning below.
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

  // trackedNames is returned alongside the summary rather than folded into it:
  // it is a working set for pushSettingsBranches' stranded-branch check, and
  // listing every branch on GitHub would bloat worker-status.json for no reader.
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
  // gitNetworkChildEnv because the fetch and push here reach GitHub, and
  // because pushSettingsBranches(git) below needs its stable-English guarantee
  // to classify a rejected settings-branch push.
  git.env(gitNetworkChildEnv())

  // The whole cycle is wrapped so both outcomes -- success and hard failure
  // (e.g. the fetch throwing against a poisoned remote.git) -- record a
  // worker-status.json snapshot. The status write itself is always best-effort
  // (.catch below): it must never turn a successful cycle into a failure, nor
  // mask the real error on a failed one. Failures rethrow, so scheduleLoop's
  // per-cycle catch stays the loud path.
  try {
    // Direct URL (no named remote), into the GITHUB_TRACKING_REF_PREFIX
    // remote-tracking namespace rather than refs/heads/* -- see that constant's
    // doc comment for the destructive-fetch bug this avoids. Raw git, because
    // simple-git's fetch() with a URL does not support --prune.
    await git.raw([
      'fetch',
      await ctx.buildGitHubUrl(),
      '--prune',
      `+refs/heads/*:${GITHUB_TRACKING_REF_PREFIX}*`,
    ])
    workerLog('Fetched from GitHub')

    const { summary: trackedSummary, trackedNames } = await reconcileTrackedBranches(ctx, git)

    // Push settings branches to GitHub (belt-and-suspenders for task queue).
    // Ensures settings reach GitHub even if a task queue entry is lost.
    // Ordering relative to the fetch/reconcile above is no longer a
    // correctness dependency now that the fetch can't clobber refs/heads/*
    // -- this could run before or after them just as safely.
    await pushSettingsBranches(ctx, git, trackedNames)

    await refreshBaseBranchWorkspace(ctx)

    const rebaseSummary = await runRebaseCycle(ctx)

    await cleanupOldTasks(ctx.taskDir, undefined, ctx.log)

    // [C1] Sweep branch directories the admin purge action trashed more than
    // TRASH_RETENTION_MS ago. Worker-only by design: purge itself never deletes
    // anything (it stays reversible), and this is the sole place removal
    // actually happens.
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
 * [C1] Remove `.trash-*` branch directories (created by the admin purge action,
 * api/admin-branch-health.ts) whose name-embedded stamp is older than
 * {@link TRASH_RETENTION_MS}. A name that doesn't match `.trash-{dirName}-
 * {STAMP}`, or whose stamp fails to parse, is left alone and logged once per
 * cycle: purge is the only writer of this naming scheme, so an unparseable name
 * is unexpected and worth a human looking rather than a silent skip.
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
 * (content-branches/<baseBranch>) to match origin/<baseBranch>, every sync
 * cycle, so the drift window is bounded by gitSyncInterval.
 *
 * A dedicated, explicit and LOUD step rather than a side effect of the rebase
 * loop, whose skip paths (a dirty tree, a missing .git) are silent: a wedged
 * base clone otherwise leaves no diagnosable signal, and an editor forking a
 * new branch "from base" silently gets a stale snapshot.
 *
 * ff-only on purpose: this clone must stay a linear mirror of
 * origin/<baseBranch>, so a merge that isn't a fast-forward (diverged local
 * history) is left untouched rather than force-resolved.
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
      // editor. simple-git >=3.32 requires opting in to set core.editor; the
      // value is a hardcoded literal ("true", the shell no-op), not user input,
      // so allowUnsafeEditor carries no injection risk here.
      config: ['core.editor=true'],
      unsafe: { allowUnsafeEditor: true },
      // DEP-H1: a hung fetch/merge against this EFS-backed clone would stall
      // the sync loop forever (scheduleLoop only reschedules after completion).
      // Inactivity-based, so a slow-but-flowing transfer is unaffected.
      timeout: { block: ctx.taskTimeoutMs },
    })

    // Nothing makes this clone read-only, and a direct edit here wedges every
    // editor's view of the base branch until an operator intervenes, so a dirty
    // tree is loud, not a quiet skip. Only TRACKED changes block the refresh: a
    // stray untracked file must not wedge the fast-forward forever, and if one
    // would collide with incoming content the --ff-only merge below refuses on
    // its own and that failure is already logged loudly.
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

    // rev-list, not status.behind, which needs an upstream tracking branch that
    // is not guaranteed here. Against the just-fetched tip rather than
    // origin/<base>: workspaces are cloned --single-branch (git-manager.ts), so
    // for any other base branch origin/<base> never exists and rev-list dies
    // with "ambiguous argument". Pin FETCH_HEAD to a SHA immediately -- it is
    // one shared mutable file per repo, silently repointed by any other fetch.
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
    // branch's own metadata, which is excluded from the rebase loop's
    // conflict-resolution pass. Guarded on already-clean, like that loop:
    // save() eager-regenerates the branch registry (O(branch count) EFS reads),
    // so skip it when there is nothing to clear.
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
