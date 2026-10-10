import type { SanitizedBranchName } from '../paths/types'
import type { Task, TaskQueueLogger } from '../task-queue/cms-task-queue'
import type { WorkerStatusReport } from '../types'
import type { GitHubGateway } from './github-gateway'

/**
 * The slice of {@link import('./cms-worker').CmsWorker} that its extracted
 * clusters (task-runner.ts, git-sync.ts, rebase.ts, history-rewrite.ts) may
 * reach — the ONLY channel between the class and that code. Each module narrows
 * it further with a `Pick<WorkerContext, ...>` alias, so a function's signature
 * names its real dependency set rather than the union.
 *
 * INVARIANT: everything below the divider is a FUNCTION, resolved by CALLING
 * back onto the live instance and never snapshotted, and `CmsWorker.ctx()`
 * builds a fresh context per call. That is load-bearing, not stylistic. The
 * `cms-worker*.test.ts` files drive the class by reaching through the instance:
 * they INSTALL a GitHub gateway aimed at a local fixture repository (and an
 * Octokit stub) with `useLocalGitHubGateway` (test-utils/worker-gateway.ts),
 * REPLACE `executeTask` and `pushBranchToGitHub`, set `running` directly, and
 * SUBCLASS to override the two rebase test hooks. A context that captured any
 * of those at construction would hand the extracted code the pre-test value --
 * which for the gateway means a test's push going to github.com for real.
 * Functions (`ctx.github()`) make the late binding visible at every call site,
 * which a getter would hide.
 */
export interface WorkerContext {
  // --- Resolved once in the constructor and never mutated. Safe to copy. ---

  /**
   * The base branch's RAW git ref name. Git refs (fetch/rev-list/merge against
   * it) must use this; filesystem paths must use `sanitizedBaseBranch`.
   */
  readonly baseBranch: string
  /**
   * The base branch's workspace DIRECTORY name, computed once so every
   * filesystem call site agrees instead of re-deriving it.
   */
  readonly sanitizedBaseBranch: SanitizedBranchName
  /** `{workspacePath}/.tasks` — the task queue and worker-status.json. */
  readonly taskDir: string
  /**
   * `{workspacePath}/remote.git` — the shared bare repo. The worker fetches
   * into and pushes from a workspace clone against this path, never the
   * clone's `origin`: that holds the path the CLONING process saw (usually
   * the Lambda), and the clone's config is Lambda-writable.
   */
  readonly remoteGitPath: string
  /** `{workspacePath}/content-branches` — the branch workspace root. */
  readonly contentBranchesPath: string
  /** Content root directory name relative to repo root (default: 'content'). */
  readonly contentRoot: string
  /** Longest the schema gate holds the base branch before advancing anyway (worker/schema-gate.ts). */
  readonly schemaHoldMaxMs: number
  /** Per-task timeout in ms; also simple-git's inactivity block timeout. */
  readonly taskTimeoutMs: number
  /** Max tasks to process per `processTaskQueue` cycle. */
  readonly maxTasksPerCycle: number
  /** Default max retries for a failed task that does not carry its own. */
  readonly maxRetries: number
  /** Task-queue debug logger. */
  readonly log: TaskQueueLogger

  // --- Live dispatch back onto the instance. See the note above: these MUST
  // --- stay functions, and must never be cached by a caller.

  /**
   * The worker's GitHub gateway (worker/github-gateway.ts), read at call time:
   * every use of the GitHub credential and of Octokit goes through it.
   */
  github(): GitHubGateway
  /**
   * Workspace directory for a branch named by its GIT REF name — the form task
   * payloads carry. Sanitizes; `feature/x` lives in `feature-x`.
   */
  branchWorkspacePath(branchRefName: string): string
  /**
   * Run one task, read at call time. Routed back through the instance even
   * though the implementation lives in task-runner.ts beside its only caller,
   * because cms-worker.test.ts REPLACES this method on the instance:
   * `executeTaskWithTimeout` must call `ctx.executeTask(...)`, never the
   * module-level function, which would silently bypass the stub.
   */
  executeTask(task: Task, signal: AbortSignal): Promise<Record<string, unknown>>
  /**
   * Push a branch from remote.git to GitHub, read at call time. Routed through
   * the instance for the same reason as `executeTask`: cms-worker.test.ts
   * replaces it with a spy and asserts the spy was NOT called on the
   * base-branch-refusal path. `signal` kills the push's git process when it
   * aborts (simple-git's `abort` option).
   */
  pushBranchToGitHub(branch: string, signal?: AbortSignal): Promise<void>
  /** Whether the worker is running; both poll loops bail when false. */
  isRunning(): boolean
  /**
   * Whether `stop()` has been called. Every loop checks it at its boundaries
   * (before a claim, a sync stage, a branch rebase), never mid-step. Distinct
   * from `!isRunning()`, which is also true of a worker never started, as the
   * test entry points drive it.
   */
  isDraining(): boolean
  /**
   * Aborts when a draining `stop()` reaches its deadline: in-flight work that
   * observes it is cut off so the worker can exit. See `CmsWorker.stop`.
   */
  shutdownSignal(): AbortSignal
  /** The worker's self-reported status object, lazily initialized. */
  ensureStatusReport(): WorkerStatusReport
  /** This deployment's own settings branch name. Throws on an invalid name. */
  ensureSettingsBranch(): string
  /**
   * Test hook: fires when the rebase has reported conflicted files and is about
   * to `checkout --theirs` them. No-op in production.
   */
  afterConflictDetectedForTesting(): Promise<void>
  /**
   * Test hook: fires after the rebase round loop completes, deliberately
   * OUTSIDE its try/catch so a throwing hook can never be misread as a rebase
   * error. No-op in production.
   */
  afterRebaseCompletedForTesting(): Promise<void>
}
