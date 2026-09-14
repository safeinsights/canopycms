import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import lockfile from 'proper-lockfile'
import { Octokit } from '@octokit/rest'
import { recoverOrphanedTasks, cmsTaskQueueLogger } from './task-queue'
import type { Task } from './task-queue'
import { createCanopyOctokit } from '../github-service'
import {
  isTransientAuthFailure,
  resolveWorkerGitHubAuth,
  type GitHubAuthConfig,
  type ResolvedGitHubAuth,
} from './github-auth'
import type { BranchMetadataFile } from '../branch-metadata'
import { type SanitizedBranchName } from '../paths/types'
import { sanitizeBranchName, RESERVED_SETTINGS_BRANCH_PREFIX } from '../paths/branch-name'
import { resolveDeploymentName } from '../operating-mode/deployment-name'
import type { WorkerStatusReport } from '../types'
import { getErrorMessage, isNodeError, redactCredentials } from '../utils/error'
import { writeWorkerStatus } from './worker-status'
import { workerLog, workerLogWarn, workerLogError } from './log'
import type { WorkerContext } from './worker-context'
import {
  executeTask,
  orphanRecoveryMaxAgeMs,
  processTaskQueue,
  pushBranchToGitHub,
  updateBranchMetadata,
} from './task-runner'
import { pollMergeState, runRebaseCycle, type RebaseSummary } from './rebase'
import {
  cleanupTrashedBranchDirs,
  pushSettingsBranches,
  refreshBaseBranchWorkspace,
  syncGit,
} from './git-sync'

// Re-exported because this module is the package's advertised worker
// entrypoint (`canopycms/worker/cms-worker`).
export { PermanentTaskError, isPermanentTaskFailure } from './task-runner'

// Re-exported so the AWS entrypoint (packages/canopycms-cdk/worker/index.ts)
// can prefix its own startup lines through the same helpers without a new
// package entrypoint. Every line in worker.log must carry the timestamp prefix
// or it is folded into the previous CloudWatch event; see ./log.ts.
export { workerLog, workerLogWarn, workerLogError, installWorkerLogger } from './log'

// Re-exported for the same reason: an entrypoint that authenticates as a GitHub
// App builds the credential itself (core must not import `@octokit/auth-app` —
// see github-auth.ts) and needs the shape to inject and the key normalizer to
// apply.
export {
  normalizeGitHubAppPrivateKey,
  DEFAULT_GIT_TOKEN_MINT_TIMEOUT_MS,
  DEFAULT_GITHUB_TOKEN_REFRESH_MIN_INTERVAL_MS,
  type GitHubAppAuth,
  type GitHubAuthConfig,
} from './github-auth'

/**
 * Auth cache refresh function type; adopters supply their auth-plugin-specific
 * implementation (for Clerk, refreshClerkCache from
 * canopycms-auth-clerk/cache-writer).
 */
export type AuthCacheRefresher = () => Promise<void>

/**
 * `githubToken` / `githubAppAuth` / `gitTokenMintTimeoutMs` are declared
 * together in `GitHubAuthConfig` (./github-auth) because they are one decision,
 * resolved in one place. The token is the documented default; see that
 * interface for the two shapes and why an App is optional.
 */
export interface CmsWorkerConfig extends GitHubAuthConfig {
  /** Path to workspace root on EFS (e.g., /mnt/efs/workspace) */
  workspacePath: string
  /** GitHub owner (e.g., 'safeinsights') */
  githubOwner: string
  /** GitHub repo name (e.g., 'docs-site') */
  githubRepo: string
  /** Called periodically to update the auth metadata cache on EFS. */
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
   * Names THIS worker's own settings branch
   * (`canopycms-settings-{deploymentName}`, default 'prod' — ProdStrategy's
   * mode default in operating-mode/client-unsafe-strategy.ts, the only mode the
   * worker runs in). Two deployments can share one GitHub repo with distinct
   * settings branches; this is what tells the worker which one it owns, so it
   * never pushes another deployment's (see `pushSettingsBranches`).
   */
  deploymentName?: string
  /**
   * Explicit settings branch name, taking precedence over `deploymentName` and
   * mirroring the strategy's own precedence (operating-mode/
   * client-unsafe-strategy.ts). An adopter who overrides `settingsBranch` in
   * canopycms.config.ts MUST set this too, or the worker owns a branch name the
   * Lambda never writes to.
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
   * Worker lock staleness TTL in ms (default 60000, minimum 2000). The holder
   * refreshes the heartbeat at half this interval; a lock whose heartbeat is
   * older than this is abandoned and taken over by the next worker to start.
   */
  lockStaleMs?: number
}

const DEFAULT_TASK_TIMEOUT = 60_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_LOCK_STALE_MS = 60_000

/**
 * CMS Worker daemon: the operations Lambda, which has no internet, cannot
 * perform -- draining the task queue, syncing the bare repo with GitHub,
 * rebasing branch workspaces, and refreshing the auth metadata cache through a
 * pluggable callback.
 *
 * Auth-agnostic (no specific auth provider) and cloud-agnostic (git/Octokit
 * directly, no AWS SDK dependency).
 */
export class CmsWorker {
  // Built by ensureGitHubAuth(), not the constructor, so a credential config
  // error is throwable somewhere start()'s catch can record it. A FIELD rather
  // than a getter because two test files assign a mock over it (the same
  // INVARIANT worker-context.ts states), and ensureGitHubAuth() will not
  // overwrite one that is already there.
  private octokit!: Octokit
  private taskDir: string
  private remoteGitPath: string
  private contentBranchesPath: string
  private baseBranch: string
  // Workspace directories use sanitized names; git refs (fetch/rev-list/merge
  // against origin/<baseBranch>) must keep using the raw `baseBranch` name.
  // Computed once so both filesystem call sites agree instead of re-deriving it
  // and risking drift.
  private sanitizedBaseBranch: SanitizedBranchName
  // This deployment's own settings branch — see CmsWorkerConfig.deploymentName.
  // `pushSettingsBranches` pushes ONLY this branch, never another
  // `canopycms-settings-*` it happens to find locally. Resolved lazily by
  // ensureSettingsBranch(), NOT in the constructor (see that method):
  // `undefined` means "not resolved yet", never "no settings branch".
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
  // Self-reported liveness/health snapshot, written to worker-status.json.
  // Normally initialized at the top of start(); see ensureStatusReport() for
  // the lazy-init fallback.
  private statusReport?: WorkerStatusReport
  // Which GitHub credential this worker uses, resolved ONCE so Octokit and
  // every git URL provably authenticate as the same identity. Resolved lazily
  // by ensureGitHubAuth(), NOT in the constructor (see that method):
  // `undefined` means "not resolved yet", never "no credential".
  private githubAuth?: ResolvedGitHubAuth

  constructor(private config: CmsWorkerConfig) {
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
   * This worker's self-reported status object, initialized on first use.
   * Normally set at the top of start(); the lazy fallback covers something in
   * start() reaching a status-write point before that (see start()'s catch) and
   * unit tests driving syncGit()/processTaskQueue() without calling start().
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
   * Routed through the shared resolver, not a local `?? 'prod'`: that is the
   * single definition of the env > config > mode-default precedence the Lambda
   * follows, and the only place the resolved value is validated. Without it the
   * worker can silently own a different settings branch than the Lambda writing
   * to the same workspace, and pushSettingsBranches then reports the real branch
   * as foreign and never pushes it.
   *
   * DEFERRED out of the constructor deliberately, which is the whole point of
   * the method existing: canopycms-cdk/worker/index.ts constructs the worker
   * before calling start(), so a throw during `new CmsWorker(...)` lands BEFORE
   * the only code that writes `lastFatalError` -- start()'s catch. Under
   * systemd `Type=simple` + `Restart=always` with no cfn-signal, that is an
   * invisible ~5s crash-loop that `cdk deploy` reports as success while the
   * admin panel shows the worker 'absent' with no fatal error to explain it.
   *
   * Lazy rather than start()-only so unit tests driving pushSettingsBranches()
   * still see the value, exactly as ensureStatusReport() above. Idempotent: the
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
   * Built FRESH on every call, with instance-backed members as functions rather
   * than copied values. See WorkerContext's INVARIANT: a context that captured
   * any of them at construction time would hand the extracted code the pre-test
   * value, which for `buildGitHubUrl` means a test's push going to github.com
   * for real instead of its local fixture repo.
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
      octokit: () => this.octokitClient(),
      buildGitHubUrl: () => this.buildGitHubUrl(),
      refreshGitHubCredential: () => this.refreshGitHubCredential(),
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

    await this.acquireLock()

    // Everything below runs while holding the cross-host worker lock. A failure
    // here (most notably the empty-remote guard inside ensureRemoteGit) means
    // the process is about to exit and systemd (Restart=always) will retry —
    // but a still-held lock would make every retry fail with ELOCKED for up to
    // lockStaleMs, so release before rethrowing. Do NOT reorder ensureRemoteGit
    // ahead of acquireLock: two hosts cold-starting at once would then both
    // race to `git clone --bare` into the same remoteGitPath, and acquiring the
    // lock first is what serializes that.
    try {
      // FIRST inside the try, before any I/O: an infra-stamped deployment name
      // that is not a valid git ref component throws HERE, where the catch
      // below records it to worker-status.json. See ensureSettingsBranch().
      this.ensureSettingsBranch()

      // Same shape, same reason: a half-configured credential throws HERE,
      // inside the try, rather than out of `new CmsWorker(...)` where nothing
      // could record it.
      this.ensureGitHubAuth()

      // BEFORE ensureRemoteGit(): its clone is the first thing to use the
      // credential, and its catch blames the repository rather than the
      // credential. See preflightGitHubAppAuth().
      await this.preflightGitHubAppAuth()

      await this.ensureRemoteGit()

      // Recover orphaned tasks immediately rather than waiting for the first
      // processTaskQueue() poll. Not the only call site: processTaskQueue()
      // repeats this every cycle, and its doc comment says why a boot-only call
      // is insufficient.
      const recovered = await recoverOrphanedTasks(
        this.taskDir,
        orphanRecoveryMaxAgeMs(this.ctx()),
        this.log,
      )
      if (recovered > 0) {
        workerLog(`Recovered ${recovered} orphaned task(s)`)
      }

      const initialTasks: Promise<void>[] = [this.syncGit()]
      if (this.config.refreshAuthCache) {
        initialTasks.push(this.refreshAuthCache())
      }
      await Promise.allSettled(initialTasks)
    } catch (err) {
      // Surface a startup failure (e.g. the empty-remote guard's poisoned
      // remote.git) to the admin panel via worker-status.json, not only
      // journald/CloudWatch. Best-effort and BEFORE releaseLock(): a
      // status-write failure must never block releasing the lock.
      const report = this.ensureStatusReport()
      report.lastFatalError = {
        // [REDACT] Persisted to worker-status.json and served to the browser by
        // the admin panel -- must never carry the bot token a poisoned or
        // failed git URL (buildGitHubUrl()) can embed.
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

    const taskInterval = this.config.taskPollInterval ?? 5_000
    const gitInterval = this.config.gitSyncInterval ?? 5 * 60_000

    this.scheduleLoop(() => this.processTaskQueue(), taskInterval)
    // The wrapper, not syncGit() itself: a failed sync is where a rotated or
    // revoked GitHub credential is noticed. start()'s own initial syncGit()
    // above stays unwrapped -- there is no stale credential to refresh one line
    // after reading it at boot.
    this.scheduleLoop(() => this.syncGitWithCredentialRefresh(), gitInterval)

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
   * concurrent workers would double-process tasks, duplicating pushes and PRs.
   * The workspace lives on EFS, so mutual exclusion must be sound ACROSS HOSTS
   * — a PID liveness probe (`process.kill(pid, 0)`) means something only on the
   * holder's own machine and must NEVER participate in staleness decisions.
   *
   * proper-lockfile provides a heartbeat lease with no PID involved: the lock
   * is a directory created atomically (mkdir — atomic on NFS/EFS), the holder
   * refreshes its mtime every lockStaleMs/2, and the lock is abandoned, and
   * taken over, only once that heartbeat is older than lockStaleMs.
   *
   * No acquire retries: a second worker exits immediately, matching daemon
   * semantics. After a crash the dead holder's heartbeat expires within
   * lockStaleMs and the next start succeeds.
   *
   * Staleness compares the lock's mtime against the LOCAL clock, so correct
   * cross-host takeover assumes reasonable clock agreement (NTP). Ordinary skew
   * is negligible at the default TTL; a badly wrong clock misjudges liveness.
   */
  private async acquireLock(): Promise<void> {
    await fs.mkdir(this.taskDir, { recursive: true })
    try {
      this.releaseLockFn = await lockfile.lock(this.taskDir, {
        lockfilePath: this.lockFilePath,
        stale: this.lockStaleMs,
        onCompromised: (err) => {
          // The heartbeat could not be maintained (lock deleted or taken over),
          // so another worker may now be consuming the queue: stop processing
          // to preserve the single-consumer invariant.
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
   * Run `fn` repeatedly, the next invocation starting `interval` ms after the
   * previous one COMPLETES. setTimeout chaining rather than setInterval, so
   * executions cannot overlap when one runs longer than the interval.
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
   * Explicit `--git-dir` rather than `simpleGit({ baseDir })`, so this also
   * works where `safe.bareRepository=explicit` refuses cwd-based discovery of
   * bare repos but expressly allows `--git-dir` (same pattern as
   * GitManager.bareRemoteHasBranch).
   *
   * Deliberately omits `--quiet`: simple-git treats a task as failed only when
   * the process exits non-zero AND writes to stderr, so a silent-on-failure
   * `--verify` would leave a missing branch indistinguishable from success.
   * Without `--quiet`, `rev-parse --verify` writes "fatal: ..." to stderr,
   * which is what makes simple-git reject the promise here.
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
   * shared EFS. The security model in docs/deploying-to-aws.md -- a compromised
   * Lambda can read/write EFS content but cannot push to GitHub, secrets stay
   * on the worker -- is false while that string is there: the Lambda could read
   * the token off EFS and, with no egress of its own, exfiltrate it by writing
   * it into branch content the worker then pushes to GitHub.
   *
   * Nothing needs the remote: every push passes the URL explicitly as an
   * argument, and `verifyBaseBranchExists` reads local refs.
   *
   * VERIFIES rather than assuming: it re-reads the config and throws if the URL
   * survives, so a failed scrub is never indistinguishable from a clean one.
   */
  private async scrubPersistedRemote(gitDir: string): Promise<void> {
    const git = simpleGit({ baseDir: gitDir })
    // `git config --get` exits 1 with no output when the key is absent, and
    // simple-git resolves with an empty string rather than throwing (verified
    // against 3.36), so an empty result means "absent" too.
    //
    // 'unreadable' is deliberately DISTINCT from 'absent'. A read that fails
    // for any other reason must not be mistaken for "no token here": that would
    // let the pre-check below short-circuit and skip the scrub entirely,
    // silently leaving a token-bearing config on shared EFS -- the exact
    // outcome this function exists to prevent. Fail closed and attempt the
    // removal instead.
    const readOriginUrl = async (): Promise<string | null | 'unreadable'> => {
      try {
        const url = (await git.raw(['config', '--get', 'remote.origin.url'])).trim()
        return url === '' ? null : url
      } catch {
        // ANY throw is 'unreadable', never 'absent'. The genuinely-absent case
        // does not reach here at all (simple-git resolves with ''), so a throw
        // means something actually went wrong, and mapping that to "no token
        // here" is the one fail-OPEN reading available. Classifying git's
        // exit-1 "key not found" from the message text is not an option either:
        // simple-git's GitError message is raw stdout+stderr with no exit-code
        // text to match on.
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
      // not exist. Let the verification below decide rather than failing here;
      // it is the authoritative check and it fails closed.
      workerLogWarn(
        `  removeRemote('origin') failed in ${gitDir}: ${getErrorMessage(err)} -- verifying directly`,
      )
    }

    // Fails closed on BOTH a surviving URL and an unverifiable read: without
    // proof the token is gone from shared storage, do not proceed.
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
   * Ensure the remote.git bare repo exists, cloning it from GitHub on first
   * run.
   *
   * Empty-remote guard: simple-git's bare clone of an EMPTY GitHub repo (no
   * commits, or a base branch never pushed) exits 0 and produces a refs-less
   * bare repo whose HEAD points at an unborn branch. `fs.stat` cannot tell that
   * from a healthy clone, so left unchecked it silently poisons remote.git —
   * every later branch operation breaks and the fs.stat short-circuit means it
   * never heals. The base branch is therefore verified right after cloning AND
   * on the already-exists fast path, since a previous run can have left a
   * poisoned remote.git behind.
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
      // SELF-HEAL, before anything else touches this repo: re-checked on every
      // boot, not only at clone time, so a token that survived one scrub does
      // not survive forever, and a clone interrupted between `git clone` and
      // the scrub cannot leave a token-bearing config sitting on EFS until an
      // operator acts.
      await this.scrubPersistedRemote(this.remoteGitPath)

      try {
        await this.verifyBaseBranchExists(this.remoteGitPath)
      } catch (err) {
        workerLogError(`remote.git base branch verification failed: ${getErrorMessage(err)}`)
        // Do NOT auto-delete: an existing remote.git can hold unpushed
        // canopycms-settings-* branches or other state worth preserving, so
        // deletion is the operator's call.
        throw new Error(
          `remote.git at ${this.remoteGitPath} has no branch '${this.baseBranch}' (likely cloned while the GitHub repo was empty). Delete ${this.remoteGitPath} and restart the worker to re-clone.`,
        )
      }
      return // Already exists and has the base branch
    }

    workerLog('Initializing remote.git from GitHub...')
    const git = simpleGit()

    // Clone under a TEMP name and rename into place only once the token is
    // scrubbed and the repo verified, so `remote.git` never exists on EFS in a
    // token-bearing state. A crash mid-clone leaves only this staging
    // directory, which the next boot deletes, rather than a poisoned
    // `remote.git` that fs.stat cannot distinguish from a healthy one.
    const stagingPath = `${this.remoteGitPath}.cloning`
    await fs.rm(stagingPath, { recursive: true, force: true })

    try {
      await git.clone(await this.buildGitHubUrl(), stagingPath, ['--bare'])

      // Before the rename, so the token is gone from the config the moment the
      // repo becomes reachable under its real name. Throws (rather than
      // swallowing) if the scrub does not take.
      await this.scrubPersistedRemote(stagingPath)

      await this.verifyBaseBranchExists(stagingPath)
    } catch (err) {
      workerLogError(`remote.git clone failed: ${redactCredentials(getErrorMessage(err))}`)
      // Deleting before throwing is what makes this recoverable: the next
      // start() sees no remote.git and re-clones, instead of sticking forever
      // behind a poisoned bare repo fs.stat alone cannot detect.
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
  // READ THIS BEFORE STUBBING ANY DELEGATOR BELOW: they are not all the same,
  // and the difference is invisible from here. `processTaskQueue` is the public
  // loop entry `scheduleLoop` drives, so it IS on the production path; the
  // other three exist ONLY so test files can reach the implementations through
  // the instance, since the extracted modules call each other at module level.
  //
  // So replacing one of these on an instance affects production behaviour only
  // if the context also routes it. `executeTask` and `pushBranchToGitHub` are
  // on `WorkerContext` for exactly that reason; `updateBranchMetadata` is NOT,
  // so a stub installed there is a silent no-op. To stub a method that is not
  // on the context, add it to WorkerContext and route the internal caller
  // through `ctx` -- a delegator's existence does not make a stub take effect.

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

  /**
   * Resolve which GitHub credential this worker uses, once, and build the
   * Octokit client from it.
   *
   * DEFERRED out of the constructor deliberately, exactly as
   * `ensureSettingsBranch()` is and for the reason that method records:
   * `resolveWorkerGitHubAuth` throws for a half-configured credential (both
   * set, neither set, an unusable mint timeout or refresh interval), and a
   * throw during `new CmsWorker(...)` lands BEFORE the only code that writes
   * `lastFatalError` — start()'s catch.
   *
   * Idempotent, and it does NOT replace an `octokit` a test has already
   * assigned onto the instance — see the field's comment.
   */
  private ensureGitHubAuth(): ResolvedGitHubAuth {
    if (!this.githubAuth) {
      this.githubAuth = resolveWorkerGitHubAuth(this.config)
    }
    if (!this.octokit) {
      this.octokit = createCanopyOctokit(this.githubAuth.octokitAuth)
    }
    return this.githubAuth
  }

  /**
   * The Octokit client, built on first use. Every read goes through here rather
   * than touching the field, which the constructor does not populate: a method
   * reached without start() would otherwise see `undefined`.
   * `rebaseActiveBranches()` is exactly that case — apps/test-app's e2e route
   * calls it directly, and its `pollMergeState` dispatch reads `ctx.octokit()`.
   */
  private octokitClient(): Octokit {
    this.ensureGitHubAuth()
    return this.octokit
  }

  /**
   * The single seam through which every git-over-HTTPS credential reaches a git
   * command. The only other consumer is Octokit, built from the same resolution
   * by `ensureGitHubAuth()` above.
   *
   * Async because under GitHub App auth `resolveGitToken` mints an installation
   * token lasting about an hour. NOTHING may cache what this returns — a URL
   * built from an installation token goes stale with it — and resolving per use
   * is cheap, since `@octokit/auth-app` answers from its own cache until the
   * token is near expiry.
   *
   * A mint failure propagates AS THROWN, carrying the `.status` that
   * `isPermanentTaskFailure` classifies on — see github-auth.ts.
   *
   * Do NOT add a parallel token accessor alongside it. Every instance-backed
   * WorkerContext member stays a function precisely so tests can replace it
   * through the instance (worker-context.ts's INVARIANT); a second credential
   * path would be one nothing stubs.
   */
  private async buildGitHubUrl(): Promise<string> {
    const token = await this.ensureGitHubAuth().resolveGitToken()
    return `https://x-access-token:${token}@github.com/${this.config.githubOwner}/${this.config.githubRepo}.git`
  }

  /**
   * Prove the GitHub App credential works before anything depends on it.
   *
   * Without this the first failure comes out of `ensureRemoteGit`'s bare clone
   * below, whose catch blames the repository ("may be empty, or the base branch
   * may not exist") and sends an operator holding a bad private key looking for
   * a problem that does not exist. Called from start()'s try, so the failure is
   * also recorded as `lastFatalError` and reaches the admin panel. No-op on the
   * token path: a PAT is a literal, so the first real request checks everything
   * this could.
   *
   * FATAL UNLESS THE FAILURE POSITIVELY LOOKS TRANSIENT. Both halves are
   * load-bearing. Not always fatal, because the two credential paths must
   * degrade alike: on the token path a GitHub 502 during boot is absorbed (a
   * warm `remote.git` short-circuits `ensureRemoteGit`, `Promise.allSettled`
   * swallows the initial `syncGit`) so the worker starts and its loops retry,
   * while rethrowing every error class would make the App path exit and systemd
   * crash-loop it until GitHub recovered — each iteration telling the operator
   * to check their private key.
   *
   * But fail CLOSED, via `isTransientAuthFailure` rather than the inverse of
   * `isPermanentTaskFailure`: that classifier defaults a status-less error to
   * transient, which is right on the task path (bounded by `maxRetries`) and
   * wrong here (bounded by nothing). A key that never reaches GitHub at all —
   * the wrong type, or too mangled to sign with — fails locally and
   * status-lessly, so defaulting to transient would boot a worker with a dead
   * credential, record no `lastFatalError`, and show healthy in the admin panel
   * while every task and every sync failed.
   */
  private async preflightGitHubAppAuth(): Promise<void> {
    if (!this.config.githubAppAuth) return
    try {
      await this.ensureGitHubAuth().resolveGitToken()
    } catch (err) {
      // [REDACT] Both messages below reach worker-status.json and the browser.
      const detail = redactCredentials(getErrorMessage(err))
      if (isTransientAuthFailure(err)) {
        workerLogWarn(
          `Could not verify GitHub App authentication at startup: ${detail}. ` +
            'Continuing — this looks transient, and the credential is minted again on first use.',
        )
        return
      }
      // Re-thrown WITH context, unlike buildGitHubUrl() above, which must
      // preserve the error identity for task classification. Nothing classifies
      // a startup failure -- start()'s catch records the message and the
      // process exits -- so the operator-facing wording wins here.
      throw new Error(
        `GitHub App authentication failed: ${detail}. ` +
          'Check the app id, the installation id, and that the private key belongs to that app.',
      )
    }
    workerLog('GitHub App authentication verified')
  }

  /**
   * The workspace directory for a branch named by its GIT REF name -- the form
   * task payloads carry (`context.branch.name`), not the directory form.
   *
   * These differ for any name outside `[A-Za-z0-9._-]`, `/` being the obvious
   * one: workspaces are provisioned under `sanitizeBranchName(...)` (see
   * paths/branch.ts's `resolveBranchPaths`), so `feature/x` lives in
   * `feature-x`. Joining the RAW name instead silently addresses a directory
   * that does not exist -- which drops the metadata writers' updates, and makes
   * the leased push read the history-rewrite marker as absent and go out
   * unleased, wedging the branch.
   *
   * `name` inside the metadata itself stays the raw ref name; only the path is
   * sanitized.
   */
  private branchWorkspacePath(branchRefName: string): string {
    return path.join(this.contentBranchesPath, sanitizeBranchName(branchRefName))
  }

  /**
   * Test-only seam: awaited inside `rebaseActiveBranches()`'s conflict round,
   * after `git rebase` reported conflicted files and BEFORE the
   * `checkout --theirs` resolution loop overwrites them. No-op in production.
   *
   * A test subclass overrides this to land a real `ContentStore` write at
   * exactly the instant the rebase is mid-flight, with no sleeps or shell
   * rendezvous. See the "Deterministic interleavings" pattern in
   * docs/concurrency.md, and `ContentStore.afterPrePassForTesting()` for the
   * same idiom on the write side.
   */
  protected async afterConflictDetectedForTesting(): Promise<void> {}

  /**
   * Test seam, sibling of {@link afterConflictDetectedForTesting}: runs the
   * instant a rebase round has succeeded, before the completion path (cache
   * invalidation, conflict metadata, [SYNC-H1] marker) executes, so a test can
   * lose the content-write lock at exactly the point where bailing out would
   * strand a rewritten history.
   */
  protected async afterRebaseCompletedForTesting(): Promise<void> {}

  // --- Rebase loop (worker/rebase.ts) ------------------------------------
  //
  // Both are TEST-ONLY entry points -- see the task-queue block above. Nothing
  // in production dispatches through either: `syncGit` calls `runRebaseCycle`
  // directly and that calls `pollMergeState` directly. Neither is on
  // WorkerContext, so a stub installed on either is a no-op for production.
  //
  // `rebaseActiveBranches` also has a consumer outside the test files:
  // apps/test-app/app/api/e2e-test/rebase/route.ts drives it from an e2e
  // fixture route. Do not delete it as unused.

  private async rebaseActiveBranches(): Promise<RebaseSummary> {
    return runRebaseCycle(this.ctx())
  }

  // --- Git-sync cluster (worker/git-sync.ts) -----------------------------
  //
  // `syncGit` is the public loop entry `scheduleLoop` drives. The three private
  // ones below it are TEST-ONLY entry points -- see the task-queue block above
  // -- each called directly by one test file. `syncGit` reaches all three as
  // module-level calls, so a stub installed on one of these is a no-op.
  //
  // `reconcileTrackedBranches` deliberately has NO delegator: no test reaches
  // it through the instance.

  async syncGit(): Promise<void> {
    return syncGit(this.ctx())
  }

  /**
   * `syncGit`, plus "the credential may have rotated" on the way out.
   *
   * One of `refreshGitHubCredential`'s two call sites, and the one that works
   * when nobody is publishing: it fetches from GitHub every `gitSyncInterval`
   * whether or not anyone is editing, so a credential that has stopped working
   * surfaces here even with no push queued for days.
   *
   * The SYNC failure is what propagates to `scheduleLoop`'s catch;
   * `refreshGitHubCredential` never throws, so nothing it does can replace it.
   */
  private async syncGitWithCredentialRefresh(): Promise<void> {
    try {
      await this.syncGit()
    } catch (err) {
      await this.refreshGitHubCredential()
      throw err
    }
  }

  /**
   * Re-read the GitHub credential, because an operation using it just failed.
   *
   * **Two call sites, each covering what the other cannot.** The git-sync loop
   * (`syncGitWithCredentialRefresh`) notices a dead credential when nobody is
   * publishing. `processTaskQueue`'s per-task catch is what saves a publish: a
   * push task spends its retry budget on a 5s/10s/20s backoff, well inside one
   * 5-minute sync interval, so with the sync loop as the only trigger a publish
   * meeting a rotated token fails permanently while the working one is already
   * in the secret store. Every consumer reaches the credential through
   * `ensureGitHubAuth()`, which reads it per use, so a refresh from either site
   * repairs all of them for their NEXT use — but not an attempt already failed.
   *
   * NOT gated on the error looking auth-shaped, at either site: a `git
   * fetch`/`push` rejected for a dead token throws a plain simple-git error
   * (exit 128, no HTTP `.status`) that `isPermanentTaskFailure` reads as
   * transient, so a gate keyed on it would never fire. Two floors bound the
   * cost instead — core's `refreshGitHubTokenMinIntervalMs` (default 60s,
   * enforced by `refreshCredential` in github-auth.ts) and whatever floor the
   * provider keeps (the AWS one reads at most once per five minutes) — and both
   * call sites share both, so a read issued by one throttles the other. On the
   * GitHub App path the refresh is a no-op.
   *
   * **Never throws**: both callers are already reporting the failure that must
   * reach the log. **Bounded by `taskTimeoutMs`**, because the task loop awaits
   * it and a read that never settled would stop every publish queued behind it
   * (an adopter's provider may have no bound at all; the AWS one can take 87s
   * for one `getSecret`). A losing read is not cancelled and may land later, but
   * `refreshCredential` discards a result older than one already applied.
   */
  private async refreshGitHubCredential(): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the re-read did not settle within ${this.taskTimeoutMs}ms`)),
        this.taskTimeoutMs,
      )
    })
    try {
      // `ensureGitHubAuth()` inside the try: it throws for a half-configured
      // credential, and that has to be logged like any other refresh failure.
      await Promise.race([this.ensureGitHubAuth().refreshCredential(), timedOut])
    } catch (err) {
      // [REDACT] The message can name the secret and, on a malformed-secret
      // path, quote what was read. Console only, but the rule is uniform --
      // see redactCredentials in utils/error.ts.
      workerLogError(
        'Failed to re-read the GitHub credential after a failure:',
        redactCredentials(getErrorMessage(err)),
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private async pushSettingsBranches(
    git: ReturnType<typeof simpleGit>,
    trackedNames: ReadonlySet<string>,
  ): Promise<void> {
    return pushSettingsBranches(this.ctx(), git, trackedNames)
  }

  private async refreshBaseBranchWorkspace(): Promise<void> {
    return refreshBaseBranchWorkspace(this.ctx())
  }

  private async cleanupTrashedBranchDirs(): Promise<number> {
    return cleanupTrashedBranchDirs(this.ctx())
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
