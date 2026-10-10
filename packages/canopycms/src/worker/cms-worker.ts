import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import lockfile from 'proper-lockfile'
import { Octokit } from '@octokit/rest'
import { recoverOrphanedTasks, cmsTaskQueueLogger } from '../task-queue/cms-task-queue'
import type { Task } from '../task-queue/cms-task-queue'
import { createCanopyOctokit } from '../github-service'
import {
  isTransientAuthFailure,
  resolveWorkerGitHubAuth,
  type GitHubAuthConfig,
  type ResolvedGitHubAuth,
} from './github-auth'
import type { BranchMetadataFile } from '../branch-metadata'
import { GITHUB_TRACKING_REF_PREFIX, ensureRemoteGitConfig, failOnSignalExit } from '../git-manager'
import { readHeadBranch } from '../utils/git'
import { type SanitizedBranchName } from '../paths/types'
import {
  isSettingsBranchName,
  sanitizeBranchName,
  RESERVED_SETTINGS_BRANCH_PREFIX,
} from '../paths/branch-name'
import { resolveDeploymentName } from '../operating-mode/deployment-name'
import type { BaseRefreshReport, WorkerShutdownRecord, WorkerStatusReport } from '../types'
import { getErrorMessage, isNodeError, redactCredentials } from '../utils/error'
import {
  readCarriedOverStatus,
  readWorkerStatusStartedAt,
  writeWorkerStatus,
} from '../task-queue/worker-status'
import { CANOPYCMS_VERSION } from '../version'
import { workerLog, workerLogWarn, workerLogError } from './log'
import { DEFAULT_SCHEMA_HOLD_MAX_MS, readCarriedBaseHold } from './schema-gate'
import type { WorkerContext } from './worker-context'
import { GitHubMirror, type MirrorSession } from './github-mirror'
import {
  SharedRepoRefusalError,
  UntrustedRepoConfigError,
  assertSharedRepoConfig,
  sharedRepoGit,
} from './shared-repo-git'
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
  /** Path to workspace root on EFS (e.g., /mnt/efs) */
  workspacePath: string
  /**
   * A directory only this worker can write, never on the shared filesystem: it holds the private
   * GitHub mirror, the one repository any git command carrying the credential runs in
   * (worker/github-mirror.ts). The AWS worker passes systemd's `StateDirectory=`. Default: a
   * directory under `os.tmpdir()`, which the worker refuses unless it owns it and no one else can
   * write to it.
   */
  stateDirectory?: string
  /** GitHub owner (e.g., 'acme') */
  githubOwner: string
  /** GitHub repo name (e.g., 'site') */
  githubRepo: string
  /** Called periodically to update the auth metadata cache on EFS. */
  refreshAuthCache?: AuthCacheRefresher
  /** Task queue poll interval in ms (default: 5000) */
  taskPollInterval?: number
  /** Git sync interval in ms (default: 5 * 60 * 1000) */
  gitSyncInterval?: number
  /** Auth cache refresh interval in ms (default: 15 * 60 * 1000) */
  authCacheRefreshInterval?: number
  /** Base branch name (default: detected at start(); see `resolveBaseBranch`) */
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
   * Longest the git sync holds the base branch for content naming entry schemas the serving
   * editor does not define, before advancing anyway (default: 30 minutes). See worker/schema-gate.ts.
   */
  schemaHoldMaxMs?: number
  /**
   * Worker lock staleness TTL in ms (default 60000, minimum 2000). The holder
   * refreshes the heartbeat at half this interval; a lock whose heartbeat is
   * older than this is abandoned and taken over by the next worker to start.
   */
  lockStaleMs?: number
  /**
   * How long `stop()` waits for in-flight work before aborting it, in ms
   * (default {@link DEFAULT_DRAIN_DEADLINE_MS}). An entrypoint's process
   * manager must allow this plus {@link ABORT_GRACE_MS} before it kills the
   * process.
   */
  drainDeadlineMs?: number
}

/** `target` with symlinks resolved as far as it exists, so a link cannot hide where it lands. */
async function realpathOfNearest(target: string): Promise<string> {
  const missing: string[] = []
  let current = path.resolve(target)
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

/** Per workspace, so two workers on one host (tests, dev) never share a mirror. */
function defaultStateDirectory(workspacePath: string): string {
  const key = createHash('sha256').update(path.resolve(workspacePath)).digest('hex').slice(0, 16)
  return path.join(os.tmpdir(), `canopycms-worker-${key}`)
}

/** How many refs a refusal to replace remote.git names before summarising the rest. */
const MAX_REFS_LISTED = 20

/** A refusal to replace a poisoned remote.git because it holds work GitHub does not have. */
class RemoteGitKeptError extends Error {}

/**
 * Every ref in the bare repo at `gitDir` outside the GitHub tracking namespace, which only ever
 * holds GitHub's own branches, mapped to the object it names. A ref missing from this list is one
 * a replacement would discard unchecked, so it throws when git reports anything on stderr
 * (`for-each-ref` skips a ref it cannot read with only a warning and exit 0) and when git is killed
 * by a signal, which simple-git otherwise resolves as empty output.
 */
async function listRemoteGitRefs(gitDir: string): Promise<Map<string, string>> {
  let stderr = ''
  const output = await sharedRepoGit(gitDir, 'bare', { errors: failOnSignalExit })
    .outputHandler((_command, _stdout, err) => {
      err.on('data', (chunk: Buffer | string) => {
        stderr += String(chunk)
      })
    })
    .raw(['for-each-ref', '--format=%(objectname) %(refname)'])
  if (stderr.trim() !== '') throw new Error(stderr.trim())
  const refs = new Map<string, string>()
  for (const line of output.split('\n')) {
    const space = line.indexOf(' ')
    if (space === -1) continue
    const ref = line.slice(space + 1)
    if (!ref.startsWith(GITHUB_TRACKING_REF_PREFIX)) refs.set(ref, line.slice(0, space))
  }
  return refs
}

function sameRefs(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([ref, id]) => b.get(ref) === id)
}

const DEFAULT_TASK_TIMEOUT = 60_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_LOCK_STALE_MS = 60_000
/**
 * 90s fits inside an EC2 spot interruption's two-minute notice with room to
 * exit, and exceeds the default task timeout, so a task already running when
 * the drain begins normally finishes or times out on its own.
 */
export const DEFAULT_DRAIN_DEADLINE_MS = 90_000
/**
 * After aborting at the drain deadline, how long to let the aborted work
 * unwind: this, or the deadline itself if that is shorter.
 */
const ABORT_GRACE_MS = 5_000

/** Whether every promise settles within `ms`. */
async function settlesWithin(operations: Promise<unknown>[], ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.allSettled(operations).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * CMS Worker daemon: the operations Lambda, which has no internet, cannot
 * perform -- draining the task queue, syncing the bare repo with GitHub,
 * rebasing branch workspaces, and refreshing the auth metadata cache through a
 * pluggable callback.
 *
 * Auth-agnostic (no specific auth provider) and cloud-agnostic (git/Octokit
 * directly, no AWS SDK dependency).
 */
/** Why a worker stopped itself; see {@link CmsWorker.selfStopped}. */
export interface WorkerSelfStop {
  reason: string
}

// Shown as the last shutdown's reason in System health, so it reads as a sentence there.
const LOCK_COMPROMISED_REASON = 'the worker lost its lock on the shared workspace'

/**
 * Take the cross-host worker lock (see {@link CmsWorker}'s `acquireLock`), retrying for up to
 * `waitMs`. Rejects with ELOCKED while another holder keeps it fresh.
 */
function lockWorkerTaskDir(
  taskDir: string,
  lockStaleMs: number,
  options: { waitMs?: number; onCompromised: (err: Error) => void },
): Promise<() => Promise<void>> {
  const waitMs = options.waitMs ?? 0
  const intervalMs = Math.max(250, Math.min(5_000, Math.floor(lockStaleMs / 4)))
  return lockfile.lock(taskDir, {
    lockfilePath: path.join(taskDir, '.worker-lock'),
    stale: lockStaleMs,
    onCompromised: options.onCompromised,
    ...(waitMs > 0
      ? {
          retries: {
            retries: Math.ceil(waitMs / intervalMs),
            factor: 1,
            minTimeout: intervalMs,
            maxTimeout: intervalMs,
          },
        }
      : {}),
  })
}

/**
 * The fields a new status snapshot carries from the previous file: `lastFatalError` and
 * `lastShutdown` (task-queue/worker-status.ts) and the schema gate's hold, so its bound keeps
 * counting from the first worker that saw each schema missing.
 */
async function readCarriedFields(
  taskDir: string,
): Promise<Pick<WorkerStatusReport, 'lastFatalError' | 'lastShutdown' | 'baseHold'>> {
  const { lastFatalError, lastShutdown } = await readCarriedOverStatus(taskDir)
  const baseHold = await readCarriedBaseHold(taskDir)
  return {
    ...(lastFatalError ? { lastFatalError } : {}),
    ...(lastShutdown ? { lastShutdown } : {}),
    ...(baseHold ? { baseHold } : {}),
  }
}

/**
 * Record a worker that failed before {@link CmsWorker.start} as `lastFatalError` (phase
 * `startup`), so System health and the API's not-ready answer say why. For an entrypoint's own
 * boot steps (its environment, its secrets); start() records its own failures.
 *
 * Writes under the worker lock like every status write, and writes nothing while the lock looks
 * held (fresher than twice `lockStaleMs`, see recordLockLoss): its holder owns the file. Never
 * throws, since its caller is already exiting.
 */
export async function recordWorkerStartupFailure(options: {
  workspacePath: string
  error: unknown
  lockStaleMs?: number
}): Promise<void> {
  const taskDir = path.join(options.workspacePath, '.tasks')
  let release: (() => Promise<void>) | undefined
  try {
    await fs.mkdir(taskDir, { recursive: true })
    // Twice the usual staleness, for the reason recordLockLoss gives: a lost record costs
    // nothing, a removed live lock costs a worker.
    release = await lockWorkerTaskDir(taskDir, 2 * (options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS), {
      onCompromised: (err) =>
        workerLogError('Worker lock lost while recording a startup failure:', getErrorMessage(err)),
    })
    const now = new Date().toISOString()
    const { lastShutdown, baseHold } = await readCarriedFields(taskDir)
    await writeWorkerStatus(taskDir, {
      version: 1,
      workerVersion: CANOPYCMS_VERSION,
      startedAt: now,
      updatedAt: now,
      ...(lastShutdown ? { lastShutdown } : {}),
      ...(baseHold ? { baseHold } : {}),
      lastFatalError: {
        // [REDACT] Served to the browser by the admin panel and the API's not-ready answer.
        message: redactCredentials(getErrorMessage(options.error)),
        at: now,
        phase: 'startup',
        workerStartedAt: now,
      },
    })
  } catch (err) {
    workerLogError(
      isNodeError(err) && err.code === 'ELOCKED'
        ? 'Not recording the startup failure: another worker holds the lock and owns worker-status.json'
        : `Failed to record the startup failure: ${getErrorMessage(err)}`,
    )
  } finally {
    await release?.().catch(() => {})
  }
}

export class CmsWorker {
  // Built by ensureGitHubAuth(), not the constructor, so a credential config
  // error is throwable somewhere start()'s catch can record it. A FIELD rather
  // than a getter because two test files assign a mock over it (the same
  // INVARIANT worker-context.ts states), and ensureGitHubAuth() will not
  // overwrite one that is already there.
  private octokit!: Octokit
  private taskDir: string
  private remoteGitPath: string
  private stateDirectory: string
  private githubMirror: GitHubMirror
  private contentBranchesPath: string
  // Set by the constructor when configured, else by resolveBaseBranch() in
  // start(); read through the two getters below, which throw until then.
  // Workspace directories use sanitized names; git refs (fetch/rev-list/merge
  // against remote.git) must keep using the raw `baseBranch` name.
  // Computed once so both filesystem call sites agree instead of re-deriving it
  // and risking drift.
  private resolvedBaseBranch?: { name: string; sanitized: SanitizedBranchName }
  // This deployment's own settings branch — see CmsWorkerConfig.deploymentName.
  // `pushSettingsBranches` pushes ONLY this branch, never another
  // `canopycms-settings-*` it happens to find locally. Resolved lazily by
  // ensureSettingsBranch(), NOT in the constructor (see that method):
  // `undefined` means "not resolved yet", never "no settings branch".
  private settingsBranchResolved?: string
  private activeTimeouts = new Set<NodeJS.Timeout>()
  private running = false
  // In-flight loop iterations, each labelled for the drain's log lines and
  // `lastShutdown.abandoned`.
  private activeOperations = new Map<Promise<void>, string>()
  private stopping: Promise<void> | null = null
  private drainDeadlineMs: number
  // Aborted when a draining stop() reaches its deadline; see WorkerContext.
  private shutdownController = new AbortController()
  private maxTasksPerCycle: number
  private taskTimeoutMs: number
  private maxRetries: number
  private lockFilePath: string
  private lockStaleMs: number
  private schemaHoldMaxMs: number
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
  // Set by a lock compromise that starts the stop, so the drain records it; see selfStopped.
  private lockLostMessage?: string
  // Who wrote worker-status.json when this worker took the lock: until its own first write
  // lands, the file is still that worker's, and recordLockLoss may replace it.
  private statusWriterAtLock?: string
  private settleSelfStopped!: (stop: WorkerSelfStop) => void

  /**
   * Settles once the worker has stopped for a reason it chose itself (its lock was
   * compromised), after the drain and its record in worker-status.json. Never settles for a
   * stop() the entrypoint asked for. Nothing else ends the process, so an entrypoint exits
   * non-zero on it and its process manager starts a fresh worker.
   */
  readonly selfStopped: Promise<WorkerSelfStop> = new Promise((resolve) => {
    this.settleSelfStopped = resolve
  })

  constructor(private config: CmsWorkerConfig) {
    this.taskDir = path.join(config.workspacePath, '.tasks')
    // Absolute: git can read a relative path such as `sub/remote.git` as a remote's name and use
    // that remote's `remote.<name>.url` from a clone's config; never one that starts with '/'.
    this.remoteGitPath = path.join(path.resolve(config.workspacePath), 'remote.git')
    this.stateDirectory = path.resolve(
      config.stateDirectory ?? defaultStateDirectory(config.workspacePath),
    )
    this.contentBranchesPath = path.join(config.workspacePath, 'content-branches')
    if (config.baseBranch !== undefined) this.setBaseBranch(config.baseBranch)
    this.maxTasksPerCycle = config.maxTasksPerCycle ?? 10
    this.taskTimeoutMs = config.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
    this.lockFilePath = path.join(config.workspacePath, '.tasks', '.worker-lock')
    this.lockStaleMs = config.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
    this.drainDeadlineMs = config.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS
    this.contentRoot = config.contentRoot ?? 'content'
    this.schemaHoldMaxMs = config.schemaHoldMaxMs ?? DEFAULT_SCHEMA_HOLD_MAX_MS
    this.githubMirror = new GitHubMirror(
      this.stateDirectory,
      this.remoteGitPath,
      this.taskTimeoutMs,
    )
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
      this.statusReport = {
        version: 1,
        workerVersion: CANOPYCMS_VERSION,
        startedAt: now,
        updatedAt: now,
      }
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
   * the method existing: an entrypoint constructs the worker before calling
   * start(), so a throw during `new CmsWorker(...)` lands BEFORE start()'s
   * catch, which records `lastFatalError` for every entrypoint. Only one that
   * calls `recordWorkerStartupFailure` (canopycms-cdk/worker/run.ts does) would
   * record it otherwise; under systemd `Restart=always` the rest crash-loop
   * every ~5s with System health showing the worker 'absent' and no reason.
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
      schemaHoldMaxMs: this.schemaHoldMaxMs,
      taskTimeoutMs: this.taskTimeoutMs,
      maxTasksPerCycle: this.maxTasksPerCycle,
      maxRetries: this.maxRetries,
      log: this.log,
      octokit: () => this.octokitClient(),
      buildGitHubUrl: () => this.buildGitHubUrl(),
      githubMirror: () => this.githubMirror,
      refreshGitHubCredential: () => this.refreshGitHubCredential(),
      branchWorkspacePath: (branchRefName) => this.branchWorkspacePath(branchRefName),
      executeTask: (task, signal) => this.executeTask(task, signal),
      pushBranchToGitHub: (branch, signal) => this.pushBranchToGitHub(branch, signal),
      isRunning: () => this.running,
      isDraining: () => this.stopping !== null,
      shutdownSignal: () => this.shutdownController.signal,
      ensureStatusReport: () => this.ensureStatusReport(),
      ensureSettingsBranch: () => this.ensureSettingsBranch(),
      afterConflictDetectedForTesting: () => this.afterConflictDetectedForTesting(),
      afterRebaseCompletedForTesting: () => this.afterRebaseCompletedForTesting(),
    }
  }

  /**
   * Take the worker lock, provision, run the first sync, then schedule the
   * loops. All of it is tracked as an operation, so a stop() that lands
   * mid-startup -- during the lock acquisition, a first-boot clone, the first
   * sync -- drains it before releasing the lock, and start() then resolves
   * without scheduling anything.
   */
  start(): Promise<void> {
    const starting = this.startUnderLock()
    this.trackOperation('startup', starting)
    return starting
  }

  private async startUnderLock(): Promise<void> {
    // A stop() that already finished has nothing left to release a lock taken now.
    if (this.stopping) return
    this.running = true
    workerLog('CMS Worker starting...')
    // Each attempt is a new worker to worker-status.json: a start() retried after a failed one
    // must not match that failure's `workerStartedAt` (see readCarriedOverStatus).
    this.statusReport = undefined
    this.ensureStatusReport()

    await this.acquireLock()

    // Replace the previous holder's status file now: the first sync can take
    // minutes, and until then System health would report the old worker's
    // version. Best-effort, like the startup-failure write below. The previous
    // `lastFatalError` rides along in this snapshot only, so a crash loop keeps
    // its alert between restarts while the first successful sync still clears
    // it. Two fields carry into the report itself: `lastShutdown`, which
    // describes the last worker that ran until this worker's own stop() replaces it,
    // and the schema gate's hold, so its bound keeps counting from the first
    // worker that saw each schema missing.
    try {
      const { lastFatalError, lastShutdown, baseHold } = await readCarriedFields(this.taskDir)
      const report = this.ensureStatusReport()
      if (lastShutdown) report.lastShutdown = lastShutdown
      if (baseHold) report.baseHold = baseHold
      await writeWorkerStatus(this.taskDir, {
        ...report,
        ...(lastFatalError ? { lastFatalError } : {}),
      })
    } catch (err) {
      workerLogError(
        'Failed to write worker status after acquiring the lock:',
        getErrorMessage(err),
      )
    }
    // After the carry-over, not before: a stop() during the lock acquisition
    // writes this report, which must still hold what the previous worker left.
    if (this.stopping) return

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

      // Same again. NaN would never expire a schema hold, which is the one
      // thing the bound exists to prevent.
      if (!Number.isFinite(this.schemaHoldMaxMs) || this.schemaHoldMaxMs < 0) {
        throw new Error(
          `CmsWorker: schemaHoldMaxMs must be a finite, non-negative number of milliseconds (got ${this.schemaHoldMaxMs})`,
        )
      }

      // BEFORE ensureRemoteGit(): its clone is the first thing to use the
      // credential, and its catch blames the repository rather than the
      // credential. See preflightGitHubAppAuth().
      await this.preflightGitHubAppAuth()

      await this.ensureStateDirectoryIsPrivate()
      await this.githubMirror.ensure()
      await this.resolveBaseBranch()
      await this.ensureRemoteGit()
      await this.recordBaseBranchInRemoteHead()

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

      // Tracked like loop iterations, so a stop() during the first sync drains it.
      const initialTasks: Promise<void>[] = [this.trackOperation('git sync', this.syncGit())]
      if (this.config.refreshAuthCache) {
        initialTasks.push(this.trackOperation('auth cache refresh', this.refreshAuthCache()))
      }
      await Promise.allSettled(initialTasks)
    } catch (err) {
      // A drain cut startup short: stop() owns the lock and the status file now.
      if (this.stopping) {
        workerLog(`Startup ended by the drain: ${redactCredentials(getErrorMessage(err))}`)
        return
      }
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
        workerStartedAt: report.startedAt,
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

    if (this.stopping) return

    const taskInterval = this.config.taskPollInterval ?? 5_000
    const gitInterval = this.config.gitSyncInterval ?? 5 * 60_000

    this.scheduleLoop('task queue', () => this.processTaskQueue(), taskInterval)
    // The wrapper, not syncGit() itself: a failed sync is where a rotated or
    // revoked GitHub credential is noticed. start()'s own initial syncGit()
    // above stays unwrapped -- there is no stale credential to refresh one line
    // after reading it at boot.
    this.scheduleLoop('git sync', () => this.syncGitWithCredentialRefresh(), gitInterval)

    if (this.config.refreshAuthCache) {
      const cacheInterval = this.config.authCacheRefreshInterval ?? 15 * 60_000
      this.scheduleLoop('auth cache refresh', () => this.refreshAuthCache(), cacheInterval)
      workerLog(`  Auth cache refresh: every ${cacheInterval / 1000}s`)
    }

    workerLog('CMS Worker started')
    workerLog(`  Task queue poll: every ${taskInterval / 1000}s`)
    workerLog(`  Git sync: every ${gitInterval / 1000}s`)
  }

  /**
   * Drain, then release the worker lock. Idempotent: a second call returns the
   * first call's promise.
   *
   * 1. Stop taking work: no loop starts another iteration, and none claims
   *    another task or starts another sync stage or branch rebase (each checks
   *    `isDraining()` at its boundaries).
   * 2. Wait up to the deadline (`drainDeadlineMs`, or `deadlineMs` for this
   *    call) for what is already in flight, startup included.
   * 3. At the deadline, abort it through `shutdownSignal()`: a task's git push
   *    and GitHub calls are killed and the task is released to pending with no
   *    retry spent; a sync's fetch or settings push is killed. A branch rebase
   *    is never aborted, because a rebase killed mid-branch is recovered
   *    lossily; anything still unsettled after a short grace is abandoned to
   *    the process exit.
   * 4. Record `lastShutdown` in worker-status.json -- only while this worker
   *    still holds the lock, or after a compromise that started this stop once
   *    it has retaken it (recordLockLoss) -- and release the lock. Release comes last, so a successor starts
   *    only once this worker's work has settled or been abandoned.
   */
  stop(options: { reason?: string; deadlineMs?: number } = {}): Promise<void> {
    // A later call cannot restart the drain, but deadline 0 (a lock compromise)
    // still cuts the running one short.
    if (this.stopping && options.deadlineMs === 0) this.shutdownController.abort()
    this.stopping ??= this.drainAndStop(
      options.reason ?? 'stop requested',
      options.deadlineMs ?? this.drainDeadlineMs,
    )
    return this.stopping
  }

  private async drainAndStop(reason: string, deadlineMs: number): Promise<void> {
    const startedAt = Date.now()
    this.running = false
    for (const t of this.activeTimeouts) {
      clearTimeout(t)
    }
    this.activeTimeouts.clear()

    const inFlight = [...this.activeOperations.values()]
    workerLog(
      inFlight.length > 0
        ? `Draining (${reason}): waiting up to ${deadlineMs / 1000}s for ${inFlight.join(', ')}`
        : `Draining (${reason}): nothing in flight`,
    )

    let abandoned: string[] = []
    if (!(await settlesWithin([...this.activeOperations.keys()], deadlineMs))) {
      abandoned = [...new Set(this.activeOperations.values())]
      workerLogWarn(`Drain deadline (${deadlineMs / 1000}s) hit, aborting: ${abandoned.join(', ')}`)
      this.shutdownController.abort()
      const graceMs = Math.min(ABORT_GRACE_MS, this.drainDeadlineMs)
      if (!(await settlesWithin([...this.activeOperations.keys()], graceMs))) {
        workerLogError(
          `Still running ${graceMs / 1000}s after the abort, abandoned to the exit: ${[
            ...new Set(this.activeOperations.values()),
          ].join(', ')}`,
        )
      }
    }

    const drainMs = Date.now() - startedAt
    const shutdown: WorkerShutdownRecord = {
      reason,
      at: new Date().toISOString(),
      workerStartedAt: this.ensureStatusReport().startedAt,
      outcome: abandoned.length > 0 ? 'deadline' : 'drained',
      drainMs,
      ...(abandoned.length > 0 ? { abandoned } : {}),
    }
    if (this.releaseLockFn) {
      const report = this.ensureStatusReport()
      report.lastShutdown = shutdown
      await writeWorkerStatus(this.taskDir, report).catch((err) =>
        workerLogError('Failed to write worker status on shutdown:', getErrorMessage(err)),
      )
    } else if (this.lockLostMessage !== undefined) {
      await this.recordLockLoss(shutdown, this.lockLostMessage)
    }
    await this.releaseLock()
    workerLog(
      abandoned.length > 0
        ? `CMS Worker stopped after the drain deadline (${(drainMs / 1000).toFixed(1)}s)`
        : `CMS Worker stopped: drained in ${(drainMs / 1000).toFixed(1)}s`,
    )
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
      this.releaseLockFn = await lockWorkerTaskDir(this.taskDir, this.lockStaleMs, {
        onCompromised: (err) => {
          // The heartbeat could not be maintained (lock deleted or taken over),
          // so another worker may now be consuming the queue: abort at once,
          // with no drain, to restore the single-consumer invariant. Unless a
          // stop was already under way, this worker chose to stop, which
          // selfStopped reports once the drain has recorded it.
          workerLogError('Worker lock compromised, shutting down:', getErrorMessage(err))
          this.releaseLockFn = null // the lock is already lost; nothing to release
          const selfStop = this.stopping === null
          if (selfStop) this.lockLostMessage = redactCredentials(getErrorMessage(err))
          const stopped = this.stop({ reason: LOCK_COMPROMISED_REASON, deadlineMs: 0 })
          if (selfStop) {
            void stopped.then(() => this.settleSelfStopped({ reason: LOCK_COMPROMISED_REASON }))
          }
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
    this.statusWriterAtLock = await readWorkerStatusStartedAt(this.taskDir).catch(() => undefined)
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
   * Record a lock compromise in worker-status.json, under the lock: retake it, waiting out its
   * staleness window, and write only if that succeeds and the file is still this worker's (or
   * the one it took the lock from). A worker that took the lock over keeps it fresh, or has
   * written the file since, and owns it, so nothing is written. A heartbeat this worker merely
   * failed to refresh (an EFS hiccup) goes stale, and the record lands where the restarted
   * worker carries `lastShutdown` forward. The restart waits for it: 65 s at the default `lockStaleMs`.
   */
  private async recordLockLoss(shutdown: WorkerShutdownRecord, message: string): Promise<void> {
    let release: (() => Promise<void>) | undefined
    try {
      // Twice the usual staleness: a successor's live heartbeat can look a refresh interval
      // plus an EFS attribute-cache window old from here, and taking it would remove its lock.
      release = await lockWorkerTaskDir(this.taskDir, this.lockStaleMs * 2, {
        // A refresh failure fires the compromise once this worker's own lock has gone
        // unrefreshed for `lockStaleMs`, or up to a second less (proper-lockfile rounds the
        // first mtime up). So the wait covers the remaining `lockStaleMs`, that second and a
        // retry interval, and stays inside the unit's TimeoutStopSec when a SIGTERM lands
        // mid-wait. A deleted lock is retaken at once; a foreign mtime is a successor's.
        waitMs: this.lockStaleMs + 2_000,
        onCompromised: (err) =>
          workerLogError('Worker lock lost again while recording the loss:', getErrorMessage(err)),
      })
      const report = this.ensureStatusReport()
      // A successor that took the lock and released it during the wait owns the file now.
      const writtenBy = await readWorkerStatusStartedAt(this.taskDir)
      if (
        writtenBy !== undefined &&
        writtenBy !== report.startedAt &&
        writtenBy !== this.statusWriterAtLock
      ) {
        workerLogError(
          'Not recording the lock loss: another worker has written worker-status.json since',
        )
        return
      }
      report.lastShutdown = shutdown
      report.lastFatalError = {
        message: `The worker lost its lock on the shared workspace and stopped; it restarts on its own. ${message}`,
        at: shutdown.at,
        phase: 'run',
        workerStartedAt: report.startedAt,
      }
      await writeWorkerStatus(this.taskDir, report)
    } catch (err) {
      workerLogError(
        isNodeError(err) && err.code === 'ELOCKED'
          ? 'Not recording the lock loss: another worker holds the lock and owns worker-status.json'
          : `Failed to record the lock loss: ${getErrorMessage(err)}`,
      )
    } finally {
      await release?.().catch(() => {})
    }
  }

  /** Register `operation` as in flight under `label` until it settles. */
  private trackOperation(label: string, operation: Promise<void>): Promise<void> {
    this.activeOperations.set(operation, label)
    void operation.finally(() => this.activeOperations.delete(operation)).catch(() => {})
    return operation
  }

  /**
   * Run `fn` repeatedly, the next invocation starting `interval` ms after the
   * previous one COMPLETES. setTimeout chaining rather than setInterval, so
   * executions cannot overlap when one runs longer than the interval.
   */
  private scheduleLoop(label: string, fn: () => Promise<void>, interval: number): void {
    const run = () => {
      if (!this.running) return
      const timeout = setTimeout(async () => {
        this.activeTimeouts.delete(timeout)
        const operation = fn().catch((err) => {
          workerLogError('Worker loop error:', err instanceof Error ? err.message : err)
        })
        await this.trackOperation(label, operation)
        run()
      }, interval)
      this.activeTimeouts.add(timeout)
    }
    run()
  }

  private get baseBranch(): string {
    return this.requireBaseBranch().name
  }

  private get sanitizedBaseBranch(): SanitizedBranchName {
    return this.requireBaseBranch().sanitized
  }

  private requireBaseBranch(): { name: string; sanitized: SanitizedBranchName } {
    if (!this.resolvedBaseBranch) {
      throw new Error('CmsWorker: the base branch is resolved by start(); it has not run yet')
    }
    return this.resolvedBaseBranch
  }

  private setBaseBranch(name: string): void {
    this.resolvedBaseBranch = { name, sanitized: sanitizeBranchName(name) }
  }

  /**
   * An unconfigured base branch is the one remote.git's HEAD names, which is what the Lambda
   * reads too (GitManager.detectBaseBranch); before remote.git exists, it is GitHub's default
   * branch, which the clone then records as that HEAD. So it is too when remote.git has no branch
   * outside the settings namespace: no base branch is there for HEAD to name, and ensureRemoteGit
   * replaces it from GitHub. Never assumes 'main'.
   */
  private async resolveBaseBranch(): Promise<void> {
    if (this.resolvedBaseBranch) return
    const undetermined = (err: unknown) =>
      new Error(
        `CANOPYCMS_BASE_BRANCH is not set (the CDK construct's \`baseBranch\` prop), and the ` +
          `base branch could not be determined from ${this.remoteGitPath} or GitHub: ` +
          `${redactCredentials(getErrorMessage(err))}. Set it to the branch editing branches fork ` +
          `from, or, if remote.git is damaged, delete ${this.remoteGitPath} and restart to re-clone.`,
      )
    let remoteGitExists: boolean
    try {
      remoteGitExists = await fs.stat(this.remoteGitPath).then(
        () => true,
        (err: unknown) => {
          if (isNodeError(err) && err.code === 'ENOENT') return false
          throw err
        },
      )
    } catch (err) {
      throw undetermined(err)
    }
    // Before the first git to read it, and on its own: a refusal is recorded as itself, not as a
    // base branch to configure or a remote.git to delete.
    if (remoteGitExists) await assertSharedRepoConfig(this.remoteGitPath, 'bare')
    let name: string
    try {
      const fromRemoteGit = remoteGitExists && (await this.hasContentBranch(this.remoteGitPath))
      name = fromRemoteGit
        ? await readHeadBranch(this.remoteGitPath, sharedRepoGit(this.remoteGitPath, 'bare'))
        : (
            await this.octokitClient().repos.get({
              owner: this.config.githubOwner,
              repo: this.config.githubRepo,
            })
          ).data.default_branch
    } catch (err) {
      throw undetermined(err)
    }
    this.setBaseBranch(name)
    workerLog(`Base branch: '${name}' (detected; CANOPYCMS_BASE_BRANCH is not set)`)
  }

  /** Whether the bare repo at `gitDir` has a branch that is not a settings branch. */
  private async hasContentBranch(gitDir: string): Promise<boolean> {
    const branches = await sharedRepoGit(gitDir, 'bare', { errors: failOnSignalExit }).raw([
      'for-each-ref',
      '--format=%(refname:strip=2)',
      'refs/heads/',
    ])
    return branches
      .split('\n')
      .some((branch) => branch !== '' && !isSettingsBranchName(branch, this.ensureSettingsBranch()))
  }

  /**
   * Point remote.git's HEAD at the base branch this worker uses, so a Lambda left to detect it
   * (GitManager.detectBaseBranch) reads the same name. Only the worker writes it, at boot under
   * the worker lock, and in a fresh clone before it is renamed into place, so no Lambda reads the
   * clone's GitHub-default HEAD first; a Lambda reads it once per process.
   */
  private async recordBaseBranchInRemoteHead(gitDir = this.remoteGitPath): Promise<void> {
    const ref = `refs/heads/${this.baseBranch}`
    const current = await readHeadBranch(gitDir, sharedRepoGit(gitDir, 'bare')).catch(
      () => undefined,
    )
    if (current === this.baseBranch) return
    // Pinned: moving HEAD fires remote.git's reference-transaction hooks.
    await sharedRepoGit(gitDir, 'bare').raw(['symbolic-ref', 'HEAD', ref])
    workerLog(`${path.basename(gitDir)} HEAD now names the base branch '${this.baseBranch}'`)
  }

  /**
   * Whether the bare repo at `gitDir` has a local `refs/heads/<baseBranch>`.
   *
   * The repository is named outright (sharedRepoGit's GIT_DIR), so this also
   * works where `safe.bareRepository=explicit` refuses cwd-based discovery of
   * bare repos.
   *
   * Deliberately omits `--quiet`: simple-git treats a task as failed only when
   * the process exits non-zero AND writes to stderr, so a silent-on-failure
   * `--verify` would leave a missing branch indistinguishable from success.
   * Without `--quiet`, `rev-parse --verify` writes "fatal: ..." to stderr,
   * which is what makes simple-git reject the promise here.
   */
  private async verifyBaseBranchExists(gitDir: string): Promise<void> {
    await sharedRepoGit(gitDir, 'bare').raw([
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
    const git = sharedRepoGit(gitDir, 'bare')
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
   * Best-effort: without these settings remote.git still works, and a boot that
   * cannot write its own config has a louder problem to report elsewhere.
   */
  private async applyRemoteGitConfig(gitDir: string): Promise<void> {
    try {
      await ensureRemoteGitConfig(gitDir, sharedRepoGit(gitDir, 'bare'))
    } catch (err) {
      workerLogWarn(`Could not apply remote.git config in ${gitDir}: ${getErrorMessage(err)}`)
    }
  }

  /**
   * Ensure the remote.git bare repo exists, seeding it from GitHub on first run.
   *
   * Seeded through the private mirror: the mirror fetches from GitHub, and a fresh bare repo
   * receives its branches by local push, so no git command run against remote.git ever carries
   * the credential, and no token-bearing URL is ever written to EFS.
   *
   * Empty-remote guard: a fetch of an EMPTY GitHub repo (no commits, or a base branch never
   * pushed) succeeds and leaves a refs-less repo that `fs.stat` cannot tell from a healthy one, so
   * left unchecked it silently poisons remote.git and the stat short-circuit means it never heals.
   * The base branch is therefore verified right after seeding AND on the already-exists fast
   * path, where a poisoned remote.git is replaced (`replacePoisonedRemoteGit`).
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
      // At boot, so a refusal lands in worker-status.json as a startup failure, and first: the
      // scrub is git reading this config too. A refused config is never replaced: the refusal
      // reports that something wrote there, and listing the refs replacement would lose means
      // running git under that config.
      await assertSharedRepoConfig(this.remoteGitPath, 'bare')
      // SELF-HEAL, before anything else changes this repo: a remote.git cloned from GitHub by an
      // older worker recorded the token-bearing clone URL in its config.
      await this.scrubPersistedRemote(this.remoteGitPath)

      try {
        await this.verifyBaseBranchExists(this.remoteGitPath)
      } catch (err) {
        workerLogError(`remote.git base branch verification failed: ${getErrorMessage(err)}`)
        await this.replacePoisonedRemoteGit()
        return
      }
      await this.applyRemoteGitConfig(this.remoteGitPath)
      return // Already exists and has the base branch
    }

    workerLog('Initializing remote.git from GitHub...')
    const stagingPath = await this.seedRemoteGitStaging()
    await fs.rename(stagingPath, this.remoteGitPath)
    workerLog('remote.git initialized')
  }

  /**
   * Replace an existing remote.git that has no base branch with a fresh seed from GitHub, but only
   * when every ref in it names a commit a GitHub branch contains, so replacing it loses nothing.
   * Otherwise refuse, naming the refs at stake: unpushed work such as a settings branch.
   *
   * The refs are compared in the same mirror session that fetches GitHub and seeds the
   * replacement, and listed again just before the swap, since the Lambda can push into remote.git
   * while the seed runs. The swap is two renames, so a reader sees the old repo, the new one, or
   * for an instant neither, never a half-deleted one.
   */
  private async replacePoisonedRemoteGit(): Promise<void> {
    const poisoned =
      `remote.git at ${this.remoteGitPath} has no branch '${this.baseBranch}' (likely cloned ` +
      `while the GitHub repository was empty)`
    const notReplaced = (reason: string) =>
      new Error(`${poisoned}, and it was not replaced: ${reason}`)

    let refs: Map<string, string>
    try {
      refs = await listRemoteGitRefs(this.remoteGitPath)
    } catch (err) {
      throw notReplaced(
        `its refs could not all be read (${redactCredentials(getErrorMessage(err)).trim()}), so ` +
          `the worker cannot tell whether replacing it would lose work. Deleting ` +
          `${this.remoteGitPath} and restarting the worker re-clones it and discards every ref in it.`,
      )
    }

    // Only a base branch the listing confirms absent: a check that failed for any other reason
    // is no evidence the repo is poisoned.
    if (refs.has(`refs/heads/${this.baseBranch}`)) {
      throw new Error(
        `remote.git at ${this.remoteGitPath} has branch '${this.baseBranch}', but git could not ` +
          `verify it, so the worker will not replace remote.git. Restarting the worker checks again.`,
      )
    }

    workerLog(
      `remote.git has no branch '${this.baseBranch}': replacing it if GitHub has every ref in it`,
    )
    const stagingPath = await this.seedRemoteGitStaging(async (mirror) => {
      const unpushed: string[] = []
      for (const [ref, id] of refs) {
        if (!(await mirror.isOnGitHub(id))) unpushed.push(ref)
      }
      if (unpushed.length === 0) return
      const shown = unpushed.slice(0, MAX_REFS_LISTED)
      const more = unpushed.length - shown.length
      throw new RemoteGitKeptError(
        `${poisoned}, and it holds ${unpushed.length === 1 ? 'a ref' : `${unpushed.length} refs`} ` +
          `GitHub does not have, so the worker will not replace it: ${shown.join(', ')}` +
          `${more > 0 ? ` and ${more} more` : ''}. Deleting ${this.remoteGitPath} and restarting ` +
          `the worker re-clones it and discards ${unpushed.length === 1 ? 'that ref' : 'those refs'}.`,
      )
    }).catch((err: unknown) => {
      if (err instanceof RemoteGitKeptError) throw err
      throw notReplaced(redactCredentials(getErrorMessage(err)))
    })

    const discardStaging = () => fs.rm(stagingPath, { recursive: true, force: true })
    let current: Map<string, string>
    try {
      current = await listRemoteGitRefs(this.remoteGitPath)
    } catch (err) {
      await discardStaging()
      throw notReplaced(
        `its refs could not all be read again (${getErrorMessage(err).trim()}). Restarting the ` +
          `worker checks again.`,
      )
    }
    if (!sameRefs(refs, current)) {
      await discardStaging()
      throw notReplaced(
        'its refs changed while the worker seeded its replacement. Restarting the worker checks again.',
      )
    }

    const replaced = `${this.remoteGitPath}.replaced-${Date.now()}`
    try {
      await fs.rename(this.remoteGitPath, replaced)
    } catch (err) {
      await discardStaging()
      throw err
    }
    try {
      await fs.rename(stagingPath, this.remoteGitPath)
    } catch (err) {
      await fs.rename(replaced, this.remoteGitPath)
      await discardStaging()
      throw err
    }
    // A push that resolved remote.git before the rename can still land in the old repo; it is
    // kept when one did.
    const after = await listRemoteGitRefs(replaced).catch(() => null)
    if (after !== null && sameRefs(refs, after)) {
      // remote.git is already replaced, so a push still writing here costs only this directory.
      await fs
        .rm(replaced, { recursive: true, force: true, maxRetries: 3 })
        .catch((err: unknown) => {
          workerLogWarn(
            `Could not remove the replaced remote.git at ${replaced}: ${getErrorMessage(err)}`,
          )
        })
    } else {
      workerLogError(
        `Kept the replaced remote.git at ${replaced}: its refs changed as it was swapped out, so ` +
          `it may hold work GitHub does not have.`,
      )
    }
    workerLog('remote.git replaced')
  }

  /**
   * Seed a new bare repo from GitHub at `<remote.git>.cloning`, verified and configured, and
   * return its path for the caller to rename into place. `check` runs in the mirror session right
   * after the GitHub fetch, and its throw stops the seed. Throws with the staging directory gone.
   */
  private async seedRemoteGitStaging(
    check?: (mirror: MirrorSession) => Promise<void>,
  ): Promise<string> {
    // Seeded under a TEMP name and renamed into place only once verified, so a crash mid-seed
    // leaves only this staging directory, which the next boot deletes, rather than a poisoned
    // `remote.git` that fs.stat cannot distinguish from a healthy one.
    const stagingPath = `${this.remoteGitPath}.cloning`
    await fs.rm(stagingPath, { recursive: true, force: true })

    try {
      const githubUrl = await this.buildGitHubUrl()
      await this.githubMirror.exclusive(async (mirror) => {
        await mirror.fetchFromGitHub(githubUrl)
        await check?.(mirror)
        if ((await mirror.branchTip(this.baseBranch)) === null) {
          throw new Error(`GitHub has no branch '${this.baseBranch}'`)
        }
        await fs.mkdir(stagingPath)
        const staging = sharedRepoGit(stagingPath, 'bare')
        await staging.raw(['init', '--quiet', '--bare'])
        await mirror.seedBareRepository(stagingPath)
      })

      // The staging path is predictable, and so writable by the Lambda while seeding runs.
      await assertSharedRepoConfig(stagingPath, 'bare')
      await this.verifyBaseBranchExists(stagingPath)
      await this.recordBaseBranchInRemoteHead(stagingPath)
      await this.applyRemoteGitConfig(stagingPath)
    } catch (err) {
      if (!(err instanceof RemoteGitKeptError)) {
        workerLogError(`remote.git seeding failed: ${redactCredentials(getErrorMessage(err))}`)
      }
      // Deleting before throwing is what makes this recoverable: the next
      // start() sees no remote.git and re-clones, instead of sticking forever
      // behind a poisoned bare repo fs.stat alone cannot detect.
      await fs.rm(stagingPath, { recursive: true, force: true })
      if (err instanceof RemoteGitKeptError) throw err
      if (err instanceof SharedRepoRefusalError) {
        // Not the refusal's own advice: the directory it names is gone.
        throw new SharedRepoRefusalError(
          `Refusing to run git in ${stagingPath}: something wrote to it while the worker seeded ` +
            `remote.git from it` +
            (err instanceof UntrustedRepoConfigError
              ? ` (${err.keys.map((k) => k.key).join(', ')})`
              : '') +
            `, so it was removed. Find out what wrote there; restarting the worker seeds it again.`,
        )
      }
      throw new Error(
        `remote.git clone of ${this.config.githubOwner}/${this.config.githubRepo} failed or has no branch '${this.baseBranch}' - the GitHub repository may be empty, or the base branch may not exist. Push an initial commit to '${this.baseBranch}' and restart the worker (systemd will retry automatically).`,
      )
    }
    return stagingPath
  }

  /**
   * Refuse a state directory on the shared filesystem: the mirror there would be as writable by
   * the Lambda as remote.git is.
   */
  private async ensureStateDirectoryIsPrivate(): Promise<void> {
    const workspace = await realpathOfNearest(this.config.workspacePath)
    const state = await realpathOfNearest(this.stateDirectory)
    const relative = path.relative(workspace, state)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      throw new Error(
        `The worker's state directory (${this.stateDirectory}) is inside its shared workspace ` +
          `(${this.config.workspacePath}). It holds the repository the GitHub credential is used ` +
          `in, so it must be somewhere the CMS Lambda cannot write.`,
      )
    }
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

  private async pushBranchToGitHub(branch: string, signal?: AbortSignal): Promise<void> {
    return pushBranchToGitHub(this.ctx(), branch, signal)
  }

  /**
   * Resolve which GitHub credential this worker uses, once, and build the
   * Octokit client from it.
   *
   * DEFERRED out of the constructor deliberately, exactly as
   * `ensureSettingsBranch()` is and for the reason that method records:
   * `resolveWorkerGitHubAuth` throws for a half-configured credential (both
   * set, neither set, an unusable mint timeout or refresh interval), and a
   * throw during `new CmsWorker(...)` lands BEFORE start()'s catch, which
   * records `lastFatalError` for every entrypoint.
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

  private async refreshBaseBranchWorkspace(): Promise<BaseRefreshReport> {
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
