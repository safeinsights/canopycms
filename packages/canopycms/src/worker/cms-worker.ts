import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import lockfile from 'proper-lockfile'
import { Octokit } from '@octokit/rest'
import { recoverOrphanedTasks, cmsTaskQueueLogger } from './task-queue'
import type { Task } from './task-queue'
import { createCanopyOctokit } from '../github-service'
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

  // --- Git-sync cluster (worker/git-sync.ts) -----------------------------
  //
  // `syncGit` is the public loop entry `scheduleLoop` drives; the three
  // private ones below it are each called directly by a test file
  // (cms-worker-sync-reconcile for the settings push, cms-worker-base-refresh
  // for the base workspace, cms-worker.test.ts for the trash sweep).

  async syncGit(): Promise<void> {
    return syncGit(this.ctx())
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
