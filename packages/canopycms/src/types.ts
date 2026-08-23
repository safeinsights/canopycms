import type { ContentId } from './paths/types'

export type CanopyUserId = string
export type CanopyGroupId = string

/**
 * Branch workflow state. Anything other than 'editing' locks content writes --
 * see authorization/protected-branch.ts `writeBlocked`, the single place that
 * rule is expressed.
 *
 * There is deliberately no separate 'locked' state: 'submitted' already means
 * "locked while a reviewer looks at the PR", and request-changes/withdraw are
 * the unlocks. A future admin-freeze feature should reintroduce a status only
 * alongside real semantics (worker rebase skip list, a set/unset endpoint, UI).
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
   * Lifecycle state of the branch's PR as last observed by the worker's
   * merge-poll (or verified by markAsMerged). Absent until a PR exists and
   * has been observed. Draft PRs read 'open'.
   */
  pullRequestState?: PullRequestState
  /**
   * ISO timestamp stamped when the branch was archived because its PR
   * merged (worker auto-poll or manual markAsMerged). Absent for branches
   * archived any other way.
   */
  mergedAt?: string
  /**
   * Set by the worker when a rebase cycle fails for this branch; cleared on
   * the next successful cycle (and on submit). firstAt survives repeated
   * failures with the same message so the panel can show "failing since".
   */
  rebaseFailure?: { message: string; firstAt: string; lastAt: string }
  /**
   * Set by the worker's rebase loop when it rewrote history this deployment
   * had ALREADY published: the commit `remote.git` (and therefore GitHub)
   * held for this branch, which the rebase replaced.
   *
   * Used as the `--force-with-lease` expected value on both hops, so a forced
   * push can only ever move a ref off the exact commit our own rebase rewrote
   * away -- never over anyone else's work.
   *
   * Set once per rewrite episode and never advanced while still set: across
   * two rebases before any push lands, GitHub still holds the ORIGINAL
   * commit, so advancing the marker would aim the lease at a commit GitHub
   * never had. Cleared only once GitHub is confirmed to hold something else
   * (CmsWorker.pushBranchToGitHub) -- while it is set, it is the sole trigger
   * for the rebase loop's self-heal pass.
   */
  historyRewrittenFrom?: string
  /**
   * Short, sanitized reason the worker's last GitHub sync task failed
   * permanently (set alongside `syncStatus: 'sync-failed'` by
   * CmsWorker.updateBranchMetadataOnFailure) -- e.g. a non-fast-forward push
   * rejection naming the branch. Absent until a task has failed permanently.
   * Cleared on the next successful sync task (CmsWorker.updateBranchMetadata
   * explicitly resets it to undefined) so a stale reason never survives a
   * later successful push.
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
 * Wire shape of the worker's self-reported status file (worker-status.json,
 * written under the task queue dir). Written by the CmsWorker daemon
 * (PR-W1); this type is read-only here — GET /admin/status parses it as-is.
 */
export interface WorkerStatusReport {
  version: 1
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
     * [SYNC-C1] Branches skipped because a content write held the branch's
     * cross-host content-write lock (utils/content-write-lock.ts) -- the
     * worker yields and retries next cycle.
     *
     * Optional for the same reason as `tracked` below: absent from a
     * worker-status.json written by a worker predating that lock. Readers must
     * tolerate its absence.
     */
    skippedLocked?: string[]
    failed: { branch: string; error: string }[]
    /**
     * Outcome of reconciling remote.git's `refs/heads/*` against GitHub's
     * fetched tips (worker/git-sync.ts's `reconcileTrackedBranches`) --
     * the non-destructive replacement for the old fetch refspec that used
     * to write GitHub's refs directly into `refs/heads/*`.
     */
    /**
     * Optional: absent from a worker-status.json written by a worker that
     * predates the tracked-branch reconcile (PR #168). Readers must tolerate
     * its absence rather than assume every status file has it.
     */
    tracked?: {
      created: string[]
      fastForwarded: string[]
      ahead: string[]
      diverged: string[]
      /**
       * Optional for the same reason as `tracked` itself: absent from a
       * status file written before the rebase loop began publishing rewritten
       * history. Branches here diverged from GitHub because THIS worker
       * rebased them and the GitHub push is still queued -- expected and
       * self-resolving, unlike `diverged`.
       */
      rewritten?: string[]
    }
  }
  lastFatalError?: { message: string; at: string; phase: 'startup' | 'run' }
}
