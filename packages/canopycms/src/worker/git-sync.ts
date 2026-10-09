import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { BranchMetadataFileManager, getBranchMetadataFileManager } from '../branch-metadata'
import { BRANCH_META_DIR, BRANCH_META_FILE } from '../branch-metadata-file'
import { ORPHAN_YOUTH_THRESHOLD_MS } from '../branch-health'
import {
  classifyFinalDir,
  parseDirStamp,
  quarantineResidueAt,
  sweepProvisioningLeftovers,
} from '../branch-provisioning'
import { invalidateBranchContentCaches } from '../content-index-generation'
import {
  GITHUB_TRACKING_REF_PREFIX,
  ensureGitExcludePattern,
  gitNetworkChildEnv,
} from '../git-manager'
import { RESERVED_SETTINGS_BRANCH_PREFIX } from '../paths/branch-name'
import { tryAcquireContentWriteLock } from '../utils/content-write-lock'
import { branchProvisioningLockName, tryAcquireProvisioningLock } from '../utils/provisioning-lock'
import { getErrorMessage, isNodeError, redactCredentials } from '../utils/error'
import { CANOPY_META_DIR, isCanopyInternalPath, isNonFastForwardRejection } from '../utils/git'
import type { BaseRefreshReport, BaseSchemaHold } from '../types'
import {
  MAX_REPORTED_PATHS,
  TRACKED_CANOPY_STATE_FIX,
  isUntracked,
  listTrackedCanopyState,
  restoreRetiredSchemaCache,
  splitByUpstreamTracking,
  untrackInIndex,
} from './canopy-state'
import { hasPendingHistoryRewrite } from './history-rewrite'
import { runRebaseCycle, type RebaseContext } from './rebase'
import { cleanupOldTasks } from '../task-queue/cms-task-queue'
import { writeWorkerStatus } from '../task-queue/worker-status'
import { workerLog, workerLogError, workerLogWarn } from './log'
import { holdProvisionedWorkspace, releaseProvisionedWorkspace } from './provisioned-workspace'
import { maintainRemoteGit } from './remote-git-maintenance'
import { decideBaseAdvance } from './schema-gate'
import { reapplySparseCones } from './sparse-cone'
import type { WorkerContext } from './worker-context'

/**
 * The git-sync cluster: everything reachable from `CmsWorker.syncGit()`, the
 * slower of the worker's two poll loops (default 5 minutes, against the task
 * queue's 5 seconds).
 *
 * One cycle, in order: repair what killed provisioning and deletes left under
 * the branches root (`repairBranchDirResidue`), move sparse clones to a changed
 * content root's cone (sparse-cone.ts), repack `remote.git` when it needs it
 * (remote-git-maintenance.ts), fetch every GitHub branch into the tracking namespace,
 * bring `refs/heads/*` toward it non-destructively (`reconcileTrackedBranches`,
 * which holds the base branch while schema-gate.ts says the serving editor lacks a
 * schema the incoming content names), push this deployment's own settings branch, fast-forward the base branch's
 * workspace, rebase every branch that is behind it (rebase.ts), then sweep old
 * tasks and expired trashed branch directories.
 *
 * One ordering is load-bearing and nothing enforces it: `runRebaseCycle` MUST
 * follow `reconcileTrackedBranches`. Branch clones fetch the base tip from
 * `remote.git`, and `reconcileTrackedBranches` is what advances
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
  | 'schemaHoldMaxMs'
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

/**
 * Per-cycle outcome of `reconcileTrackedBranches()`, folded by `syncGit()` into
 * the worker's self-reported status (`WorkerStatusReport.lastGitSync.tracked`,
 * see task-queue/worker-status.ts).
 */
interface TrackedBranchSummary {
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
async function reconcileTrackedBranches(
  ctx: GitSyncContext,
  git: ReturnType<typeof simpleGit>,
): Promise<{
  summary: TrackedBranchSummary
  trackedNames: Set<string>
  /**
   * The schema gate's state for the base branch, or undefined when this cycle could not classify
   * the base and the previous state stands.
   */
  baseHold: { hold: BaseSchemaHold | undefined } | undefined
}> {
  const GIT_ZERO_OID = '0000000000000000000000000000000000000000'
  const created: string[] = []
  const fastForwarded: string[] = []
  const ahead: string[] = []
  const diverged: string[] = []
  const rewritten: string[] = []
  let baseHold: { hold: BaseSchemaHold | undefined } | undefined

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

    if (localSha === trackedSha) {
      if (name === ctx.baseBranch) baseHold = { hold: undefined }
      continue
    }

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
        // The base branch's fast-forward is the one source of new content for the base
        // workspace, every rebased branch and every new clone, so the schema gate sits here.
        if (name === ctx.baseBranch) {
          const decision = await decideBaseAdvance({
            git,
            contentBranchesPath: ctx.contentBranchesPath,
            baseBranch: name,
            currentSha: localSha,
            incomingSha: trackedSha,
            previous: ctx.ensureStatusReport().baseHold,
            maxHoldMs: ctx.schemaHoldMaxMs,
          })
          baseHold = { hold: decision.kind === 'advance' ? undefined : decision.hold }
          if (decision.kind === 'hold') {
            workerLog(
              `  Tracked-branch reconcile: holding ${name} for an editor deploy defining ${decision.hold.missingSchemas.join(', ')}`,
            )
            continue
          }
        }
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
        if (name === ctx.baseBranch) baseHold = { hold: undefined }
      } else if (await hasPendingHistoryRewrite(ctx, name)) {
        // [SYNC-H1] Our own rebase published a rewrite into remote.git and the
        // GitHub push has not landed yet. Ref-level this is identical to a
        // collision, but expected and self-resolving, so it must not fire the
        // collision warning below.
        rewritten.push(name)
        if (name === ctx.baseBranch) baseHold = { hold: undefined }
      } else {
        // Neither side is an ancestor of the other. Leave both alone.
        diverged.push(name)
        if (name === ctx.baseBranch) baseHold = { hold: undefined }
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
    baseHold,
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
    // Best-effort and ahead of the GitHub fetch, so a GitHub outage never
    // stalls upkeep and a failure here never costs the cycle. start() runs a
    // cycle at once, so residue repair also runs on boot.
    try {
      await repairBranchDirResidue(ctx)
    } catch (err) {
      workerLogWarn(`Branch directory residue repair failed: ${getErrorMessage(err)}`)
    }
    try {
      await reapplySparseCones(ctx)
    } catch (err) {
      workerLogWarn(`Sparse-checkout cone update failed: ${getErrorMessage(err)}`)
    }
    try {
      await maintainRemoteGit(ctx.remoteGitPath)
    } catch (err) {
      workerLogWarn(`remote.git maintenance failed: ${getErrorMessage(err)}`)
    }

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

    const {
      summary: trackedSummary,
      trackedNames,
      baseHold,
    } = await reconcileTrackedBranches(ctx, git)
    // Recorded at once, so a step below that throws still persists the hold through the catch.
    if (baseHold) {
      const report = ctx.ensureStatusReport()
      if (baseHold.hold) report.baseHold = baseHold.hold
      else delete report.baseHold
    }

    // Push settings branches to GitHub (belt-and-suspenders for task queue).
    // Ensures settings reach GitHub even if a task queue entry is lost.
    // Ordering relative to the fetch/reconcile above is no longer a
    // correctness dependency now that the fetch can't clobber refs/heads/*
    // -- this could run before or after them just as safely.
    await pushSettingsBranches(ctx, git, trackedNames)

    const baseRefresh = await refreshBaseBranchWorkspace(ctx)

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
      skippedDirty:
        baseRefresh.outcome === 'skipped-dirty'
          ? [ctx.sanitizedBaseBranch, ...rebaseSummary.skippedDirty]
          : rebaseSummary.skippedDirty,
      skippedLocked:
        baseRefresh.outcome === 'skipped-locked'
          ? [ctx.sanitizedBaseBranch, ...rebaseSummary.skippedLocked]
          : rebaseSummary.skippedLocked,
      failed: rebaseSummary.failed,
      baseRefresh,
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

/** Foreign repositories already reported by this process, so each is logged once. */
const reportedForeignDirs = new Set<string>()

/**
 * Repair what killed provisioning and deletes left under the branches root: quarantine residue
 * at a branch's name (branch-provisioning.ts's `classifyFinalDir`) once it has been quiet for
 * {@link ORPHAN_YOUTH_THRESHOLD_MS}, then sweep stale `.prov-*`, `.deleting-*` and `.repair-*`
 * siblings and settings leftovers. Each directory is best-effort, like [SYNC-M2]. The provisioning
 * lock is taken zero-retry, so a live provisioner or admin action wins and the directory is
 * revisited next cycle.
 * @internal Exported for tests; `syncGit` runs it.
 */
export async function repairBranchDirResidue(
  ctx: Pick<GitSyncContext, 'contentBranchesPath' | 'remoteGitPath'>,
  now = Date.now(),
): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(ctx.contentBranchesPath, { withFileTypes: true })
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return
    throw err
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    try {
      await repairOneBranchDir(ctx, entry.name, now)
    } catch (err: unknown) {
      workerLogWarn(`  Residue check of ${entry.name} failed: ${getErrorMessage(err)}`)
    }
  }

  const leftovers = await sweepProvisioningLeftovers(
    ctx.contentBranchesPath,
    path.dirname(ctx.contentBranchesPath),
    now,
  )
  for (const { name, action, detail } of leftovers) {
    const line = `  Leftover ${name}: ${action}${detail ? ` (${detail})` : ''}`
    if (action === 'removed') workerLog(line)
    else if (action === 'failed') workerLogWarn(line)
    else workerLogError(line)
  }
}

async function repairOneBranchDir(
  ctx: Pick<GitSyncContext, 'contentBranchesPath' | 'remoteGitPath'>,
  dirName: string,
  now: number,
): Promise<void> {
  const dirPath = path.join(ctx.contentBranchesPath, dirName)
  // One stat for the common case: a live (or corrupt) branch is never residue.
  const hasMeta = await fs.access(path.join(dirPath, BRANCH_META_DIR, BRANCH_META_FILE)).then(
    () => true,
    () => false,
  )
  if (hasMeta) return

  const state = await classifyFinalDir(dirPath, ctx.remoteGitPath)
  if (state.kind === 'foreign' && !reportedForeignDirs.has(dirPath)) {
    reportedForeignDirs.add(dirPath)
    workerLogWarn(
      `  ${dirName} holds a git repository this deployment did not create; left for an admin`,
    )
  }
  if (state.kind !== 'residue') return

  let release: () => Promise<void>
  try {
    release = await tryAcquireProvisioningLock(
      ctx.contentBranchesPath,
      branchProvisioningLockName(dirName),
    )
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ELOCKED') return
    throw err
  }
  try {
    await quarantineResidueAt(ctx.contentBranchesPath, dirName, {
      minQuietMs: ORPHAN_YOUTH_THRESHOLD_MS,
      expectedRemoteUrl: ctx.remoteGitPath,
      now,
    })
  } finally {
    await releaseProvisionedWorkspace(release, dirName)
  }
}

/**
 * [C1] Remove `.trash-*` branch directories (created by the admin purge action,
 * api/admin-branch-health.ts, and by residue quarantine, branch-provisioning.ts)
 * whose name-embedded stamp is older than {@link TRASH_RETENTION_MS}. A name
 * whose trailing stamp fails to parse is left alone and logged once per cycle:
 * both writers end every name with one, so it is worth a human looking.
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

    const stampDate = parseDirStamp(name)
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
 * Warned (base path + tracked file list) pairs, so a repo that tracks
 * `.canopy-meta/` is called out once per worker process rather than every cycle;
 * worker-status.json carries it every cycle regardless.
 */
const warnedTrackedCanopyState = new Set<string>()

/**
 * Fast-forward the base branch's own working-tree clone
 * (content-branches/<baseBranch>) to match remote.git's <baseBranch>, every sync
 * cycle, so the drift window is bounded by gitSyncInterval.
 *
 * A dedicated, explicit and LOUD step rather than a side effect of the rebase
 * loop, whose skip paths (a dirty tree, a missing .git) are silent: a wedged
 * base clone otherwise leaves no diagnosable signal, and an editor forking a
 * new branch "from base" silently gets a stale snapshot. The returned outcome
 * goes to worker-status.json for the same reason.
 *
 * ff-only on purpose: this clone must stay a linear mirror of remote.git's
 * <baseBranch>, so a merge that isn't a fast-forward (diverged local
 * history) is left untouched rather than force-resolved.
 *
 * Holds the provisioning lock and then, like the rebase loop, the [SYNC-C1]
 * content-write lock, both try-only: the base branch is writable in dev, and
 * a save racing the merge's working-tree update can be overwritten by it.
 */
export async function refreshBaseBranchWorkspace(ctx: GitSyncContext): Promise<BaseRefreshReport> {
  // Sanitized name for the workspace directory (a base branch containing
  // e.g. '/' would otherwise stat a wrong nested path here forever).
  const basePath = path.join(ctx.contentBranchesPath, ctx.sanitizedBaseBranch)
  let trackedCanopyMeta: string[] | undefined
  let releaseProvisioning: (() => Promise<void>) | undefined
  let releaseContentLock: (() => Promise<void>) | undefined

  try {
    // Held to the end, so no git step below races a clone of this directory.
    const hold = await holdProvisionedWorkspace(ctx.contentBranchesPath, ctx.sanitizedBaseBranch)
    if (hold.kind === 'locked') {
      workerLog(
        `Base branch workspace (${ctx.baseBranch}): provisioning lock held elsewhere, skipping refresh`,
      )
      return { outcome: 'skipped-locked' }
    }
    if (hold.kind === 'not-provisioned') {
      workerLog(`Base branch workspace (${ctx.baseBranch}): not yet provisioned, skipping refresh`)
      return { outcome: 'skipped-not-provisioned' }
    }
    releaseProvisioning = hold.release

    let contentLockCompromised = false
    try {
      releaseContentLock = await tryAcquireContentWriteLock(basePath, (lockErr) => {
        contentLockCompromised = true
        workerLogWarn(
          `Base branch workspace (${ctx.baseBranch}): content-write lock compromised mid-refresh: ${getErrorMessage(lockErr)}`,
        )
      })
    } catch (lockErr: unknown) {
      if (isNodeError(lockErr) && lockErr.code === 'ELOCKED') {
        workerLog(
          `Base branch workspace (${ctx.baseBranch}): content write in progress, skipping refresh`,
        )
        return { outcome: 'skipped-locked' }
      }
      throw lockErr
    }

    // Checked before each destructive step: a lost provisioning lock means
    // another process may be cloning into this directory, a lost content lock
    // that an editor save may be landing in it.
    const lockLost = (): BaseRefreshReport | null => {
      if (!hold.isCompromised() && !contentLockCompromised) return null
      const lost = hold.isCompromised() ? 'provisioning' : 'content-write'
      workerLogWarn(
        `Base branch workspace (${ctx.baseBranch}): ${lost} lock lost mid-refresh, stopping`,
      )
      return { outcome: 'skipped-locked', trackedCanopyMeta }
    }

    // Idempotent, and applied every cycle so any clone lacking it gets it.
    await ensureGitExcludePattern(basePath, `${CANOPY_META_DIR}/`)

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

    const trackedState = await listTrackedCanopyState(baseGit)
    if (trackedState.length > 0) {
      trackedCanopyMeta = trackedState.slice(0, MAX_REPORTED_PATHS)
      const warnKey = `${basePath}\0${trackedState.join('\0')}`
      if (!warnedTrackedCanopyState.has(warnKey)) {
        warnedTrackedCanopyState.add(warnKey)
        workerLogWarn(
          `Base branch (${ctx.baseBranch}) tracks canopycms state that must not be committed: ` +
            `${trackedState.join(', ')}. To fix, ${TRACKED_CANOPY_STATE_FIX}.`,
        )
      }
    }

    let status = await baseGit.status()
    const lostBeforeRestore = lockLost()
    if (lostBeforeRestore) return lostBeforeRestore
    if (await restoreRetiredSchemaCache(baseGit, status)) {
      workerLog(
        `Base branch workspace (${ctx.baseBranch}): restored the retired in-tree schema cache`,
      )
      status = await baseGit.status()
    }

    // Nothing makes this clone read-only, and a direct edit here wedges every
    // editor's view of the base branch until an operator intervenes, so a dirty
    // tree is loud, not a quiet skip. Only TRACKED content changes block the
    // refresh: canopycms's own state never does, and neither does a stray
    // untracked file. A modified tracked file or an untracked one that would
    // collide with incoming content makes the --ff-only merge below refuse and
    // report `failed`; an IGNORED file, which every .canopy-meta file is, git
    // overwrites instead.
    const trackedDirty = status.files
      .filter((f) => !isUntracked(f) && !isCanopyInternalPath(f.path))
      .map((f) => f.path)
    if (trackedDirty.length > 0) {
      workerLogError(
        `Base branch workspace (${ctx.baseBranch}) has uncommitted changes -- skipping refresh. Dirty files: ${trackedDirty.join(', ')}`,
      )
      return {
        outcome: 'skipped-dirty',
        dirtyFiles: trackedDirty.slice(0, MAX_REPORTED_PATHS),
        message: `${trackedDirty.length} uncommitted tracked file(s) in the base branch workspace`,
        trackedCanopyMeta,
      }
    }

    // Raw (unsanitized) name from here on: these are git ref operations
    // against remote.git's <baseBranch>, not filesystem paths, so they must use
    // the same name GitHub knows the branch by.
    await baseGit.fetch(ctx.remoteGitPath, ctx.baseBranch)

    // rev-list, not status.behind, which needs an upstream tracking branch that
    // is not guaranteed here. Against the just-fetched tip: a fetch by path
    // updates no remote-tracking ref. Pin FETCH_HEAD to a SHA immediately -- it
    // is one shared mutable file per repo, silently repointed by any other fetch.
    const fetchedTip = (await baseGit.revparse(['FETCH_HEAD'])).trim()
    const behindCount = parseInt(
      (await baseGit.raw(['rev-list', '--count', `HEAD..${fetchedTip}`])).trim(),
      10,
    )

    if (behindCount > 0) {
      const lostBeforeMerge = lockLost()
      if (lostBeforeMerge) return lostBeforeMerge
      // Untrack, in the index only, any state the tip has stopped tracking:
      // the merge would otherwise refuse to overwrite a modified copy, or
      // delete a clean one from disk. Safe here and not in the rebase loop,
      // because this clone has no commits of its own to replay. State still
      // tracked upstream is left for the merge, which refuses where upstream
      // changed a locally modified copy.
      const { droppedUpstream } = await splitByUpstreamTracking(baseGit, trackedState, fetchedTip)
      if (droppedUpstream.length > 0) {
        await untrackInIndex(baseGit, droppedUpstream)
        workerLog(
          `Base branch workspace (${ctx.baseBranch}): stopped tracking ${droppedUpstream.join(', ')}, as upstream has`,
        )
      }
      try {
        await baseGit.merge(['--ff-only', fetchedTip])
      } catch (err) {
        workerLogError(
          `Base branch workspace (${ctx.baseBranch}) failed to fast-forward (diverged local history?): ${getErrorMessage(err)}`,
        )
        return {
          outcome: 'failed',
          // [REDACT] Served to the browser by the admin panel.
          message: redactCredentials(`failed to fast-forward: ${getErrorMessage(err)}`),
          trackedCanopyMeta,
        }
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
    if (trackedCanopyMeta && behindCount > 0) {
      const stillTracked = await listTrackedCanopyState(baseGit)
      trackedCanopyMeta =
        stillTracked.length > 0 ? stillTracked.slice(0, MAX_REPORTED_PATHS) : undefined
    }
    return { outcome: behindCount > 0 ? 'refreshed' : 'up-to-date', trackedCanopyMeta }
  } catch (err) {
    workerLogError(
      `Base branch workspace (${ctx.baseBranch}) refresh failed: ${getErrorMessage(err)}`,
    )
    // [REDACT] Served to the browser by the admin panel.
    return {
      outcome: 'failed',
      message: redactCredentials(getErrorMessage(err)),
      trackedCanopyMeta,
    }
  } finally {
    if (releaseContentLock) {
      await releaseContentLock().catch((err: unknown) => {
        workerLogWarn(
          `Base branch workspace (${ctx.baseBranch}): failed to release content-write lock: ${getErrorMessage(err)}`,
        )
      })
    }
    if (releaseProvisioning) {
      await releaseProvisionedWorkspace(releaseProvisioning, ctx.sanitizedBaseBranch)
    }
  }
}
