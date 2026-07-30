import type { ContentId } from './paths/types'

export type CanopyUserId = string
export type CanopyGroupId = string

export type BranchStatus = 'editing' | 'submitted' | 'approved' | 'locked' | 'archived'
export type SyncStatus = 'synced' | 'pending-sync' | 'sync-failed'
export type ConflictStatus = 'clean' | 'conflicts-detected'
export type PullRequestState = 'open' | 'closed' | 'merged'

export interface BranchAccessControl {
  allowedUsers?: CanopyUserId[]
  allowedGroups?: CanopyGroupId[]
  managerOrAdminAllowed?: boolean
  adminOnly?: boolean
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
    failed: { branch: string; error: string }[]
    /**
     * Outcome of reconciling remote.git's `refs/heads/*` against GitHub's
     * fetched tips (worker/cms-worker.ts's `reconcileTrackedBranches`) --
     * the non-destructive replacement for the old fetch refspec that used
     * to write GitHub's refs directly into `refs/heads/*`.
     */
    tracked: {
      created: string[]
      fastForwarded: string[]
      ahead: string[]
      diverged: string[]
    }
  }
  lastFatalError?: { message: string; at: string; phase: 'startup' | 'run' }
}
