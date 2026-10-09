import type { ContentId } from './paths/types'

export type CanopyUserId = string
export type CanopyGroupId = string

/**
 * Branch workflow state. Anything other than 'editing' locks content writes --
 * see authorization/protected-branch.ts `writeBlocked`, the single place that
 * rule is expressed.
 *
 * There is deliberately no separate 'locked' state: 'submitted' already means
 * "locked while the PR is under review", with request-changes/withdraw as the
 * unlocks. A future admin-freeze feature should add a status only alongside real
 * semantics (worker rebase skip list, a set/unset endpoint, UI).
 */
export type BranchStatus = 'editing' | 'submitted' | 'approved' | 'archived'
export type SyncStatus = 'synced' | 'pending-sync' | 'sync-failed'
export type ConflictStatus = 'clean' | 'conflicts-detected'
export type PullRequestState = 'open' | 'closed' | 'merged'

export interface BranchAccessControl {
  allowedUsers?: CanopyUserId[]
  allowedGroups?: CanopyGroupId[]
  managerOrAdminAllowed?: boolean
}

export interface BranchMetadata {
  name: string
  title?: string
  description?: string
  status: BranchStatus
  access: BranchAccessControl
  createdBy: CanopyUserId
  createdAt: string
  updatedAt: string
  /** Fork point this branch was created from; recorded at creation, immutable. */
  baseBranch?: string
  pullRequestUrl?: string
  pullRequestNumber?: number
  /** Sync status for async GitHub operations (used when Lambda has no internet) */
  syncStatus?: SyncStatus
  /** Whether this branch has unresolved merge conflicts with the base branch */
  conflictStatus?: ConflictStatus
  /** ContentIds of entries where --theirs was applied during rebase; cleared on clean rebase */
  conflictFiles?: ContentId[]
  /**
   * Lifecycle state of the branch's PR as last observed by the worker's merge-poll
   * (or verified by markAsMerged). Absent until a PR exists and has been observed.
   * Draft PRs read 'open'.
   */
  pullRequestState?: PullRequestState
  /**
   * ISO timestamp stamped when the branch was archived because its PR merged
   * (worker auto-poll or markAsMerged). Absent for branches archived any other way.
   */
  mergedAt?: string
  /**
   * Set by the worker when a rebase cycle fails for this branch; cleared on
   * the next successful cycle (and on submit). firstAt survives repeated
   * failures with the same message so the panel can show "failing since".
   */
  rebaseFailure?: { message: string; firstAt: string; lastAt: string }
  /**
   * Set by the worker's rebase loop when it rewrote history this deployment had
   * ALREADY published: the commit `remote.git` (and therefore GitHub) held for
   * this branch, which the rebase replaced.
   *
   * It is the `--force-with-lease` expected value on both hops, so a forced push
   * can only move a ref off the exact commit our own rebase rewrote away, never
   * over anyone else's work.
   *
   * Set once per rewrite episode and never advanced while still set: across two
   * rebases before any push lands GitHub still holds the ORIGINAL commit, so
   * advancing the marker would aim the lease at a commit GitHub never had.
   * Cleared only once GitHub is confirmed to hold something else
   * (CmsWorker.pushBranchToGitHub); while set, it is the sole trigger for the
   * rebase loop's self-heal pass.
   */
  historyRewrittenFrom?: string
  /**
   * Short, sanitized reason the worker's last GitHub sync task failed permanently,
   * set alongside `syncStatus: 'sync-failed'` by
   * CmsWorker.updateBranchMetadataOnFailure -- e.g. a non-fast-forward push
   * rejection naming the branch. Absent until a task has failed permanently, and
   * reset to undefined by the next successful sync task, so a stale reason never
   * survives a later successful push.
   */
  syncFailureReason?: string
}

export interface BranchPaths {
  /** Root where all branches live (e.g., /mnt/efs/site, ~/.canopycms/branches) */
  baseRoot: string

  /** This branch's directory. Usually {baseRoot}/{branchName}, equals baseRoot in dev mode */
  branchRoot: string
}

export interface BranchContext extends BranchPaths {
  branch: BranchMetadata

  /** Per-branch flattened schema (lazy-loaded via getBranchContext with loadSchema: true) */
  flatSchema?: import('./config').FlatSchemaItem[]
}

/** BranchContext with guaranteed flatSchema (loaded via schema guard or loadSchema: true) */
export interface BranchContextWithSchema extends BranchContext {
  flatSchema: import('./config').FlatSchemaItem[]
}

/**
 * Outcome of the worker's per-cycle fast-forward of the base branch's own clone
 * (worker/git-sync.ts's `refreshBaseBranchWorkspace`); the rebase loop skips
 * that clone.
 */
export interface BaseRefreshReport {
  outcome:
    | 'refreshed'
    | 'up-to-date'
    | 'skipped-dirty'
    | 'skipped-locked'
    | 'skipped-not-provisioned'
    | 'failed'
  /** Tracked files blocking the refresh, at most 10; set when `skipped-dirty`. */
  dirtyFiles?: string[]
  /** What went wrong, credential-redacted; set when `failed` or `skipped-dirty`. */
  message?: string
  /**
   * Files under `.canopy-meta/` the adopter's repo tracks, at most 10. canopycms
   * rewrites that state per branch, so tracking it is an adopter misconfiguration
   * the panel surfaces with its fix, whatever the outcome.
   */
  trackedCanopyMeta?: string[]
}

/** What a running CMS process reports about the build it was started from. */
export interface BuildIdentity {
  /** canopycms package version this process runs. */
  canopycmsVersion: string
  /** Adopter source revision the deployed image was built from (CANOPY_SOURCE_SHA); absent when unset. */
  sourceRevision?: string
}

/**
 * The worker holding the base branch at its current tip because the incoming tip references
 * entry schemas the serving editor does not define (worker/schema-gate.ts).
 */
export interface BaseSchemaHold {
  /** The earliest of `firstSeen`. */
  since: string
  /** When each missing schema was first seen missing; the earliest bounds the hold. */
  firstSeen: Record<string, string>
  /** GitHub's base tip the worker is not advancing to. */
  incomingSha: string
  /** Schema names the incoming tip references and the serving editor's registry lacks. */
  missingSchemas: string[]
  /** `.collection.json` files referencing them, repo-relative, at most 10. */
  files: string[]
  /** How many files reference them, `files` being the first 10. */
  fileCount: number
  /** The build that recorded the registry the gate checked against. */
  editorBuild: BuildIdentity
  editorRecordedAt: string
  /** Set on the cycle the hold outlived its bound and the worker advanced anyway. */
  expired?: true
}

/**
 * Wire shape of the worker's self-reported status file (worker-status.json, under
 * the task queue dir), written by the CmsWorker daemon. Read-only here: GET
 * /admin/status parses it as-is.
 */
export interface WorkerStatusReport {
  version: 1
  /** canopycms version the worker runs. Optional: status files from older workers lack it. */
  workerVersion?: string
  startedAt: string
  updatedAt: string
  lastTaskCycleAt?: string
  lastGitSyncAt?: string
  lastGitSyncError?: { message: string; at: string }
  lastGitSync?: {
    durationMs: number
    rebased: string[]
    skippedDirty: string[]
    /**
     * Branches skipped because another process held a lock the worker
     * try-acquires: the [SYNC-C1] content-write lock (utils/content-write-lock.ts)
     * or the provisioning lock (worker/provisioned-workspace.ts). The worker
     * yields and retries next cycle. Optional for the same reason as `tracked`
     * below, and readers must tolerate its absence.
     */
    skippedLocked?: string[]
    failed: { branch: string; error: string }[]
    /** Optional for the same reason as `tracked` below. */
    baseRefresh?: BaseRefreshReport
    /**
     * Outcome of reconciling remote.git's `refs/heads/*` against GitHub's fetched
     * tips, non-destructively (worker/git-sync.ts's `reconcileTrackedBranches`).
     * Optional: a status file written by a worker without that reconcile has no
     * such key, and readers must tolerate its absence rather than assume every
     * status file has it.
     */
    tracked?: {
      created: string[]
      fastForwarded: string[]
      ahead: string[]
      diverged: string[]
      /**
       * Optional for the same reason as `tracked` itself. Branches here diverged
       * from GitHub because THIS worker rebased them and the GitHub push is still
       * queued -- expected and self-resolving, unlike `diverged`.
       */
      rewritten?: string[]
    }
  }
  lastFatalError?: { message: string; at: string; phase: 'startup' | 'run' }
  /**
   * Present while the schema gate holds the base branch, and on the cycle a hold expires. Carried
   * into a restarted worker's first snapshot, so the bound survives restarts.
   */
  baseHold?: BaseSchemaHold
  /**
   * How the previous worker stopped, carried into each new worker's snapshot
   * (task-queue/worker-status.ts's `readCarriedOverStatus`).
   */
  lastShutdown?: WorkerShutdownRecord
}

export interface WorkerShutdownRecord {
  /** Why the worker stopped, as its entrypoint described it (e.g. 'SIGTERM'). */
  reason: string
  at: string
  /** The stopped worker's `startedAt`, which ties the record to that worker. */
  workerStartedAt: string
  /**
   * `deadline`: in-flight work was still running at the drain deadline, and
   * `abandoned` names it. `not-drained`: the worker stopped without recording
   * a shutdown (a crash or a forced kill); `at` is its last status write.
   */
  outcome: 'drained' | 'deadline' | 'not-drained'
  drainMs?: number
  abandoned?: string[]
}
