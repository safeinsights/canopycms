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

/**
 * A reviewer's verdict on the branch as last submitted, shown in the pull request body
 * (submission-attribution.ts). Set by approve and request-changes, cleared by submit and
 * withdraw, and never sent to clients: `by` names the reviewer.
 */
export interface BranchReview {
  state: 'approved' | 'changes-requested'
  by: { userId: CanopyUserId; name?: string }
  /** ISO timestamp of the verdict. */
  at: string
}

/** What keeps a pull request behind its base. `base` is the branch GitHub says it targets now. */
export type PullRequestHold = { kind: 'conflicts' } | { kind: 'retargeted'; base: string }

/** What the editor tells a branch's viewers is stuck, and needs a person. */
export type BranchHold =
  | PullRequestHold
  | { kind: 'rewritten' }
  /** `opened`: a pull request exists, from an earlier submit. */
  | { kind: 'submit-unfinished'; opened: boolean }

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
  /**
   * ISO timestamp of the branch's latest submit. A queued PR task carries it, so the worker's
   * failure handling acts only on the submit that queued it.
   */
  submittedAt?: string
  /**
   * ISO timestamp of the CMS's latest push of this branch to GitHub: a worker push GitHub
   * accepted, or a direct-path submit. Branch delete takes it as
   * proof that a same-named GitHub branch is this branch's, since a submit whose PR GitHub refused
   * leaves no PR number. Absent on branches the CMS never pushed there.
   */
  pushedToGitHubAt?: string
  /**
   * The latest editor URL a submit took from its request (editor-url.ts); a submit that took
   * none, or used config.editorUrl, leaves it as it was. A comment change re-renders the PR's
   * comment summary with config.editorUrl or this, so a commenter never supplies the links.
   */
  editorUrl?: string
  /** Sync status for async GitHub operations (used when Lambda has no internet) */
  syncStatus?: SyncStatus
  /** Whether any rebase of this branch kept its version of an entry base also changed */
  conflictStatus?: ConflictStatus
  /** ContentIds of the entries where a rebase kept the branch's version; cleared when it merges */
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
   * The newest commit this deployment knows GitHub's branch holds, or will once a queued push of
   * a rewrite lands: the last one it pushed, took in or published. A tip that no longer contains
   * it was rewritten on GitHub, so it is not merged, which could restore what someone removed
   * (worker/github-commits.ts).
   */
  lastGitHubTip?: string
  /**
   * Repo-relative paths where a merge of GitHub's commits kept this branch's version over theirs.
   * The PR body lists them, since the person whose change was replaced is not in the editor.
   */
  keptOverGitHub?: string[]
  /**
   * The commit GitHub's branch held and no longer contains, set while a rewrite there stands
   * unresolved. The worker pushes nothing for this branch until GitHub's tip contains a commit
   * it is known to have held, or GitHub no longer has the branch.
   */
  rewrittenOnGitHub?: string
  /**
   * The last submit failed, so its pull request step hasn't run. Only a retry of that task or a new
   * submit runs it, so nothing else clears the failed sync while the branch is in review.
   */
  submitUnfinished?: boolean
  /**
   * What GitHub reports keeps this branch's open pull request from being updated from its base,
   * as of the worker's last read while the branch was in review. Read only while it still is.
   */
  pullRequestHold?: PullRequestHold
  /**
   * Short, sanitized reason the last GitHub sync failed, set alongside
   * `syncStatus: 'sync-failed'` by the worker's updateBranchMetadataOnFailure or a
   * direct-path submit -- e.g. a non-fast-forward push rejection naming the branch.
   * Shown on the branch's row in the editor. Reset to undefined by the next submit
   * and the next successful sync task, so a stale reason never outlives it.
   */
  syncFailureReason?: string
  /**
   * Every user whose successful change to the branch's working tree is recorded, in first-save
   * order (recordBranchEditor in branch-metadata.ts). Never reset, because each submit rebuilds
   * the whole PR body and credits them all. User ids only: names are looked up at submit.
   */
  editors?: CanopyUserId[]
  /** The `editors` who saved since the last submit commit; the next one's trailers name them. */
  uncommittedEditors?: CanopyUserId[]
  /** The reviewer's verdict on the last submit; absent until a reviewer acts. */
  review?: BranchReview
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
 * Why listing an unpublishable branch in `legacyBranches` would not publish it.
 * `blocks-namespace`: it is named after part of the namespace, so while it exists neither
 * remote.git nor GitHub holds a branch in the namespace. `unlistable`: `legacyBranches` refuses
 * its name. The report lists branch workspaces only, read from their branch.json: a blocker that
 * exists only on GitHub is never listed, even after `reconcileTrackedBranches` brings it into
 * remote.git.
 */
export type UnpublishableBranchReason = 'blocks-namespace' | 'unlistable'

/** A branch the GitHub gateway will not publish, by ref. */
export interface UnpublishableBranch {
  name: string
  /**
   * Absent when neither applies: a `legacyBranches` entry would then publish it unless it is
   * protected, by `protectedBranches`, as the base branch, or as GitHub's default branch.
   */
  reason?: UnpublishableBranchReason
}

/**
 * Branches the GitHub gateway will not publish: at most 50 `branches`, of `count` in all, as of
 * `at` (ISO).
 */
export interface UnpublishableBranchesReport {
  branches: UnpublishableBranch[]
  count: number
  at: string
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
     * tips, never moving a head the worker finds editor work in (worker/git-sync.ts's
     * `reconcileTrackedBranches`, worker/stale-mirror.ts).
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
      /**
       * Optional for the same reason. Heads that diverged while holding no editor
       * work, moved to GitHub's tip, and heads of branches GitHub no longer has,
       * deleted (worker/stale-mirror.ts).
       */
      repointed?: string[]
      pruned?: string[]
    }
  }
  lastFatalError?: {
    message: string
    at: string
    phase: 'startup' | 'run'
    /**
     * `startedAt` of the worker that recorded it. Equal to the snapshot's own `startedAt` until a
     * newer worker carries the failure forward. Optional: older workers do not write it.
     */
    workerStartedAt?: string
  }
  /**
   * The branch namespace the GitHub gateway writes, as of the last git sync that could ask it.
   * System health compares it with the namespace the CMS creates branches in.
   */
  gatewayBranchNamespace?: string
  /**
   * The exact names the GitHub gateway protects, its base branch among them, as of the same sync.
   * Branch creation refuses a short name equal to one.
   */
  gatewayProtectedBranches?: string[]
  /**
   * Editor branches the GitHub gateway will not publish, as of the last git sync that could ask
   * it; absent when there are none (worker/unpublishable-branches.ts). Carried into a restarted
   * worker's first snapshot.
   */
  unpublishableBranches?: UnpublishableBranchesReport
  /**
   * Present while the schema gate holds the base branch, and on the cycle a hold expires. Carried
   * into a restarted worker's first snapshot, so the bound survives restarts.
   */
  baseHold?: BaseSchemaHold
  /**
   * How the last worker that ran stopped, carried into each new worker's snapshot
   * (task-queue/worker-status.ts's `readCarriedOverStatus`). A worker that fails at startup
   * leaves it alone and records the failure as `lastFatalError`.
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
