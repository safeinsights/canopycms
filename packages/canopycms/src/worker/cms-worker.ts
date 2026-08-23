import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import lockfile from 'proper-lockfile'
import { Octokit } from '@octokit/rest'
import { recoverOrphanedTasks, cleanupOldTasks, cmsTaskQueueLogger } from './task-queue'
import type { Task } from './task-queue'
import { createCanopyOctokit } from '../github-service'
import {
  getBranchMetadataFileManager,
  BranchMetadataFileManager,
  type BranchMetadataFile,
} from '../branch-metadata'
import { invalidateBranchContentCaches } from '../content-index-generation'
import { type SanitizedBranchName } from '../paths/types'
import { sanitizeBranchName, RESERVED_SETTINGS_BRANCH_PREFIX } from '../paths/branch-name'
import { GITHUB_TRACKING_REF_PREFIX, gitNetworkChildEnv } from '../git-manager'
import { resolveDeploymentName } from '../operating-mode/deployment-name'
import type { WorkerStatusReport } from '../types'
import { getErrorMessage, isNodeError, redactCredentials } from '../utils/error'
import { isNonFastForwardRejection } from '../utils/git'
import { writeWorkerStatus } from './worker-status'
import { workerLog, workerLogWarn, workerLogError } from './log'
import type { WorkerContext } from './worker-context'
import { hasPendingHistoryRewrite } from './history-rewrite'
import {
  executeTask,
  orphanRecoveryMaxAgeMs,
  processTaskQueue,
  pushBranchToGitHub,
  updateBranchMetadata,
} from './task-runner'
import { pollMergeState, runRebaseCycle, type RebaseSummary } from './rebase'

// Re-exported because this module is the package's advertised worker
// entrypoint (`canopycms/worker/cms-worker`) and both were exported from here
// before the task-queue cluster moved to ./task-runner. cms-worker.test.ts
// imports them from this path.
export { PermanentTaskError, isPermanentTaskFailure } from './task-runner'

// Re-exported so the AWS entrypoint (packages/canopycms-cdk/worker/index.ts)
// can prefix its own startup lines through the same helpers without adding a
// new package entrypoint - `canopycms/worker/cms-worker` already exists. Every
// line in worker.log must carry the timestamp prefix or it gets folded into
// the previous CloudWatch event; see ./log.ts.
export { workerLog, workerLogWarn, workerLogError, installWorkerLogger } from './log'

/**
 * Auth cache refresh function type.
 * Adopters provide their auth-plugin-specific implementation.
 * For Clerk: use refreshClerkCache from canopycms-auth-clerk/cache-writer.
 */
export type AuthCacheRefresher = () => Promise<void>

export interface CmsWorkerConfig {
  /** Path to workspace root on EFS (e.g., /mnt/efs/workspace) */
  workspacePath: string
  /** GitHub owner (e.g., 'safeinsights') */
  githubOwner: string
  /** GitHub repo name (e.g., 'docs-site') */
  githubRepo: string
  /** GitHub bot token for pushing and PR operations */
  githubToken: string
  /**
   * Auth cache refresh callback. Called periodically to update the auth
   * metadata cache on EFS. Adopters provide their auth-plugin-specific
   * implementation (e.g., refreshClerkCache from canopycms-auth-clerk).
   */
  refreshAuthCache?: AuthCacheRefresher
  /** Task queue poll interval in ms (default: 5000) */
  taskPollInterval?: number
  /** Git sync interval in ms (default: 5 * 60 * 1000) */
  gitSyncInterval?: number
  /** Auth cache refresh interval in ms (default: 15 * 60 * 1000) */
  authCacheRefreshInterval?: number
  /** Base branch name (default: 'main') */
  baseBranch?: string
  /**
   * Deployment name, used to compute THIS worker's own settings branch
   * (`canopycms-settings-{deploymentName}`, default: 'prod' — matches
   * ProdStrategy's mode default in operating-mode/client-unsafe-strategy.ts,
   * the only mode the worker runs in). Two deployments can share one GitHub
   * repo with distinct settings branches; this tells the worker which one it
   * owns, so it never pushes another deployment's settings branch (see
   * `pushSettingsBranches`).
   */
  deploymentName?: string
  /**
   * Explicit settings branch name, taking precedence over `deploymentName`.
   * Mirrors the strategy's own precedence (`config.settingsBranch` short-circuits
   * `getSettingsBranchName` before `deploymentName` is consulted, see
   * operating-mode/client-unsafe-strategy.ts): an adopter who overrides
   * `settingsBranch` in canopycms.config.ts must set this too, or the worker
   * would own a branch name the Lambda never writes to.
   */
  settingsBranch?: string
  /** Max tasks to process per cycle (default: 10) */
  maxTasksPerCycle?: number
  /** Per-task timeout in ms (default: 60000) */
  taskTimeoutMs?: number
  /** Max retries for failed tasks (default: 3) */
  maxRetries?: number
  /** Content root directory name relative to repo root (default: 'content') */
  contentRoot?: string
  /**
   * Worker lock staleness TTL in ms (default: 60000, minimum 2000).
   * The holder refreshes the lock heartbeat at half this interval; a lock
   * whose heartbeat is older than this is considered abandoned and taken
   * over by the next worker to start.
   */
  lockStaleMs?: number
}

const DEFAULT_TASK_TIMEOUT = 60_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_LOCK_STALE_MS = 60_000

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
interface TrackedBranchSummary {
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
 * CMS Worker daemon.
 * Handles operations that Lambda (with no internet) cannot perform:
 * - Processing queued tasks (push branches, create PRs)
 * - Syncing bare repo with GitHub
 * - Rebasing active branch workspaces
 * - Refreshing auth metadata cache (via pluggable callback)
 *
 * Auth-agnostic: does not depend on any specific auth provider.
 * Cloud-agnostic: uses git/Octokit directly, no AWS SDK dependency.
 */
export class CmsWorker {
  private octokit: Octokit
  private taskDir: string
  private remoteGitPath: string
  private contentBranchesPath: string
  private baseBranch: string
  // Workspace directories use sanitized names; git refs (fetch/rev-list/merge
  // against origin/<baseBranch>) must keep using the raw `baseBranch` name.
  // Computed once so both filesystem call sites (refreshBaseBranchWorkspace's
  // path.join and rebaseActiveBranches' skip comparison) agree, instead of
  // re-deriving it (and risking drift) at each use.
  private sanitizedBaseBranch: SanitizedBranchName
  // This deployment's own settings branch — see CmsWorkerConfig.deploymentName.
  // `pushSettingsBranches` pushes ONLY this branch, never any other
  // `canopycms-settings-*` branch it happens to find locally.
  //
  // Resolved lazily by ensureSettingsBranch(), NOT in the constructor: see that
  // method's doc comment. `undefined` here means "not resolved yet", never "no
  // settings branch".
  private settingsBranchResolved?: string
  private activeTimeouts = new Set<NodeJS.Timeout>()
  private running = false
  private activeOperations = new Set<Promise<void>>()
  private maxTasksPerCycle: number
  private taskTimeoutMs: number
  private maxRetries: number
  private lockFilePath: string
  private lockStaleMs: number
  private releaseLockFn: (() => Promise<void>) | null = null
  private contentRoot: string
  private log = cmsTaskQueueLogger
  // PR-W1: self-reported liveness/health snapshot, written to
  // worker-status.json. Normally initialized once at the top of start();
  // see ensureStatusReport() for the lazy-init fallback.
  private statusReport?: WorkerStatusReport

  constructor(private config: CmsWorkerConfig) {
    this.octokit = createCanopyOctokit({ auth: config.githubToken })
    this.taskDir = path.join(config.workspacePath, '.tasks')
    this.remoteGitPath = path.join(config.workspacePath, 'remote.git')
    this.contentBranchesPath = path.join(config.workspacePath, 'content-branches')
    this.baseBranch = config.baseBranch ?? 'main'
    this.sanitizedBaseBranch = sanitizeBranchName(this.baseBranch)
    this.maxTasksPerCycle = config.maxTasksPerCycle ?? 10
    this.taskTimeoutMs = config.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
    this.lockFilePath = path.join(config.workspacePath, '.tasks', '.worker-lock')
    this.lockStaleMs = config.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
    this.contentRoot = config.contentRoot ?? 'content'
  }

  /**
   * Lazily get (and initialize if necessary) this worker's self-reported
   * status object (PR-W1). Normally set once, up front, at the top of
   * start(). The lazy fallback here covers two cases: (1) something in
   * start() reaching a status-write point before that normal init runs
   * (defensive -- see start()'s catch), and (2) unit tests that exercise
   * syncGit()/processTaskQueue() directly without calling start() first.
   */
  private ensureStatusReport(): WorkerStatusReport {
    if (!this.statusReport) {
      const now = new Date().toISOString()
      this.statusReport = { version: 1, startedAt: now, updatedAt: now }
    }
    return this.statusReport
  }

  /**
   * Resolve this deployment's settings branch, throwing if the infra-stamped
   * deployment name is not a valid git ref component.
   *
   * Routed through the shared resolver, not a local `?? 'prod'`: it is the
   * single definition of the env > config > mode-default precedence the Lambda
   * already follows, and the only place the resolved value is validated.
   * Without it the worker could silently own a different settings branch than
   * the Lambda writing to the same workspace -- and pushSettingsBranches would
   * then report the real branch as foreign and never push it.
   *
   * DEFERRED out of the constructor deliberately, and this is the whole point
   * of the method existing. Resolving there made the throw land during `new
   * CmsWorker(...)` (canopycms-cdk/worker/index.ts constructs before it calls
   * start()), which is BEFORE the only code that writes `lastFatalError` --
   * start()'s catch. The result was billed as "a loud startup exit" but was
   * nothing of the kind: with systemd `Type=simple` + `Restart=always` and no
   * cfn-signal, an invalid deployment name produced an invisible ~5s
   * crash-loop that `cdk deploy` reported as success while the admin panel
   * showed the worker as 'absent' with no fatal error to explain it. Resolving
   * inside start()'s try block instead means the same throw is recorded to
   * worker-status.json and surfaces in the admin panel.
   *
   * Lazy rather than start()-only so the value is still available to unit tests
   * that drive pushSettingsBranches() directly without calling start() -- the
   * same reason ensureStatusReport() above is shaped this way. Idempotent: the
   * resolver is pure, so a later call returns the identical string.
   */
  private ensureSettingsBranch(): string {
    if (this.settingsBranchResolved === undefined) {
      this.settingsBranchResolved =
        this.config.settingsBranch ??
        `${RESERVED_SETTINGS_BRANCH_PREFIX}${resolveDeploymentName({ deploymentName: this.config.deploymentName }, 'prod')}`
    }
    return this.settingsBranchResolved
  }

  /**
   * Build the {@link WorkerContext} handed to the extracted clusters
   * (task-runner.ts, git-sync.ts, rebase.ts, history-rewrite.ts).
   *
   * Built FRESH on every call rather than once in the constructor, and the
   * instance-backed members are functions rather than copied values. Both
   * choices exist for the same reason: the test suite drives this class by
   * replacing `octokit` and `buildGitHubUrl` ON THE INSTANCE, by setting
   * `running` directly, and by subclassing to override the two rebase test
   * hooks. A context that captured any of those at construction time would hand
   * the extracted code the pre-test value -- which for `buildGitHubUrl` means a
   * test's push going to github.com for real instead of its local fixture repo.
   * See WorkerContext's doc comment for the full list.
   */
  private ctx(): WorkerContext {
    return {
      githubOwner: this.config.githubOwner,
      githubRepo: this.config.githubRepo,
      baseBranch: this.baseBranch,
      sanitizedBaseBranch: this.sanitizedBaseBranch,
      taskDir: this.taskDir,
      remoteGitPath: this.remoteGitPath,
      contentBranchesPath: this.contentBranchesPath,
      contentRoot: this.contentRoot,
      taskTimeoutMs: this.taskTimeoutMs,
      maxTasksPerCycle: this.maxTasksPerCycle,
      maxRetries: this.maxRetries,
      log: this.log,
      octokit: () => this.octokit,
      buildGitHubUrl: () => this.buildGitHubUrl(),
      branchWorkspacePath: (branchRefName) => this.branchWorkspacePath(branchRefName),
      executeTask: (task, signal) => this.executeTask(task, signal),
      pushBranchToGitHub: (branch) => this.pushBranchToGitHub(branch),
      isRunning: () => this.running,
      ensureStatusReport: () => this.ensureStatusReport(),
      ensureSettingsBranch: () => this.ensureSettingsBranch(),
      afterConflictDetectedForTesting: () => this.afterConflictDetectedForTesting(),
      afterRebaseCompletedForTesting: () => this.afterRebaseCompletedForTesting(),
    }
  }

  async start(): Promise<void> {
    this.running = true
    workerLog('CMS Worker starting...')
    this.ensureStatusReport()

    // Acquire lock to prevent concurrent workers
    await this.acquireLock()

    // Everything below runs while holding the cross-host worker lock. A
    // failure here (most notably the empty-remote guard inside
    // ensureRemoteGit) means the process is about to exit, and systemd
    // (Restart=always) will retry — but a still-held lock would make every
    // retry fail with ELOCKED for up to lockStaleMs. Release before
    // rethrowing so the next start() (this process's retry, or another host)
    // can acquire immediately. We deliberately do NOT reorder ensureRemoteGit
    // ahead of acquireLock: two hosts cold-starting at once would then both
    // race to `git clone --bare` into the same remoteGitPath (the same class
    // of race that acquireProvisioningLock guards against for workspace
    // clones elsewhere) — acquiring the lock first is what already
    // serializes that.
    try {
      // FIRST inside the try, before any I/O: an infra-stamped deployment name
      // that is not a valid git ref component throws here, where the catch
      // below records it to worker-status.json. Resolving it in the
      // constructor (as this used to) put the throw outside every
      // status-writing path -- see ensureSettingsBranch()'s doc comment.
      this.ensureSettingsBranch()

      // Ensure remote.git exists (init bare repo if first run)
      await this.ensureRemoteGit()

      // Recover any orphaned tasks from a previous crash, immediately rather
      // than waiting for the first processTaskQueue() poll (taskPollInterval,
      // default 5s) to run it. Not the only call site any more -
      // processTaskQueue() below now repeats this on every cycle; see its
      // doc comment for why a boot-only call is insufficient once the
      // worker's ASG rolls on every `cdk deploy` (CanopyCmsService's
      // UpdatePolicy).
      const recovered = await recoverOrphanedTasks(
        this.taskDir,
        orphanRecoveryMaxAgeMs(this.ctx()),
        this.log,
      )
      if (recovered > 0) {
        workerLog(`Recovered ${recovered} orphaned task(s)`)
      }

      // Run initial sync + cache refresh immediately
      const initialTasks: Promise<void>[] = [this.syncGit()]
      if (this.config.refreshAuthCache) {
        initialTasks.push(this.refreshAuthCache())
      }
      await Promise.allSettled(initialTasks)
    } catch (err) {
      // PR-W1: surface a startup failure (e.g. the empty-remote guard's
      // poisoned remote.git) to the admin panel via worker-status.json,
      // not only journald/CloudWatch. Best-effort and BEFORE releaseLock():
      // a status-write failure must never block releasing the lock.
      const report = this.ensureStatusReport()
      report.lastFatalError = {
        // [REDACT] Persisted to worker-status.json and served to the
        // browser by the admin panel -- must never carry the bot token
        // that a poisoned/failed git URL (buildGitHubUrl()) can embed.
        message: redactCredentials(getErrorMessage(err)),
        at: new Date().toISOString(),
        phase: 'startup',
      }
      try {
        await writeWorkerStatus(this.taskDir, report)
      } catch (writeErr) {
        workerLogError(
          'Failed to write worker status on startup failure:',
          getErrorMessage(writeErr),
        )
      }
      await this.releaseLock()
      throw err
    }

    // Start recurring task loops using setTimeout chaining
    // (avoids setInterval overlap when tasks take longer than the interval)
    const taskInterval = this.config.taskPollInterval ?? 5_000
    const gitInterval = this.config.gitSyncInterval ?? 5 * 60_000

    this.scheduleLoop(() => this.processTaskQueue(), taskInterval)
    this.scheduleLoop(() => this.syncGit(), gitInterval)

    if (this.config.refreshAuthCache) {
      const cacheInterval = this.config.authCacheRefreshInterval ?? 15 * 60_000
      this.scheduleLoop(() => this.refreshAuthCache(), cacheInterval)
      workerLog(`  Auth cache refresh: every ${cacheInterval / 1000}s`)
    }

    workerLog('CMS Worker started')
    workerLog(`  Task queue poll: every ${taskInterval / 1000}s`)
    workerLog(`  Git sync: every ${gitInterval / 1000}s`)
  }

  async stop(): Promise<void> {
    this.running = false
    for (const t of this.activeTimeouts) {
      clearTimeout(t)
    }
    this.activeTimeouts.clear()
    // Wait for all in-flight operations to complete (up to taskTimeoutMs)
    let drainTimer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.allSettled([...this.activeOperations]),
      new Promise<void>((r) => {
        drainTimer = setTimeout(r, this.taskTimeoutMs)
      }),
    ])
    clearTimeout(drainTimer)
    await this.releaseLock()
    workerLog('CMS Worker stopped')
  }

  /**
   * Acquire the cross-host worker lock (DEP-C2).
   *
   * The task queue is single-consumer (see task-queue/task-queue.ts): two
   * concurrent workers would double-process tasks (duplicate pushes, duplicate
   * PRs). The workspace lives on a shared filesystem (EFS), so mutual
   * exclusion must be sound ACROSS HOSTS — a PID liveness probe
   * (`process.kill(pid, 0)`) only means something on the holder's own machine
   * and must never participate in staleness decisions.
   *
   * proper-lockfile provides a heartbeat lease with no PID involved: the lock
   * is a directory created atomically (mkdir — atomic on NFS/EFS), the holder
   * refreshes its mtime every lockStaleMs/2, and the lock is considered
   * abandoned — and taken over — only when that heartbeat is older than
   * lockStaleMs. Liveness is judged purely by heartbeat freshness.
   *
   * No acquire retries: a second worker exits immediately, matching daemon
   * semantics (the supervisor restarts it later). After a crash, the dead
   * holder's heartbeat expires within lockStaleMs and the next start succeeds.
   *
   * Staleness is judged by comparing the lock's mtime against the local
   * clock, so correct cross-host takeover assumes reasonable clock agreement
   * between hosts (e.g. NTP); with the default TTL, ordinary clock skew is
   * negligible, but a host with a badly wrong clock could misjudge liveness.
   */
  private async acquireLock(): Promise<void> {
    await fs.mkdir(this.taskDir, { recursive: true })
    try {
      this.releaseLockFn = await lockfile.lock(this.taskDir, {
        lockfilePath: this.lockFilePath,
        stale: this.lockStaleMs,
        onCompromised: (err) => {
          // Our heartbeat could not be maintained (lock deleted or taken
          // over). Another worker may now be consuming the queue — stop
          // processing to preserve the single-consumer invariant.
          workerLogError('Worker lock compromised, shutting down:', getErrorMessage(err))
          this.releaseLockFn = null // the lock is already lost; nothing to release
          void this.stop()
        },
      })
    } catch (err) {
      if (isNodeError(err) && err.code === 'ELOCKED') {
        throw new Error(
          `Another worker is running (lock ${this.lockFilePath} has a heartbeat fresher than ${this.lockStaleMs}ms). Exiting.`,
        )
      }
      throw err
    }
  }

  private async releaseLock(): Promise<void> {
    const release = this.releaseLockFn
    this.releaseLockFn = null
    if (!release) return
    try {
      await release()
    } catch {
      // Lock already released or compromised
    }
  }

  /**
   * Schedule a function to run repeatedly with setTimeout chaining.
   * The next invocation starts `interval` ms after the previous one completes,
   * preventing overlapping executions.
   */
  private scheduleLoop(fn: () => Promise<void>, interval: number): void {
    const run = () => {
      if (!this.running) return
      const timeout = setTimeout(async () => {
        this.activeTimeouts.delete(timeout)
        const operation = fn().catch((err) => {
          workerLogError('Worker loop error:', err instanceof Error ? err.message : err)
        })
        this.activeOperations.add(operation)
        operation.finally(() => this.activeOperations.delete(operation))
        await operation
        run()
      }, interval)
      this.activeTimeouts.add(timeout)
    }
    run()
  }

  /**
   * Whether the bare repo at `gitDir` has a local `refs/heads/<baseBranch>`.
   *
   * Uses an explicit `--git-dir` invocation rather than `simpleGit({ baseDir
   * })` so this also works in sandboxed/CI git environments that set
   * `safe.bareRepository=explicit` (which refuses cwd-based discovery of
   * bare repos but expressly allows `--git-dir` — see
   * GitManager.bareRemoteHasBranch for the same pattern).
   *
   * Deliberately omits `--quiet`: simple-git only treats a task as failed
   * when the process both exits non-zero AND writes to stderr
   * (isTaskError), so a quiet, silent-on-failure `--verify` would leave a
   * missing branch indistinguishable from success. Without `--quiet`,
   * `rev-parse --verify` writes its "fatal: ..." to stderr on failure, which
   * is what makes simple-git reject the promise here.
   */
  private async verifyBaseBranchExists(gitDir: string): Promise<void> {
    await simpleGit().raw([
      '--git-dir',
      gitDir,
      'rev-parse',
      '--verify',
      `refs/heads/${this.baseBranch}`,
    ])
  }

  /**
   * Guarantee a bare repo's config carries NO `remote.origin.url`, and so no
   * embedded bot token.
   *
   * `git clone https://x-access-token:<token>@github.com/...` records that URL
   * verbatim as `remote.origin.url`, and for `remote.git` that config lives on
   * shared EFS. The security model in docs/deploying-to-aws.md -- "If Lambda is
   * compromised, an attacker can read/write content on EFS but cannot push to
   * GitHub", "Secrets stay on the worker" -- is false while that string is
   * there: a compromised Lambda could read the token off EFS and, despite
   * having no egress of its own, exfiltrate it by writing it into branch
   * content the worker then pushes to GitHub.
   *
   * Nothing needs the remote: every push passes the URL explicitly as an
   * argument (see the `git.push(this.buildGitHubUrl(), ...)` call sites), and
   * `verifyBaseBranchExists` reads local refs.
   *
   * VERIFIES rather than assuming: it re-reads the config and throws if the URL
   * survives, because the previous code's `.catch(() => {})` meant a failed
   * scrub was indistinguishable from a successful one.
   */
  private async scrubPersistedRemote(gitDir: string): Promise<void> {
    const git = simpleGit({ baseDir: gitDir })
    // `git config --get` exits 1 with no output when the key is absent.
    // simple-git does NOT reliably throw on that -- verified against
    // simple-git 3.36: it resolves with an empty string -- so an empty result
    // must be read as "absent" too. Treating "" as a surviving URL is what
    // made the first version of this reject every clean scrub.
    //
    // 'unreadable' is deliberately distinct from 'absent'. A read that fails
    // for any OTHER reason must not be mistaken for "no token here": that
    // would let the pre-check below short-circuit and skip the scrub entirely,
    // silently leaving a token-bearing config on shared EFS -- the exact
    // outcome this function exists to prevent. Fail closed and attempt the
    // removal instead.
    const readOriginUrl = async (): Promise<string | null | 'unreadable'> => {
      try {
        const url = (await git.raw(['config', '--get', 'remote.origin.url'])).trim()
        return url === '' ? null : url
      } catch {
        // ANY throw is 'unreadable', never 'absent'. The genuinely-absent case
        // does not reach here at all -- simple-git resolves with '' (verified
        // against 3.36: it only treats a task as failed when stderr is
        // non-empty, and a missing key writes nothing to stderr). So a throw
        // means something actually went wrong, and mapping that to "no token
        // here" would be the one fail-OPEN reading available.
        //
        // An earlier version tried to classify git's exit-1 "key not found"
        // from the message text. That was dead code -- simple-git's GitError
        // message is raw stdout+stderr with no exit-code text -- and its
        // empty-message fallback mapped a hypothetical throw to 'absent',
        // which is exactly the direction this must not fail.
        return 'unreadable'
      }
    }

    const before = await readOriginUrl()
    if (before === null) return
    if (before === 'unreadable') {
      workerLogWarn(
        `  Could not read remote.origin.url in ${gitDir}; attempting the scrub anyway rather than assuming it is absent`,
      )
    }

    try {
      await git.removeRemote('origin')
    } catch (err: unknown) {
      // Reached only from the 'unreadable' path, where the remote may in fact
      // not exist. Let the verification below decide rather than failing here:
      // it is the authoritative check, and it fails closed.
      workerLogWarn(
        `  removeRemote('origin') failed in ${gitDir}: ${getErrorMessage(err)} -- verifying directly`,
      )
    }

    // Fails closed on BOTH a surviving URL and an unverifiable read: if we
    // cannot prove the token is gone from shared storage, we do not proceed.
    const remaining = await readOriginUrl()
    if (remaining !== null) {
      throw new Error(
        `Could not confirm the 'origin' remote is gone from ${gitDir} (${
          remaining === 'unreadable'
            ? 'its config was unreadable'
            : 'its config still records a URL'
        }). For a token-bearing clone URL that means the GitHub bot token may be persisted on ` +
          `shared storage. Refusing to continue.`,
      )
    }
  }

  /**
   * Ensure remote.git bare repo exists.
   * On first run, clone from GitHub as a bare repo.
   *
   * Empty-remote guard: simple-git's bare clone of an EMPTY GitHub repo (no
   * commits, or a base branch that's never been pushed) exits 0 and produces
   * a refs-less bare repo — HEAD points at an unborn branch. `fs.stat`
   * cannot distinguish this from a healthy clone, so left unchecked it
   * silently poisons remote.git: every later branch operation (Lambda-side
   * clone provisioning, worker pushes) breaks, and the fs.stat short-circuit
   * means it never heals on its own. We verify the base branch exists right
   * after cloning and again on the already-exists fast path, since a
   * previous run could have left a poisoned remote.git behind before this
   * guard existed.
   */
  private async ensureRemoteGit(): Promise<void> {
    let exists: boolean
    try {
      await fs.stat(this.remoteGitPath)
      exists = true
    } catch {
      exists = false
    }

    if (exists) {
      // SELF-HEAL, before anything else touches this repo. The previous
      // already-exists path fast-returned without ever re-checking the config,
      // so a token that survived one scrub survived forever -- and a clone
      // interrupted by SIGKILL/power-off between `git clone` and the scrub left
      // a repo whose config already held the token, which additionally hit the
      // "delete remote.git and restart" refusal below and so sat on EFS until
      // an operator acted.
      await this.scrubPersistedRemote(this.remoteGitPath)

      try {
        await this.verifyBaseBranchExists(this.remoteGitPath)
      } catch (err) {
        workerLogError(`remote.git base branch verification failed: ${getErrorMessage(err)}`)
        // Do NOT auto-delete: an existing remote.git could hold unpushed
        // canopycms-settings-* branches or other state worth preserving.
        // Deletion here is the operator's call, not ours.
        throw new Error(
          `remote.git at ${this.remoteGitPath} has no branch '${this.baseBranch}' (likely cloned while the GitHub repo was empty). Delete ${this.remoteGitPath} and restart the worker to re-clone.`,
        )
      }
      return // Already exists and has the base branch
    }

    workerLog('Initializing remote.git from GitHub...')
    const git = simpleGit()

    // Clone under a TEMP name and rename into place only once the token has
    // been scrubbed and the repo verified, so `remote.git` never exists on EFS
    // in a token-bearing state. A crash mid-clone now leaves only this staging
    // directory, which the next boot deletes -- rather than a poisoned
    // `remote.git` that fs.stat cannot distinguish from a healthy one.
    const stagingPath = `${this.remoteGitPath}.cloning`
    await fs.rm(stagingPath, { recursive: true, force: true })

    try {
      await git.clone(this.buildGitHubUrl(), stagingPath, ['--bare'])

      // Before the rename, so the token is gone from the config the moment the
      // repo becomes reachable under its real name. Throws (rather than
      // swallowing) if the scrub does not take.
      await this.scrubPersistedRemote(stagingPath)

      await this.verifyBaseBranchExists(stagingPath)
    } catch (err) {
      workerLogError(`remote.git clone failed: ${redactCredentials(getErrorMessage(err))}`)
      // Deleting before throwing is what makes this recoverable: the next
      // start() sees no remote.git and re-clones, instead of being stuck
      // forever behind a poisoned bare repo that fs.stat alone can't detect.
      await fs.rm(stagingPath, { recursive: true, force: true })
      throw new Error(
        `remote.git clone of ${this.config.githubOwner}/${this.config.githubRepo} failed or has no branch '${this.baseBranch}' - the GitHub repository may be empty, or the base branch may not exist. Push an initial commit to '${this.baseBranch}' and restart the worker (systemd will retry automatically).`,
      )
    }

    await fs.rename(stagingPath, this.remoteGitPath)
    workerLog('remote.git initialized')
  }

  // --- Task-queue cluster (worker/task-runner.ts) ------------------------
  //
  // Thin delegators, not just a convenience: `processTaskQueue` is the public
  // loop entry `scheduleLoop` drives, and the three below it are reached by
  // cms-worker.test.ts through the instance (it calls `executeTask` and
  // `updateBranchMetadata` directly, and `pushBranchToGitHub` after replacing
  // `buildGitHubUrl` on the instance to aim the push at a local fixture repo).
  // Routing through `this.ctx()` is what keeps that replacement visible to the
  // extracted code -- see WorkerContext's doc comment.

  async processTaskQueue(): Promise<void> {
    return processTaskQueue(this.ctx())
  }

  private async executeTask(task: Task, signal: AbortSignal): Promise<Record<string, unknown>> {
    return executeTask(this.ctx(), task, signal)
  }

  private async updateBranchMetadata(task: Task, result: Record<string, unknown>): Promise<void> {
    return updateBranchMetadata(this.ctx(), task, result)
  }

  private async pushBranchToGitHub(branch: string): Promise<void> {
    return pushBranchToGitHub(this.ctx(), branch)
  }

  private buildGitHubUrl(): string {
    return `https://x-access-token:${this.config.githubToken}@github.com/${this.config.githubOwner}/${this.config.githubRepo}.git`
  }

  /**
   * The workspace directory for a branch named by its GIT REF name -- the
   * form task payloads carry (`context.branch.name`), not the directory form.
   *
   * These differ for any name outside `[A-Za-z0-9._-]`, `/` being the obvious
   * one: workspaces are provisioned under `sanitizeBranchName(...)` (see
   * paths/branch.ts's `resolveBranchPaths`), so `feature/x` lives in
   * `feature-x`. Joining the raw name instead silently addresses a directory
   * that does not exist -- which for the metadata writers below meant the
   * update was quietly dropped, and for the leased push meant the
   * history-rewrite marker read as absent and the push went out unleased,
   * wedging exactly the branch this workstream exists to unwedge.
   *
   * `name` inside the metadata itself stays the raw ref name; only the path
   * is sanitized.
   */
  private branchWorkspacePath(branchRefName: string): string {
    return path.join(this.contentBranchesPath, sanitizeBranchName(branchRefName))
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
  private async pushSettingsBranches(
    git: ReturnType<typeof simpleGit>,
    trackedNames: ReadonlySet<string>,
  ): Promise<void> {
    try {
      // Resolved once here rather than at each use below: ensureSettingsBranch()
      // is idempotent, but a local reads better and keeps the eight references
      // in this method obviously talking about one value.
      const settingsBranch = this.ensureSettingsBranch()
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
        await git.push(this.buildGitHubUrl(), settingsBranch)
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
  private async reconcileTrackedBranches(
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
        } else if (await hasPendingHistoryRewrite(this.ctx(), name)) {
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

  async syncGit(): Promise<void> {
    if (!this.running) return

    workerLog('Syncing git...')
    const cycleStartedAt = Date.now()
    const git = simpleGit({
      baseDir: this.remoteGitPath,
      // DEP-H1: a hung fetch/push would stall the sync loop forever
      // (scheduleLoop only reschedules after completion). The block timeout
      // is inactivity-based, so a slow-but-flowing transfer is unaffected.
      timeout: { block: this.taskTimeoutMs },
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
        this.buildGitHubUrl(),
        '--prune',
        `+refs/heads/*:${GITHUB_TRACKING_REF_PREFIX}*`,
      ])
      workerLog('Fetched from GitHub')

      // Bring refs/heads/* toward what was just fetched, WITHOUT ever
      // force-rewinding or deleting a local head -- see
      // reconcileTrackedBranches()'s doc comment.
      const { summary: trackedSummary, trackedNames } = await this.reconcileTrackedBranches(git)

      // Push settings branches to GitHub (belt-and-suspenders for task queue).
      // Ensures settings reach GitHub even if a task queue entry is lost.
      // Ordering relative to the fetch/reconcile above is no longer a
      // correctness dependency now that the fetch can't clobber refs/heads/*
      // -- this could run before or after them just as safely.
      await this.pushSettingsBranches(git, trackedNames)

      await this.refreshBaseBranchWorkspace()

      const rebaseSummary = await this.rebaseActiveBranches()

      // Periodically clean up old completed/failed tasks
      await cleanupOldTasks(this.taskDir, undefined, this.log)

      // [C1] Sweep branch directories the admin purge action trashed more
      // than TRASH_RETENTION_MS ago. Worker-only by design: purge itself
      // never deletes anything (reversible), and this cycle is the sole
      // place actual removal happens.
      const trashRemoved = await this.cleanupTrashedBranchDirs()
      if (trashRemoved > 0) {
        workerLog(`Removed ${trashRemoved} expired trashed branch dir(s)`)
      }

      const report = this.ensureStatusReport()
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
      await writeWorkerStatus(this.taskDir, report).catch((writeErr) =>
        workerLogError('Failed to write worker status:', getErrorMessage(writeErr)),
      )
    } catch (err) {
      const report = this.ensureStatusReport()
      // [REDACT] Persisted to worker-status.json and served to the browser
      // by the admin panel -- a fetch/push failure's message can embed the
      // bot token via buildGitHubUrl().
      report.lastGitSyncError = {
        message: redactCredentials(getErrorMessage(err)),
        at: new Date().toISOString(),
      }
      await writeWorkerStatus(this.taskDir, report).catch((writeErr) =>
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
  private async cleanupTrashedBranchDirs(): Promise<number> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.contentBranchesPath)
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
        await fs.rm(path.join(this.contentBranchesPath, name), {
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
  private async refreshBaseBranchWorkspace(): Promise<void> {
    // Sanitized name for the workspace directory (a base branch containing
    // e.g. '/' would otherwise stat a wrong nested path here forever).
    const basePath = path.join(this.contentBranchesPath, this.sanitizedBaseBranch)
    const gitDir = path.join(basePath, '.git')

    try {
      let gitDirStat
      try {
        gitDirStat = await fs.stat(gitDir)
      } catch {
        gitDirStat = null
      }
      if (!gitDirStat || !gitDirStat.isDirectory()) {
        workerLog(
          `Base branch workspace (${this.baseBranch}): not yet provisioned, skipping refresh`,
        )
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
        timeout: { block: this.taskTimeoutMs },
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
          `Base branch workspace (${this.baseBranch}) has uncommitted changes -- skipping refresh. Dirty files: ${trackedDirty.map((f) => f.path).join(', ')}`,
        )
        return
      }

      // Raw (unsanitized) name from here on: these are git ref operations
      // against origin/<baseBranch>, not filesystem paths, so they must use
      // the same name GitHub knows the branch by.
      await baseGit.fetch('origin', this.baseBranch)

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
            `Base branch workspace (${this.baseBranch}) failed to fast-forward (diverged local history?): ${getErrorMessage(err)}`,
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
        const meta = getBranchMetadataFileManager(basePath, this.contentBranchesPath)
        await meta.save({
          branch: { name: this.baseBranch, conflictStatus: 'clean', conflictFiles: [] },
        })
      }

      // One concise per-cycle line -- the diagnostic for the next live deploy.
      workerLog(
        behindCount > 0
          ? `Base branch workspace (${this.baseBranch}): fast-forwarded ${behindCount} commit(s)`
          : `Base branch workspace (${this.baseBranch}): up to date`,
      )
    } catch (err) {
      workerLogError(
        `Base branch workspace (${this.baseBranch}) refresh failed: ${getErrorMessage(err)}`,
      )
    }
  }

  /**
   * Test-only seam: awaited inside `rebaseActiveBranches()`'s conflict round,
   * after `git rebase` reported conflicted files and BEFORE the
   * `checkout --theirs` resolution loop overwrites them. No-op in production.
   *
   * A test subclass overrides this to land a real `ContentStore` write at
   * exactly the instant the rebase is mid-flight -- the window the old TOCTOU
   * comment above the dirty check wrongly called safe -- without any sleeps or
   * shell rendezvous. See the "Deterministic interleavings" testing pattern in
   * docs/concurrency.md, and `ContentStore.afterPrePassForTesting()` for the
   * same idiom on the write side.
   */
  protected async afterConflictDetectedForTesting(): Promise<void> {}

  /**
   * Test seam, sibling of {@link afterConflictDetectedForTesting}: runs at the
   * instant a rebase round has succeeded, before the completion path (cache
   * invalidation, conflict metadata, [SYNC-H1] marker) executes. Exists so a
   * test can lose the content-write lock at exactly the point where bailing out
   * would strand a rewritten history.
   */
  protected async afterRebaseCompletedForTesting(): Promise<void> {}

  // --- Rebase loop (worker/rebase.ts) ------------------------------------
  //
  // Both are reached by tests through the instance: four files call
  // `rebaseActiveBranches` directly (it is the single entry point the whole
  // rebase suite drives), and cms-worker-merge-poll.test.ts calls
  // `pollMergeState` with a mocked `octokit`.

  private async rebaseActiveBranches(): Promise<RebaseSummary> {
    return runRebaseCycle(this.ctx())
  }

  private async pollMergeState(
    branchDir: string,
    branchPath: string,
    metaFile: BranchMetadataFile | null,
  ): Promise<void> {
    return pollMergeState(this.ctx(), branchDir, branchPath, metaFile)
  }

  async refreshAuthCache(): Promise<void> {
    if (!this.running || !this.config.refreshAuthCache) return

    workerLog('Refreshing auth cache...')
    try {
      await this.config.refreshAuthCache()
      workerLog('Auth cache refreshed')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      workerLogError('Failed to refresh auth cache:', message)
    }
  }
}
